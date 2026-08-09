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


const LISTING_TTL_DAYS = Math.max(7, Math.min(365, Number(process.env.LISTING_TTL_DAYS || 60)));
function plusDays(days, from = new Date()) { const d = new Date(from); d.setUTCDate(d.getUTCDate() + days); return d.toISOString(); }
async function notify(userId, type, title, body = '', link = null) {
  if (!userId) return;
  const { error } = await db.from('notifications').insert({ user_id:userId, type, title, body, link });
  if (error) console.warn('[notification]', error.message);
}
async function isBlocked(a, b) {
  if (!a || !b) return false;
  const { data, error } = await db.from('blocked_users').select('blocker_id').or(`and(blocker_id.eq.${a},blocked_id.eq.${b}),and(blocker_id.eq.${b},blocked_id.eq.${a})`).limit(1);
  if (error) throw error;
  return Boolean(data?.length);
}
async function recordUniqueListingView(req, listingId) {
  try {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const ua = String(req.headers['user-agent'] || '').slice(0,300);
    const day = new Date().toISOString().slice(0,10);
    const secret = process.env.VIEW_HASH_SECRET || process.env.JWT_SECRET || 'dealway-view';
    const viewerHash = crypto.createHash('sha256').update(`${secret}|${listingId}|${ip}|${ua}|${day}`).digest('hex');
    const { error } = await db.from('listing_views').insert({ listing_id:listingId, viewer_hash:viewerHash });
    if (!error) await db.rpc('increment_listing_views', { listing_id: listingId });
    else if (error.code !== '23505') console.warn('[listing view]', error.message);
  } catch (e) { console.warn('[listing view]', e.message); }
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
    sellerIds.length ? db.from('profiles').select('id,display_name,avatar_url,rating,is_verified,seller_type,pi_username,completed_deals').in('id', sellerIds) : Promise.resolve({ data: [], error: null }),
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
  const checks = await Promise.all(['profiles','categories','listings','site_settings','notifications','saved_searches','blocked_users','verification_requests','listing_views'].map(async table => {
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
  const { q='', category='', city='', condition='', min='', max='', sort='newest', negotiable='', delivery='', seller='', page='0', limit='24' } = req.query;
  const pageNum = Math.max(0, Number(page) || 0), limitNum = Math.min(48, Math.max(1, Number(limit) || 24));
  let query = db.from('listings').select('*', { count: 'exact' }).in('status', ['active','reserved']).or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
  if (q) query = query.ilike('title', `%${String(q).replace(/[%_]/g, '')}%`);
  if (category) query = query.eq('category_id', category);
  if (city) query = query.ilike('city', `%${String(city).replace(/[%_]/g, '')}%`);
  if (condition) query = query.eq('condition', condition);
  if (negotiable === 'true') query = query.eq('negotiable', true);
  if (delivery === 'true') query = query.eq('delivery_available', true);
  if (seller) query = query.eq('seller_id', seller);
  if (min !== '' && Number.isFinite(Number(min))) query = query.gte('price_usd', Number(min));
  if (max !== '' && Number.isFinite(Number(max))) query = query.lte('price_usd', Number(max));
  if (sort === 'price_asc') query = query.order('price_usd', { ascending: true });
  else if (sort === 'price_desc') query = query.order('price_usd', { ascending: false });
  else if (sort === 'views') query = query.order('views', { ascending: false });
  else query = query.order('featured_until', { ascending: false, nullsFirst: false }).order('urgent_until', { ascending: false, nullsFirst: false }).order('promoted_until', { ascending: false, nullsFirst: false }).order('bumped_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false });
  const from = pageNum * limitNum;
  const out = await many(query.range(from, from + limitNum - 1));
  out.data = await attachListingRelations(out.data);
  try { const rate = await getPiUsdRate(); out.data = out.data.map(row => withLivePiPrice(row, rate)); } catch (e) { console.warn('[OKX price]', e.message); }
  res.json(out);
}));
app.get('/api/listings/:id', safe(async (req, res) => {
  recordUniqueListingView(req, req.params.id);
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
  const data = await one(db.from('listings').insert({ ...v, price_pi, pi_usd_rate: rate, seller_id:req.user.id, expires_at:plusDays(LISTING_TTL_DAYS) }).select('*'));
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


// Marketplace quality-of-life features
app.get('/api/listings/:id/similar', safe(async (req,res) => {
  const base = await one(db.from('listings').select('id,category_id,price_usd').eq('id',req.params.id));
  const low = Math.max(0, Number(base.price_usd||0)*0.6), high = Math.max(low+1, Number(base.price_usd||0)*1.4);
  let q = db.from('listings').select('*').in('status',['active','reserved']).eq('category_id',base.category_id).neq('id',base.id).gte('price_usd',low).lte('price_usd',high).limit(6).order('featured_until',{ascending:false,nullsFirst:false}).order('created_at',{ascending:false});
  const rows=(await many(q)).data; let out=await attachListingRelations(rows); try{const rate=await getPiUsdRate();out=out.map(x=>withLivePiPrice(x,rate))}catch{} res.json(out);
}));
app.post('/api/listings/:id/renew', auth, safe(async(req,res)=>{
  const listing=await one(db.from('listings').select('id,seller_id,status,expires_at').eq('id',req.params.id));
  if(listing.seller_id!==req.user.id) throw new Error('Forbidden');
  const base = listing.expires_at && new Date(listing.expires_at)>new Date() ? new Date(listing.expires_at) : new Date();
  const data=await one(db.from('listings').update({expires_at:plusDays(LISTING_TTL_DAYS,base),status:listing.status==='inactive'?'active':listing.status}).eq('id',listing.id).select('*'));
  res.json({data});
}));
app.patch('/api/listings/:id/state', auth, safe(async(req,res)=>{
  const status=String(req.body.status||''); if(!['active','reserved','sold','inactive'].includes(status)) return res.status(422).json({error:'حالة الإعلان غير صحيحة'});
  const listing=await one(db.from('listings').select('id,seller_id,status').eq('id',req.params.id)); if(listing.seller_id!==req.user.id) throw new Error('Forbidden');
  const data=await one(db.from('listings').update({status}).eq('id',listing.id).select('*'));
  if(status==='sold' && listing.status!=='sold') { const {data:p}=await db.from('profiles').select('completed_deals').eq('id',req.user.id).maybeSingle(); if(p) await db.from('profiles').update({completed_deals:Number(p.completed_deals||0)+1}).eq('id',req.user.id); }
  res.json({data});
}));
app.get('/api/seller/dashboard', auth, safe(async(req,res)=>{
  const listings=(await many(db.from('listings').select('id,title,status,views,featured_until,urgent_until,promoted_until,expires_at,created_at').eq('seller_id',req.user.id).order('created_at',{ascending:false}))).data;
  const ids=listings.map(x=>x.id); let favs=[], chats=[];
  if(ids.length){ favs=(await many(db.from('favorites').select('listing_id').in('listing_id',ids))).data; chats=(await many(db.from('chats').select('listing_id').in('listing_id',ids))).data; }
  const fc={},cc={}; for(const x of favs)fc[x.listing_id]=(fc[x.listing_id]||0)+1; for(const x of chats)cc[x.listing_id]=(cc[x.listing_id]||0)+1;
  const data=listings.map(x=>({...x,favorites:fc[x.id]||0,chats:cc[x.id]||0}));
  res.json({totals:{listings:listings.length,views:listings.reduce((a,x)=>a+Number(x.views||0),0),favorites:favs.length,chats:chats.length},listings:data});
}));
app.get('/api/payments', auth, safe(async(req,res)=>res.json((await many(db.from('payments').select('*').eq('user_id',req.user.id).order('created_at',{ascending:false}).limit(100))).data)));
app.get('/api/offers', auth, safe(async(req,res)=>{
  const rows=(await many(db.from('offers').select('*').or(`buyer_id.eq.${req.user.id},seller_id.eq.${req.user.id}`).order('created_at',{ascending:false}))).data;
  const lids=[...new Set(rows.map(x=>x.listing_id))]; const ls=lids.length?(await many(db.from('listings').select('id,title,image_urls,price_pi,price_usd').in('id',lids))).data:[]; const lm=new Map(ls.map(x=>[x.id,x]));
  res.json(rows.map(x=>({...x,listings:lm.get(x.listing_id)||null})));
}));
app.get('/api/notifications', auth, safe(async(req,res)=>res.json((await many(db.from('notifications').select('*').eq('user_id',req.user.id).order('created_at',{ascending:false}).limit(100))).data)));
app.patch('/api/notifications/:id/read', auth, safe(async(req,res)=>{const {error}=await db.from('notifications').update({read_at:new Date().toISOString()}).eq('id',req.params.id).eq('user_id',req.user.id);if(error)throw error;res.json({ok:true})}));
app.patch('/api/notifications/read-all', auth, safe(async(req,res)=>{const {error}=await db.from('notifications').update({read_at:new Date().toISOString()}).eq('user_id',req.user.id).is('read_at',null);if(error)throw error;res.json({ok:true})}));
app.get('/api/saved-searches', auth, safe(async(req,res)=>res.json((await many(db.from('saved_searches').select('*').eq('user_id',req.user.id).order('created_at',{ascending:false}))).data)));
app.post('/api/saved-searches', auth, safe(async(req,res)=>{
  const name=String(req.body.name||'بحث محفوظ').slice(0,80), filters=req.body.filters&&typeof req.body.filters==='object'?req.body.filters:{};
  const data=await one(db.from('saved_searches').insert({user_id:req.user.id,name,filters,alert_enabled:req.body.alert_enabled!==false}).select('*'));res.status(201).json({data});
}));
app.delete('/api/saved-searches/:id', auth, safe(async(req,res)=>{const {error}=await db.from('saved_searches').delete().eq('id',req.params.id).eq('user_id',req.user.id);if(error)throw error;res.json({ok:true})}));
app.get('/api/saved-searches/:id/matches', auth, safe(async(req,res)=>{
  const ss=await one(db.from('saved_searches').select('*').eq('id',req.params.id).eq('user_id',req.user.id)); const f=ss.filters||{};
  let q=db.from('listings').select('*').in('status',['active','reserved']).order('created_at',{ascending:false}).limit(20);
  if(f.q)q=q.ilike('title',`%${String(f.q).replace(/[%_]/g,'')}%`); if(f.category)q=q.eq('category_id',f.category); if(f.city)q=q.ilike('city',`%${String(f.city).replace(/[%_]/g,'')}%`); if(f.condition)q=q.eq('condition',f.condition); if(Number(f.min))q=q.gte('price_usd',Number(f.min)); if(Number(f.max))q=q.lte('price_usd',Number(f.max)); if(f.negotiable==='true')q=q.eq('negotiable',true); if(f.delivery==='true')q=q.eq('delivery_available',true);
  let rows=(await many(q)).data; rows=await attachListingRelations(rows); try{const rate=await getPiUsdRate();rows=rows.map(x=>withLivePiPrice(x,rate))}catch{} res.json(rows);
}));
app.post('/api/alerts/check', auth, safe(async(req,res)=>{
  const searches=(await many(db.from('saved_searches').select('*').eq('user_id',req.user.id).eq('alert_enabled',true))).data;
  let total=0;
  for(const ss of searches){
    const f=ss.filters||{}; const since=ss.last_checked_at||ss.created_at||new Date(Date.now()-86400000).toISOString();
    let q=db.from('listings').select('id',{count:'exact',head:true}).in('status',['active','reserved']).gt('created_at',since);
    if(f.q)q=q.ilike('title',`%${String(f.q).replace(/[%_]/g,'')}%`); if(f.category)q=q.eq('category_id',f.category); if(f.city)q=q.ilike('city',`%${String(f.city).replace(/[%_]/g,'')}%`); if(f.condition)q=q.eq('condition',f.condition); if(Number(f.min))q=q.gte('price_usd',Number(f.min)); if(Number(f.max))q=q.lte('price_usd',Number(f.max)); if(f.negotiable==='true')q=q.eq('negotiable',true); if(f.delivery==='true')q=q.eq('delivery_available',true);
    const r=await q; if(r.error)throw r.error; const count=r.count||0; total+=count;
    if(count>0) await notify(req.user.id,'search_alert',`نتائج جديدة: ${ss.name}`,`${count} إعلان جديد يطابق بحثك.`,`saved-search:${ss.id}`);
    await db.from('saved_searches').update({last_checked_at:new Date().toISOString()}).eq('id',ss.id).eq('user_id',req.user.id);
  }
  res.json({ok:true,matches:total});
}));
app.get('/api/blocks', auth, safe(async(req,res)=>{
  const rows=(await many(db.from('blocked_users').select('blocked_id,created_at').eq('blocker_id',req.user.id).order('created_at',{ascending:false}))).data; const ids=rows.map(x=>x.blocked_id); const ps=ids.length?(await many(db.from('profiles').select('id,display_name,pi_username,avatar_url').in('id',ids))).data:[]; const pm=new Map(ps.map(x=>[x.id,x]));res.json(rows.map(x=>({...x,profiles:pm.get(x.blocked_id)||null})));
}));
app.post('/api/blocks/:userId', auth, safe(async(req,res)=>{if(req.params.userId===req.user.id)throw new Error('لا يمكنك حظر نفسك');const {error}=await db.from('blocked_users').upsert({blocker_id:req.user.id,blocked_id:req.params.userId});if(error)throw error;res.json({ok:true})}));
app.delete('/api/blocks/:userId', auth, safe(async(req,res)=>{const {error}=await db.from('blocked_users').delete().eq('blocker_id',req.user.id).eq('blocked_id',req.params.userId);if(error)throw error;res.json({ok:true})}));
app.get('/api/profiles/:id/reviews', safe(async(req,res)=>res.json((await many(db.from('reviews').select('*').eq('reviewed_user_id',req.params.id).order('created_at',{ascending:false}).limit(50))).data)));
app.post('/api/verification-requests', auth, safe(async(req,res)=>{
  const note=String(req.body.note||'').slice(0,1500); const data=await one(db.from('verification_requests').upsert({user_id:req.user.id,note,status:'pending',updated_at:new Date().toISOString()},{onConflict:'user_id'}).select('*')); await notify(req.user.id,'verification','تم استلام طلب التوثيق','سنراجع طلبك قريبًا.');res.status(201).json({data});
}));

app.get('/api/favorites', auth, safe(async (req, res) => {
  const favs = (await many(db.from('favorites').select('listing_id').eq('user_id', req.user.id))).data;
  const ids = favs.map(x => x.listing_id); if (!ids.length) return res.json([]);
  const listings = await many(db.from('listings').select('*').in('id', ids)); const hydrated = await attachListingRelations(listings.data);
  res.json(hydrated.map(x => ({ listing_id:x.id, listings:x })));
}));
app.post('/api/favorites/:id', auth, safe(async (req, res) => { const { error } = await db.from('favorites').upsert({ user_id:req.user.id, listing_id:req.params.id }); if (error) throw error; res.json({ok:true}); }));
app.delete('/api/favorites/:id', auth, safe(async (req, res) => { const { error } = await db.from('favorites').delete().eq('user_id', req.user.id).eq('listing_id', req.params.id); if (error) throw error; res.json({ok:true}); }));

app.post('/api/chats', auth, safe(async (req, res) => {
  const listing = await one(db.from('listings').select('seller_id').eq('id', req.body.listing_id)); if (listing.seller_id === req.user.id) throw new Error('لا يمكنك مراسلة نفسك'); if(await isBlocked(req.user.id,listing.seller_id)) throw new Error('لا يمكن بدء محادثة بين حسابين محظورين');
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
  if(await isBlocked(chat.buyer_id,chat.seller_id)) throw new Error('لا يمكن إرسال رسائل بين حسابين محظورين'); const msg=await one(db.from('messages').insert({chat_id:req.params.id,sender_id:req.user.id,body}).select('*')); await db.from('chats').update({updated_at:new Date().toISOString()}).eq('id',req.params.id); const target=chat.buyer_id===req.user.id?chat.seller_id:chat.buyer_id; await notify(target,'message','رسالة جديدة',body.slice(0,120),`chat:${chat.id}`); res.status(201).json({data:msg});
}));

app.post('/api/offers', auth, safe(async(req,res)=>{ const l=await one(db.from('listings').select('seller_id,title').eq('id',req.body.listing_id)); if(l.seller_id===req.user.id) throw new Error('لا يمكنك تقديم عرض على إعلانك'); if(await isBlocked(req.user.id,l.seller_id)) throw new Error('لا يمكن تقديم عرض لهذا المستخدم'); const amount=Number(req.body.amount_pi); if(!Number.isFinite(amount)||amount<=0) throw new Error('قيمة العرض غير صحيحة'); const data=await one(db.from('offers').insert({listing_id:req.body.listing_id,buyer_id:req.user.id,seller_id:l.seller_id,amount_pi:amount}).select('*')); await notify(l.seller_id,'offer','عرض سعر جديد',`${amount} PI على ${l.title}`,`listing:${req.body.listing_id}`); res.status(201).json({data}); }));
app.patch('/api/offers/:id', auth, safe(async(req,res)=>{ const status=req.body.status; if(!['accepted','rejected','countered','cancelled'].includes(status)) throw new Error('Invalid status'); const offer=await one(db.from('offers').select('*').eq('id',req.params.id)); if(![offer.buyer_id,offer.seller_id].includes(req.user.id)) throw new Error('Forbidden'); const data=await one(db.from('offers').update({status,amount_pi:req.body.amount_pi??offer.amount_pi}).eq('id',offer.id).select('*')); const target=req.user.id===offer.seller_id?offer.buyer_id:offer.seller_id; await notify(target,'offer_update','تحديث على عرض السعر',`الحالة: ${status}`,`listing:${offer.listing_id}`); res.json({data}); }));
app.post('/api/reports', auth, safe(async(req,res)=>{ const data=await one(db.from('reports').insert({listing_id:req.body.listing_id,reporter_id:req.user.id,reason:String(req.body.reason||'Other').slice(0,100),details:req.body.details?String(req.body.details).slice(0,2000):null}).select('*')); res.status(201).json({data}); }));
app.post('/api/reviews', auth, safe(async(req,res)=>{ const rating=Number(req.body.rating); if(!Number.isInteger(rating)||rating<1||rating>5) throw new Error('التقييم يجب أن يكون من 1 إلى 5'); const data=await one(db.from('reviews').insert({reviewer_id:req.user.id,reviewed_user_id:req.body.reviewed_user_id,listing_id:req.body.listing_id||null,rating,comment:req.body.comment||null}).select('*')); res.status(201).json({data}); }));

const PROMOTION_SERVICES = new Set(['boost_1d','boost_3d','featured_7d','urgent']);
const PROMOTION_DAYS = { boost_1d:1, boost_3d:3, featured_7d:7, urgent:3 };
function extendUntil(current, days){ const base=current&&new Date(current)>new Date()?new Date(current):new Date(); return plusDays(days,base); }
async function promotionPrice(service){ if(!PROMOTION_SERVICES.has(service)) throw new Error('Invalid promotion service'); const {data,error}=await db.from('site_settings').select('value').eq('key','promotion_prices').maybeSingle(); if(error) throw error; const amount=Number(data?.value?.[service]); if(!Number.isFinite(amount)||amount<=0) throw new Error('Promotion price is not configured'); return amount; }
async function currentUser(id){ return one(db.from('profiles').select('id,pi_uid').eq('id',id)); }
async function validatePromotionPayment(payment,userToken){ const user=await currentUser(userToken.id); if(!payment?.identifier) throw new Error('Invalid Pi payment'); if(payment.user_uid!==user.pi_uid) throw new Error('Payment user mismatch'); if(payment.direction&&payment.direction!=='user_to_app') throw new Error('Invalid payment direction'); const service=String(payment.metadata?.service||''), listingId=String(payment.metadata?.listingId||''); if(!listingId||!PROMOTION_SERVICES.has(service)) throw new Error('Invalid payment metadata'); const listing=await one(db.from('listings').select('id,seller_id').eq('id',listingId)); if(listing.seller_id!==user.id) throw new Error('You can only promote your own listing'); const amount=await promotionPrice(service); if(Math.abs(Number(payment.amount)-amount)>1e-8) throw new Error('Payment amount mismatch'); return {service,listingId,amount,user}; }
async function activatePromotion(paymentId,txid,userToken){ const payment=await getPiPayment(paymentId); const info=await validatePromotionPayment(payment,userToken); const complete=payment.status?.developer_completed?payment:await completePiPayment(paymentId,txid); const p=await one(db.from('payments').upsert({user_id:info.user.id,listing_id:info.listingId,service:info.service,amount_pi:info.amount,pi_payment_id:paymentId,txid,status:'completed',completed_at:new Date().toISOString()},{onConflict:'pi_payment_id'}).select('*')); const listing=await one(db.from('listings').select('featured_until,urgent_until,promoted_until').eq('id',p.listing_id)); const patch={bumped_at:new Date().toISOString()}; if(p.service==='featured_7d')patch.featured_until=extendUntil(listing.featured_until,7); if(p.service==='urgent')patch.urgent_until=extendUntil(listing.urgent_until,3); if(p.service==='boost_1d'||p.service==='boost_3d')patch.promoted_until=extendUntil(listing.promoted_until,PROMOTION_DAYS[p.service]); await db.from('listings').update(patch).eq('id',p.listing_id).eq('seller_id',info.user.id); await notify(info.user.id,'promotion','تم تفعيل ترويج الإعلان',`${p.service} · ${info.amount} PI`,`listing:${p.listing_id}`); return complete; }
app.post('/api/payments/approve',auth,safe(async(req,res)=>{const paymentId=String(req.body.paymentId||'');if(!paymentId)throw new Error('Payment id is required');const payment=await getPiPayment(paymentId);const info=await validatePromotionPayment(payment,req.user);if(!payment.status?.developer_approved)await approvePiPayment(paymentId);await db.from('payments').upsert({user_id:info.user.id,listing_id:info.listingId,service:info.service,amount_pi:info.amount,pi_payment_id:paymentId,status:'approved'},{onConflict:'pi_payment_id'});res.json({ok:true});}));
app.post('/api/payments/complete',auth,safe(async(req,res)=>{const paymentId=String(req.body.paymentId||''),txid=String(req.body.txid||'');if(!paymentId||!txid)throw new Error('Payment id and txid are required');res.json({ok:true,complete:await activatePromotion(paymentId,txid,req.user)});}));
app.post('/api/payments/reconcile',auth,safe(async(req,res)=>{const paymentId=String(req.body.paymentId||'');if(!paymentId)throw new Error('Payment id is required');const payment=await getPiPayment(paymentId);await validatePromotionPayment(payment,req.user);if(payment.status?.developer_completed)return res.json({ok:true,alreadyCompleted:true});const txid=payment.transaction?.txid;if(!txid||!payment.status?.transaction_verified)throw new Error('Payment transaction is not ready for completion');res.json({ok:true,complete:await activatePromotion(paymentId,txid,req.user)});}));

app.get('/api/admin/verification-requests',auth,admin,safe(async(_req,res)=>{const rows=(await many(db.from('verification_requests').select('*').order('created_at',{ascending:false}))).data;const ids=rows.map(x=>x.user_id);const ps=ids.length?(await many(db.from('profiles').select('id,display_name,pi_username,is_verified').in('id',ids))).data:[];const pm=new Map(ps.map(x=>[x.id,x]));res.json(rows.map(x=>({...x,profiles:pm.get(x.user_id)||null})))}));
app.patch('/api/admin/verification-requests/:id',auth,admin,safe(async(req,res)=>{const status=String(req.body.status||'');if(!['approved','rejected'].includes(status))throw new Error('Invalid status');const vr=await one(db.from('verification_requests').select('*').eq('id',req.params.id));const data=await one(db.from('verification_requests').update({status,reviewed_by:req.user.id,reviewed_at:new Date().toISOString()}).eq('id',vr.id).select('*'));if(status==='approved')await db.from('profiles').update({is_verified:true}).eq('id',vr.user_id);await notify(vr.user_id,'verification',status==='approved'?'تم توثيق حسابك':'تعذر توثيق الحساب',status==='approved'?'أصبحت شارة التوثيق ظاهرة على حسابك.':'راجع بياناتك ثم أرسل طلبًا جديدًا.');res.json({data})}));
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
