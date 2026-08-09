import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import multer from 'multer';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { z, ZodError } from 'zod';
import { db, one, many, assertDatabaseConfigured } from './api/db.js';
import { verifyPiAccessToken, approvePiPayment, completePiPayment, getPiPayment } from './api/pi.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '2mb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 3, fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('نوع الصورة غير مدعوم. استخدم JPG أو PNG أو WebP فقط.'), ok);
  }
});

let piMarketCache = { price: null, at: 0 };
async function getPiUsdRate() {
  const now = Date.now();
  if (piMarketCache.price && now - piMarketCache.at < 30_000) return piMarketCache.price;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetch('https://www.okx.com/api/v5/market/ticker?instId=PI-USDT', { signal: controller.signal, headers: { 'User-Agent': 'DealWay/1.2' } });
    if (!r.ok) throw new Error(`OKX HTTP ${r.status}`);
    const body = await r.json();
    const price = Number(body?.data?.[0]?.last);
    if (!Number.isFinite(price) || price <= 0) throw new Error('OKX returned an invalid PI-USDT price');
    piMarketCache = { price, at: now };
    return price;
  } finally { clearTimeout(timer); }
}
function withLivePiPrice(row, rate) {
  if (!row || !rate || !Number(row.price_usd)) return row;
  return { ...row, price_pi: Number((Number(row.price_usd) / rate).toFixed(6)), pi_usd_rate: rate };
}


// Optional CORS for a separate frontend. Same-origin Vercel deployments need no CORS headers.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = String(process.env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function tokenFor(user) {
  if (isProduction && !process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.sign({ id: user.id, role: user.role, pi_uid: user.pi_uid }, JWT_SECRET, { expiresIn: '30d' });
}
function auth(req, res, next) {
  try {
    const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!raw) return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً', code: 'AUTH_REQUIRED' });
    req.user = jwt.verify(raw, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'جلسة الدخول غير صالحة أو منتهية', code: 'INVALID_SESSION' });
  }
}
function admin(req, res, next) {
  return ['admin', 'super_admin', 'moderator'].includes(req.user?.role)
    ? next()
    : res.status(403).json({ error: 'غير مصرح', code: 'FORBIDDEN' });
}
function statusForError(e) {
  if (e instanceof ZodError) return 422;
  if (e?.code === 'PGRST116') return 404;
  if (String(e?.message || '').toLowerCase().includes('forbidden')) return 403;
  if (String(e?.message || '').toLowerCase().includes('unauthorized')) return 401;
  return 500;
}
const safe = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    console.error(`[${req.method} ${req.path}]`, e);
    const status = statusForError(e);
    res.status(status).json({
      error: e instanceof ZodError ? 'بيانات الطلب غير صحيحة' : (e?.message || 'حدث خطأ في الخادم'),
      code: e?.code || 'SERVER_ERROR',
      ...(isProduction ? {} : { details: e?.details || e?.issues || null })
    });
  }
};

async function attachListingRelations(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return rows;
  const sellerIds = [...new Set(list.map(x => x.seller_id).filter(Boolean))];
  const categoryIds = [...new Set(list.map(x => x.category_id).filter(Boolean))];
  const [profilesResult, categoriesResult] = await Promise.all([
    sellerIds.length ? db.from('profiles').select('id,display_name,avatar_url,rating,is_verified,seller_type,pi_username').in('id', sellerIds) : Promise.resolve({ data: [], error: null }),
    categoryIds.length ? db.from('categories').select('id,name,slug,icon').in('id', categoryIds) : Promise.resolve({ data: [], error: null })
  ]);
  if (profilesResult.error) throw profilesResult.error;
  if (categoriesResult.error) throw categoriesResult.error;
  const p = new Map((profilesResult.data || []).map(x => [x.id, x]));
  const c = new Map((categoriesResult.data || []).map(x => [x.id, x]));
  const hydrated = list.map(x => ({ ...x, profiles: p.get(x.seller_id) || null, categories: c.get(x.category_id) || null }));
  return Array.isArray(rows) ? hydrated : hydrated[0];
}

app.get('/health', safe(async (_req, res) => {
  assertDatabaseConfigured();
  const { error } = await db.from('categories').select('id', { head: true, count: 'exact' });
  if (error) throw error;
  res.json({ ok: true, app: 'DealWay', runtime: process.env.VERCEL ? 'vercel' : 'node', database: 'ok' });
}));
app.get('/api/health', safe(async (_req, res) => {
  assertDatabaseConfigured();
  const checks = await Promise.all(['profiles','categories','listings','site_settings'].map(async table => {
    const { error } = await db.from(table).select('*', { head: true, count: 'exact' });
    return { table, ok: !error, error: error?.message || null };
  }));
  res.json({ ok: checks.every(x => x.ok), runtime: process.env.VERCEL ? 'vercel' : 'node', checks });
}));
app.get('/api/config', (_req, res) => res.json({
  piSandbox: String(process.env.PI_SANDBOX || 'false').toLowerCase() === 'true'
}));

app.get('/api/market/pi-price', safe(async (_req, res) => {
  const price = await getPiUsdRate();
  res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=40');
  res.json({ pair: 'PI-USDT', source: 'OKX', price_usd: price, fetched_at: new Date().toISOString() });
}));

app.post('/api/uploads/listing-images', auth, upload.array('images', 3), safe(async (req, res) => {
  assertDatabaseConfigured();
  const files = req.files || [];
  if (files.length < 1 || files.length > 3) return res.status(422).json({ error: 'يجب رفع صورة واحدة على الأقل وبحد أقصى 3 صور', code: 'IMAGE_COUNT' });
  const urls = [];
  for (const file of files) {
    const ext = file.mimetype === 'image/webp' ? 'webp' : file.mimetype === 'image/png' ? 'png' : 'jpg';
    const name = `${req.user.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
    const { error } = await db.storage.from('listing-images').upload(name, file.buffer, { contentType: file.mimetype, cacheControl: '31536000', upsert: false });
    if (error) throw error;
    const { data } = db.storage.from('listing-images').getPublicUrl(name);
    urls.push(data.publicUrl);
  }
  res.status(201).json({ urls });
}));

app.post('/api/auth/pi', safe(async (req, res) => {
  assertDatabaseConfigured();
  const accessToken = String(req.body?.accessToken || '');
  const piMe = await verifyPiAccessToken(accessToken);
  const piUid = piMe.uid || piMe.user?.uid;
  const username = piMe.username || piMe.user?.username || 'Pioneer';
  if (!piUid) throw new Error('تعذر التحقق من هوية Pi');
  let { data: user, error } = await db.from('profiles').select('*').eq('pi_uid', piUid).maybeSingle();
  if (error) throw error;
  if (!user) user = await one(db.from('profiles').insert({ pi_uid: piUid, pi_username: username, display_name: username }).select('*'));
  else if (username && user.pi_username !== username) user = await one(db.from('profiles').update({ pi_username: username, display_name: user.display_name || username }).eq('id', user.id).select('*'));
  res.json({ token: tokenFor(user), user });
}));
app.get('/api/me', auth, safe(async (req, res) => res.json({ user: await one(db.from('profiles').select('*').eq('id', req.user.id)) })));
app.patch('/api/me', auth, safe(async (req, res) => {
  const allowed = ['display_name','avatar_url','country','city']; const patch = {};
  for (const k of allowed) if (req.body[k] !== undefined) patch[k] = req.body[k];
  res.json({ user: await one(db.from('profiles').update(patch).eq('id', req.user.id).select('*')) });
}));

app.get('/api/categories', safe(async (_req, res) => {
  const out = await many(db.from('categories').select('*').eq('is_active', true).order('sort_order'));
  res.json(out.data);
}));
app.get('/api/settings', safe(async (_req, res) => {
  const { data, error } = await db.from('site_settings').select('key,value'); if (error) throw error;
  res.json(Object.fromEntries((data || []).map(x => [x.key, x.value])));
}));

app.get('/api/listings', safe(async (req, res) => {
  const { q='', category='', city='', condition='', min='', max='', sort='newest', page='0', limit='24' } = req.query;
  const pageNum = Math.max(0, Number(page) || 0), limitNum = Math.min(48, Math.max(1, Number(limit) || 24));
  let query = db.from('listings').select('*', { count: 'exact' }).eq('status', 'active');
  if (q) query = query.ilike('title', `%${String(q).replace(/[%_]/g, '')}%`);
  if (category) query = query.eq('category_id', category);
  if (city) query = query.ilike('city', `%${String(city).replace(/[%_]/g, '')}%`);
  if (condition) query = query.eq('condition', condition);
  if (min !== '' && Number.isFinite(Number(min))) query = query.gte('price_usd', Number(min));
  if (max !== '' && Number.isFinite(Number(max))) query = query.lte('price_usd', Number(max));
  if (sort === 'price_asc') query = query.order('price_usd', { ascending: true });
  else if (sort === 'price_desc') query = query.order('price_usd', { ascending: false });
  else if (sort === 'views') query = query.order('views', { ascending: false });
  else query = query.order('featured_until', { ascending: false, nullsFirst: false }).order('bumped_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false });
  const from = pageNum * limitNum;
  const out = await many(query.range(from, from + limitNum - 1));
  out.data = await attachListingRelations(out.data);
  try { const rate = await getPiUsdRate(); out.data = out.data.map(row => withLivePiPrice(row, rate)); } catch (e) { console.warn('[OKX price]', e.message); }
  res.json(out);
}));
app.get('/api/listings/:id', safe(async (req, res) => {
  db.rpc('increment_listing_views', { listing_id: req.params.id }).then(() => {}).catch(() => {});
  const item = await one(db.from('listings').select('*').eq('id', req.params.id));
  let hydrated = await attachListingRelations(item);
  try { hydrated = withLivePiPrice(hydrated, await getPiUsdRate()); } catch (e) { console.warn('[OKX price]', e.message); }
  res.json({ data: hydrated });
}));
app.post('/api/listings', auth, safe(async (req, res) => {
  const S = z.object({ title:z.string().min(3).max(120), description:z.string().min(10).max(5000), category_id:z.string().uuid(), condition:z.enum(['new','like_new','used']), price_usd:z.coerce.number().positive().max(100000000), negotiable:z.boolean().default(false), image_urls:z.array(z.string().url()).min(1).max(3), country:z.string().max(100).optional(), city:z.string().max(100).optional(), area:z.string().max(150).optional(), delivery_available:z.boolean().default(false) });
  const v = S.parse(req.body);
  const rate = await getPiUsdRate();
  const price_pi = Number((v.price_usd / rate).toFixed(6));
  const data = await one(db.from('listings').insert({ ...v, price_pi, pi_usd_rate: rate, seller_id:req.user.id }).select('*'));
  res.status(201).json({ data });
}));
app.patch('/api/listings/:id', auth, safe(async (req, res) => {
  const allowed = ['title','description','category_id','condition','price_usd','negotiable','image_urls','country','city','area','delivery_available','status']; const patch = {};
  for (const k of allowed) if (req.body[k] !== undefined) patch[k] = req.body[k];
  if (patch.image_urls && (!Array.isArray(patch.image_urls) || patch.image_urls.length < 1 || patch.image_urls.length > 3)) return res.status(422).json({ error:'يجب أن يحتوي الإعلان على صورة واحدة إلى 3 صور', code:'IMAGE_COUNT' });
  if (patch.price_usd !== undefined) { const usd=Number(patch.price_usd); if(!Number.isFinite(usd)||usd<=0) return res.status(422).json({error:'سعر الدولار غير صحيح',code:'PRICE_USD'}); const rate=await getPiUsdRate(); patch.price_usd=usd; patch.price_pi=Number((usd/rate).toFixed(6)); patch.pi_usd_rate=rate; }
  res.json({ data: await one(db.from('listings').update(patch).eq('id', req.params.id).eq('seller_id', req.user.id).select('*')) });
}));
app.delete('/api/listings/:id', auth, safe(async (req, res) => { const { error } = await db.from('listings').update({ status:'deleted' }).eq('id', req.params.id).eq('seller_id', req.user.id); if (error) throw error; res.json({ ok:true }); }));
app.get('/api/my-listings', auth, safe(async (req, res) => { const rows=(await many(db.from('listings').select('*').eq('seller_id', req.user.id).order('created_at', { ascending:false }))).data; try { const rate=await getPiUsdRate(); return res.json(rows.map(x=>withLivePiPrice(x,rate))); } catch { return res.json(rows); } }));

app.get('/api/favorites', auth, safe(async (req, res) => {
  const favs = (await many(db.from('favorites').select('listing_id').eq('user_id', req.user.id))).data;
  const ids = favs.map(x => x.listing_id); if (!ids.length) return res.json([]);
  const listings = await many(db.from('listings').select('*').in('id', ids)); const hydrated = await attachListingRelations(listings.data);
  res.json(hydrated.map(x => ({ listing_id:x.id, listings:x })));
}));
app.post('/api/favorites/:id', auth, safe(async (req, res) => { const { error } = await db.from('favorites').upsert({ user_id:req.user.id, listing_id:req.params.id }); if (error) throw error; res.json({ok:true}); }));
app.delete('/api/favorites/:id', auth, safe(async (req, res) => { const { error } = await db.from('favorites').delete().eq('user_id', req.user.id).eq('listing_id', req.params.id); if (error) throw error; res.json({ok:true}); }));

app.post('/api/chats', auth, safe(async (req, res) => {
  const listing = await one(db.from('listings').select('seller_id').eq('id', req.body.listing_id)); if (listing.seller_id === req.user.id) throw new Error('لا يمكنك مراسلة نفسك');
  let { data:chat, error } = await db.from('chats').select('*').eq('listing_id', req.body.listing_id).eq('buyer_id', req.user.id).eq('seller_id', listing.seller_id).maybeSingle(); if (error) throw error;
  if (!chat) chat = await one(db.from('chats').insert({ listing_id:req.body.listing_id, buyer_id:req.user.id, seller_id:listing.seller_id }).select('*'));
  res.json({ data:chat });
}));
app.get('/api/chats', auth, safe(async (req, res) => {
  const chats = (await many(db.from('chats').select('*').or(`buyer_id.eq.${req.user.id},seller_id.eq.${req.user.id}`).order('updated_at',{ascending:false}))).data;
  if (!chats.length) return res.json([]);
  const listingIds = [...new Set(chats.map(x=>x.listing_id))];
  const listingRows = (await many(db.from('listings').select('id,title,image_urls,price_pi').in('id', listingIds))).data;
  const listingMap = new Map(listingRows.map(x=>[x.id,x]));
  const chatIds = chats.map(x=>x.id); const messages = (await many(db.from('messages').select('chat_id,body,created_at').in('chat_id', chatIds).order('created_at',{ascending:true}))).data;
  const last = new Map(); for (const m of messages) last.set(m.chat_id,m);
  res.json(chats.map(c=>({ ...c, listings:listingMap.get(c.listing_id)||null, messages:last.has(c.id)?[last.get(c.id)]:[] })));
}));
app.get('/api/chats/:id/messages', auth, safe(async (req, res) => {
  const chat = await one(db.from('chats').select('*').eq('id',req.params.id)); if (![chat.buyer_id,chat.seller_id].includes(req.user.id)) throw new Error('Forbidden');
  const msgs = (await many(db.from('messages').select('*').eq('chat_id',req.params.id).order('created_at'))).data;
  const senderIds=[...new Set(msgs.map(x=>x.sender_id))]; const senders=senderIds.length?(await many(db.from('profiles').select('id,display_name,avatar_url').in('id',senderIds))).data:[]; const sm=new Map(senders.map(x=>[x.id,x]));
  res.json(msgs.map(m=>({...m,profiles:sm.get(m.sender_id)||null})));
}));
app.post('/api/chats/:id/messages', auth, safe(async (req, res) => {
  const body=String(req.body.body||'').trim(); if(!body || body.length>2000) throw new Error('الرسالة غير صالحة');
  const chat=await one(db.from('chats').select('*').eq('id',req.params.id)); if(![chat.buyer_id,chat.seller_id].includes(req.user.id)) throw new Error('Forbidden');
  const msg=await one(db.from('messages').insert({chat_id:req.params.id,sender_id:req.user.id,body}).select('*')); await db.from('chats').update({updated_at:new Date().toISOString()}).eq('id',req.params.id); res.status(201).json({data:msg});
}));

app.post('/api/offers', auth, safe(async(req,res)=>{ const l=await one(db.from('listings').select('seller_id').eq('id',req.body.listing_id)); if(l.seller_id===req.user.id) throw new Error('لا يمكنك تقديم عرض على إعلانك'); const amount=Number(req.body.amount_pi); if(!Number.isFinite(amount)||amount<=0) throw new Error('قيمة العرض غير صحيحة'); const data=await one(db.from('offers').insert({listing_id:req.body.listing_id,buyer_id:req.user.id,seller_id:l.seller_id,amount_pi:amount}).select('*')); res.status(201).json({data}); }));
app.patch('/api/offers/:id', auth, safe(async(req,res)=>{ const status=req.body.status; if(!['accepted','rejected','countered','cancelled'].includes(status)) throw new Error('Invalid status'); const offer=await one(db.from('offers').select('*').eq('id',req.params.id)); if(![offer.buyer_id,offer.seller_id].includes(req.user.id)) throw new Error('Forbidden'); res.json({data:await one(db.from('offers').update({status,amount_pi:req.body.amount_pi??offer.amount_pi}).eq('id',offer.id).select('*'))}); }));
app.post('/api/reports', auth, safe(async(req,res)=>{ const data=await one(db.from('reports').insert({listing_id:req.body.listing_id,reporter_id:req.user.id,reason:String(req.body.reason||'Other').slice(0,100),details:req.body.details?String(req.body.details).slice(0,2000):null}).select('*')); res.status(201).json({data}); }));
app.post('/api/reviews', auth, safe(async(req,res)=>{ const rating=Number(req.body.rating); if(!Number.isInteger(rating)||rating<1||rating>5) throw new Error('التقييم يجب أن يكون من 1 إلى 5'); const data=await one(db.from('reviews').insert({reviewer_id:req.user.id,reviewed_user_id:req.body.reviewed_user_id,listing_id:req.body.listing_id||null,rating,comment:req.body.comment||null}).select('*')); res.status(201).json({data}); }));

const PROMOTION_SERVICES = new Set(['boost_1d','boost_3d','featured_7d','urgent']);
async function promotionPrice(service){ if(!PROMOTION_SERVICES.has(service)) throw new Error('Invalid promotion service'); const {data,error}=await db.from('site_settings').select('value').eq('key','promotion_prices').maybeSingle(); if(error) throw error; const amount=Number(data?.value?.[service]); if(!Number.isFinite(amount)||amount<=0) throw new Error('Promotion price is not configured'); return amount; }
async function currentUser(id){ return one(db.from('profiles').select('id,pi_uid').eq('id',id)); }
async function validatePromotionPayment(payment,userToken){ const user=await currentUser(userToken.id); if(!payment?.identifier) throw new Error('Invalid Pi payment'); if(payment.user_uid!==user.pi_uid) throw new Error('Payment user mismatch'); if(payment.direction&&payment.direction!=='user_to_app') throw new Error('Invalid payment direction'); const service=String(payment.metadata?.service||''), listingId=String(payment.metadata?.listingId||''); if(!listingId||!PROMOTION_SERVICES.has(service)) throw new Error('Invalid payment metadata'); const listing=await one(db.from('listings').select('id,seller_id').eq('id',listingId)); if(listing.seller_id!==user.id) throw new Error('You can only promote your own listing'); const amount=await promotionPrice(service); if(Math.abs(Number(payment.amount)-amount)>1e-8) throw new Error('Payment amount mismatch'); return {service,listingId,amount,user}; }
async function activatePromotion(paymentId,txid,userToken){ const payment=await getPiPayment(paymentId); const info=await validatePromotionPayment(payment,userToken); const complete=payment.status?.developer_completed?payment:await completePiPayment(paymentId,txid); const p=await one(db.from('payments').upsert({user_id:info.user.id,listing_id:info.listingId,service:info.service,amount_pi:info.amount,pi_payment_id:paymentId,txid,status:'completed',completed_at:new Date().toISOString()},{onConflict:'pi_payment_id'}).select('*')); const patch={bumped_at:new Date().toISOString()}; if(p.service==='featured_7d')patch.featured_until=new Date(Date.now()+7*86400000).toISOString(); if(p.service==='urgent')patch.urgent_until=new Date(Date.now()+7*86400000).toISOString(); await db.from('listings').update(patch).eq('id',p.listing_id).eq('seller_id',info.user.id); return complete; }
app.post('/api/payments/approve',auth,safe(async(req,res)=>{const paymentId=String(req.body.paymentId||'');if(!paymentId)throw new Error('Payment id is required');const payment=await getPiPayment(paymentId);const info=await validatePromotionPayment(payment,req.user);if(!payment.status?.developer_approved)await approvePiPayment(paymentId);await db.from('payments').upsert({user_id:info.user.id,listing_id:info.listingId,service:info.service,amount_pi:info.amount,pi_payment_id:paymentId,status:'approved'},{onConflict:'pi_payment_id'});res.json({ok:true});}));
app.post('/api/payments/complete',auth,safe(async(req,res)=>{const paymentId=String(req.body.paymentId||''),txid=String(req.body.txid||'');if(!paymentId||!txid)throw new Error('Payment id and txid are required');res.json({ok:true,complete:await activatePromotion(paymentId,txid,req.user)});}));
app.post('/api/payments/reconcile',auth,safe(async(req,res)=>{const paymentId=String(req.body.paymentId||'');if(!paymentId)throw new Error('Payment id is required');const payment=await getPiPayment(paymentId);await validatePromotionPayment(payment,req.user);if(payment.status?.developer_completed)return res.json({ok:true,alreadyCompleted:true});const txid=payment.transaction?.txid;if(!txid||!payment.status?.transaction_verified)throw new Error('Payment transaction is not ready for completion');res.json({ok:true,complete:await activatePromotion(paymentId,txid,req.user)});}));

app.get('/api/admin/stats',auth,admin,safe(async(_req,res)=>{const [u,l,r,p]=await Promise.all([db.from('profiles').select('*',{count:'exact',head:true}),db.from('listings').select('*',{count:'exact',head:true}),db.from('reports').select('*',{count:'exact',head:true}).eq('status','open'),db.from('payments').select('amount_pi').eq('status','completed')]);for(const x of [u,l,r,p])if(x.error)throw x.error;res.json({users:u.count||0,listings:l.count||0,openReports:r.count||0,revenuePi:(p.data||[]).reduce((s,x)=>s+Number(x.amount_pi||0),0)});}));
app.get('/api/admin/reports',auth,admin,safe(async(_req,res)=>res.json((await many(db.from('reports').select('*').order('created_at',{ascending:false}))).data)));
app.patch('/api/admin/reports/:id',auth,admin,safe(async(req,res)=>res.json({data:await one(db.from('reports').update({status:req.body.status}).eq('id',req.params.id).select('*'))})));

app.use('/api', (_req,res)=>res.status(404).json({error:'API route not found',code:'NOT_FOUND'}));
app.get('/validation-key.txt', (_req,res)=>res.sendFile(path.join(__dirname,'validation-key.txt')));
app.get('/', (_req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.use((req,res,next)=>{ if(req.method==='GET' && req.accepts('html')) return res.sendFile(path.join(__dirname,'index.html')); next(); });
app.use((err, req, res, _next) => {
  console.error(`[${req.method} ${req.path}]`, err);
  const isMulter = err?.name === 'MulterError';
  res.status(isMulter ? 422 : 500).json({ error: isMulter ? 'تعذر رفع الصور: تحقق من العدد والحجم' : (err?.message || 'حدث خطأ في الخادم'), code: err?.code || 'SERVER_ERROR' });
});

export default app;
