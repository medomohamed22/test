import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { z } from 'zod';
import { db, one, many } from './db.js';
import { verifyPiAccessToken, approvePiPayment, completePiPayment, getPiPayment } from './pi.js';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

app.use(cors({ origin: true, credentials: true }));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '8mb' }));
app.use(express.static(root));

function tokenFor(user) { return jwt.sign({ id: user.id, role: user.role, pi_uid: user.pi_uid }, JWT_SECRET, { expiresIn: '30d' }); }
function auth(req,res,next){
  try { const raw=(req.headers.authorization||'').replace(/^Bearer\s+/,''); req.user=jwt.verify(raw,JWT_SECRET); next(); }
  catch { res.status(401).json({ error:'Unauthorized' }); }
}
function admin(req,res,next){ return ['admin','super_admin','moderator'].includes(req.user?.role) ? next() : res.status(403).json({error:'Forbidden'}); }
const safe = fn => async (req,res) => { try { await fn(req,res); } catch(e) { console.error(e); res.status(400).json({ error:e.message || 'Request failed' }); } };

app.get('/health', (_req,res)=>res.json({ok:true,app:'DealWay'}));

app.post('/api/auth/pi', safe(async(req,res)=>{
  const me = await verifyPiAccessToken(req.body.accessToken);
  const piUid = me.uid || me.user?.uid;
  const username = me.username || me.user?.username || 'Pioneer';
  if (!piUid) throw new Error('Invalid Pi identity');
  let { data:user } = await db.from('profiles').select('*').eq('pi_uid',piUid).maybeSingle();
  if (!user) user = await one(db.from('profiles').insert({ pi_uid:piUid, pi_username:username, display_name:username }).select('*'));
  else if (username && user.pi_username !== username) user = await one(db.from('profiles').update({pi_username:username,display_name:user.display_name||username,updated_at:new Date().toISOString()}).eq('id',user.id).select('*'));
  res.json({ token:tokenFor(user), user });
}));
app.get('/api/me', auth, safe(async(req,res)=>res.json({user:await one(db.from('profiles').select('*').eq('id',req.user.id))})));
app.patch('/api/me', auth, safe(async(req,res)=>{
  const allowed=['display_name','avatar_url','country','city']; const patch={}; for(const k of allowed) if(req.body[k]!==undefined) patch[k]=req.body[k];
  patch.updated_at=new Date().toISOString(); res.json({user:await one(db.from('profiles').update(patch).eq('id',req.user.id).select('*'))});
}));

app.get('/api/categories', safe(async(_req,res)=>{ const out = await many(db.from('categories').select('*').eq('is_active',true).order('sort_order')); res.json(out.data); }));
app.get('/api/settings', safe(async(_req,res)=>{
  const {data}=await db.from('site_settings').select('key,value'); res.json(Object.fromEntries((data||[]).map(x=>[x.key,x.value])));
}));

app.get('/api/listings', safe(async(req,res)=>{
  const { q='', category='', city='', condition='', min='', max='', sort='newest', page='0', limit='24' }=req.query;
  let query=db.from('listings').select('*, profiles!listings_seller_id_fkey(id,display_name,avatar_url,rating,is_verified,seller_type), categories(name,slug,icon)',{count:'exact'}).eq('status','active');
  if(q) query=query.textSearch('title',String(q),{type:'websearch'});
  if(category) query=query.eq('category_id',category); if(city) query=query.ilike('city',`%${city}%`); if(condition) query=query.eq('condition',condition);
  if(min) query=query.gte('price_pi',Number(min)); if(max) query=query.lte('price_pi',Number(max));
  if(sort==='price_asc') query=query.order('price_pi',{ascending:true}); else if(sort==='price_desc') query=query.order('price_pi',{ascending:false}); else if(sort==='views') query=query.order('views',{ascending:false}); else query=query.order('featured_until',{ascending:false,nullsFirst:false}).order('bumped_at',{ascending:false});
  const from=Number(page)*Number(limit); const out=await many(query.range(from,from+Number(limit)-1)); res.json(out);
}));
app.get('/api/listings/:id', safe(async(req,res)=>{
  await db.rpc('increment_listing_views',{listing_id:req.params.id}).catch(()=>{});
  const item=await one(db.from('listings').select('*, profiles!listings_seller_id_fkey(*), categories(*)').eq('id',req.params.id)); res.json({data:item});
}));
app.post('/api/listings', auth, safe(async(req,res)=>{
  const S=z.object({title:z.string().min(3),description:z.string().min(10),category_id:z.string().uuid(),condition:z.enum(['new','like_new','used']),price_pi:z.coerce.number().nonnegative(),negotiable:z.boolean().default(false),image_urls:z.array(z.string()).max(10).default([]),country:z.string().optional(),city:z.string().optional(),area:z.string().optional(),delivery_available:z.boolean().default(false)});
  const v=S.parse(req.body); const data=await one(db.from('listings').insert({...v,seller_id:req.user.id}).select('*')); res.status(201).json({data});
}));
app.patch('/api/listings/:id', auth, safe(async(req,res)=>{
  const allowed=['title','description','category_id','condition','price_pi','negotiable','image_urls','country','city','area','delivery_available','status']; const patch={}; for(const k of allowed) if(req.body[k]!==undefined) patch[k]=req.body[k]; patch.updated_at=new Date().toISOString();
  res.json({data:await one(db.from('listings').update(patch).eq('id',req.params.id).eq('seller_id',req.user.id).select('*'))});
}));
app.delete('/api/listings/:id', auth, safe(async(req,res)=>{ await db.from('listings').update({status:'deleted'}).eq('id',req.params.id).eq('seller_id',req.user.id); res.json({ok:true}); }));
app.get('/api/my-listings', auth, safe(async(req,res)=>res.json((await many(db.from('listings').select('*').eq('seller_id',req.user.id).order('created_at',{ascending:false}))).data)));

app.get('/api/favorites', auth, safe(async(req,res)=>{ const out = await many(db.from('favorites').select('listing_id,listings(*)').eq('user_id',req.user.id)); res.json(out.data); }));
app.post('/api/favorites/:id', auth, safe(async(req,res)=>{ await db.from('favorites').upsert({user_id:req.user.id,listing_id:req.params.id}); res.json({ok:true}); }));
app.delete('/api/favorites/:id', auth, safe(async(req,res)=>{ await db.from('favorites').delete().eq('user_id',req.user.id).eq('listing_id',req.params.id); res.json({ok:true}); }));

app.post('/api/chats', auth, safe(async(req,res)=>{
  const listing=await one(db.from('listings').select('seller_id').eq('id',req.body.listing_id)); if(listing.seller_id===req.user.id) throw new Error('Cannot chat with yourself');
  let {data:chat}=await db.from('chats').select('*').eq('listing_id',req.body.listing_id).eq('buyer_id',req.user.id).eq('seller_id',listing.seller_id).maybeSingle();
  if(!chat) chat=await one(db.from('chats').insert({listing_id:req.body.listing_id,buyer_id:req.user.id,seller_id:listing.seller_id}).select('*')); res.json({data:chat});
}));
app.get('/api/chats', auth, safe(async(req,res)=>{
  const q=db.from('chats').select('*, listings(title,image_urls,price_pi), messages(body,created_at)').or(`buyer_id.eq.${req.user.id},seller_id.eq.${req.user.id}`).order('updated_at',{ascending:false}); res.json((await many(q)).data);
}));
app.get('/api/chats/:id/messages', auth, safe(async(req,res)=>{
  const chat=await one(db.from('chats').select('*').eq('id',req.params.id)); if(![chat.buyer_id,chat.seller_id].includes(req.user.id)) throw new Error('Forbidden');
  res.json((await many(db.from('messages').select('*,profiles!messages_sender_id_fkey(display_name,avatar_url)').eq('chat_id',req.params.id).order('created_at'))).data);
}));
app.post('/api/chats/:id/messages', auth, safe(async(req,res)=>{
  const body=String(req.body.body||'').trim(); if(!body) throw new Error('Message required'); const chat=await one(db.from('chats').select('*').eq('id',req.params.id)); if(![chat.buyer_id,chat.seller_id].includes(req.user.id)) throw new Error('Forbidden');
  const msg=await one(db.from('messages').insert({chat_id:req.params.id,sender_id:req.user.id,body}).select('*')); await db.from('chats').update({updated_at:new Date().toISOString()}).eq('id',req.params.id); io.to(`chat:${req.params.id}`).emit('message:new',msg); res.status(201).json({data:msg});
}));

app.post('/api/offers', auth, safe(async(req,res)=>{
  const l=await one(db.from('listings').select('seller_id').eq('id',req.body.listing_id)); if(l.seller_id===req.user.id) throw new Error('Cannot offer on own listing');
  const data=await one(db.from('offers').insert({listing_id:req.body.listing_id,buyer_id:req.user.id,seller_id:l.seller_id,amount_pi:Number(req.body.amount_pi)}).select('*')); res.status(201).json({data});
}));
app.patch('/api/offers/:id', auth, safe(async(req,res)=>{
  const status=req.body.status; if(!['accepted','rejected','countered','cancelled'].includes(status)) throw new Error('Invalid status');
  const offer=await one(db.from('offers').select('*').eq('id',req.params.id)); if(![offer.buyer_id,offer.seller_id].includes(req.user.id)) throw new Error('Forbidden');
  res.json({data:await one(db.from('offers').update({status,amount_pi:req.body.amount_pi??offer.amount_pi,updated_at:new Date().toISOString()}).eq('id',offer.id).select('*'))});
}));

app.post('/api/reports', auth, safe(async(req,res)=>{ const data=await one(db.from('reports').insert({listing_id:req.body.listing_id,reporter_id:req.user.id,reason:req.body.reason,details:req.body.details||null}).select('*')); res.status(201).json({data}); }));
app.post('/api/reviews', auth, safe(async(req,res)=>{ const data=await one(db.from('reviews').insert({reviewer_id:req.user.id,reviewed_user_id:req.body.reviewed_user_id,listing_id:req.body.listing_id||null,rating:Number(req.body.rating),comment:req.body.comment||null}).select('*')); res.status(201).json({data}); }));

app.post('/api/payments/approve', auth, safe(async(req,res)=>{
  const {paymentId,service,listingId,amountPi}=req.body; const payment=await getPiPayment(paymentId); if(Number(payment.amount)!==Number(amountPi)) throw new Error('Payment amount mismatch');
  await approvePiPayment(paymentId); await db.from('payments').upsert({user_id:req.user.id,listing_id:listingId||null,service,amount_pi:amountPi,pi_payment_id:paymentId,status:'approved'},{onConflict:'pi_payment_id'}); res.json({ok:true});
}));
app.post('/api/payments/complete', auth, safe(async(req,res)=>{
  const {paymentId,txid}=req.body; const complete=await completePiPayment(paymentId,txid); const p=await one(db.from('payments').update({txid,status:'completed',completed_at:new Date().toISOString()}).eq('pi_payment_id',paymentId).eq('user_id',req.user.id).select('*'));
  const days=p.service==='featured_7d'?7:p.service==='boost_7d'?7:p.service==='boost_3d'?3:1; if(p.listing_id){ const patch={bumped_at:new Date().toISOString()}; if(p.service.startsWith('featured')) patch.featured_until=new Date(Date.now()+days*86400000).toISOString(); if(p.service==='urgent') patch.urgent_until=new Date(Date.now()+7*86400000).toISOString(); await db.from('listings').update(patch).eq('id',p.listing_id); }
  res.json({ok:true,complete});
}));

app.get('/api/admin/stats', auth, admin, safe(async(_req,res)=>{
  const [u,l,r,p]=await Promise.all([db.from('profiles').select('*',{count:'exact',head:true}),db.from('listings').select('*',{count:'exact',head:true}),db.from('reports').select('*',{count:'exact',head:true}).eq('status','open'),db.from('payments').select('amount_pi').eq('status','completed')]);
  res.json({users:u.count||0,listings:l.count||0,openReports:r.count||0,revenuePi:(p.data||[]).reduce((s,x)=>s+Number(x.amount_pi||0),0)});
}));
app.get('/api/admin/reports', auth, admin, safe(async(_req,res)=>{ const out = await many(db.from('reports').select('*,listings(title),profiles!reports_reporter_id_fkey(display_name)').order('created_at',{ascending:false})); res.json(out.data); }));
app.patch('/api/admin/reports/:id', auth, admin, safe(async(req,res)=>{ res.json({data:await one(db.from('reports').update({status:req.body.status}).eq('id',req.params.id).select('*'))}); }));

io.on('connection', socket=>{
  socket.on('chat:join', id=>socket.join(`chat:${id}`));
  socket.on('chat:typing', ({chatId,user})=>socket.to(`chat:${chatId}`).emit('chat:typing',{user}));
});

app.use((_req,res)=>res.sendFile(path.join(root,'index.html')));
server.listen(Number(process.env.PORT||4000),()=>console.log(`DealWay running on http://localhost:${process.env.PORT||4000}`));
