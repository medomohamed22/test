'use strict';
const { createClient } = require('@supabase/supabase-js');
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
function fail(message,code,status=400){const e=new Error(message);e.code=code;e.statusCode=status;throw e}
function isNotificationsAccessError(error){return Boolean(error&&(['42501','42P01','42703'].includes(String(error.code))||/permission denied for table notifications|relation .*notifications.* does not exist|column .* does not exist/i.test(String(error.message||''))))}
function parse(req){return typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{})}
function text(v,min,max,name){const s=String(v??'').normalize('NFKC').trim().replace(/[\u0000-\u001f\u007f]/g,' ');if(s.length<min||s.length>max)fail(`${name} is invalid`,`${name.toUpperCase()}_INVALID`);if(/<[^>]*>|javascript:|data:text\/html|on\w+\s*=/i.test(s))fail(`${name} contains forbidden content`,`${name.toUpperCase()}_UNSAFE`);return s}
async function user(req){const m=String(req.headers.authorization||'').match(/^Bearer\s+([^\s]+)$/i);if(!m)fail('Login required','PI_TOKEN_MISSING',401);const c=new AbortController(),timer=setTimeout(()=>c.abort(),8000);try{const r=await fetch('https://api.minepi.com/v2/me',{headers:{Authorization:`Bearer ${m[1]}`,Accept:'application/json'},signal:c.signal});const j=await r.json().catch(()=>({}));if(!r.ok||!j.uid)fail('Invalid Pi session','PI_TOKEN_INVALID',401);await sb.from('app_users').upsert({pi_uid:String(j.uid),username:String(j.username||'Pioneer'),updated_at:new Date().toISOString()},{onConflict:'pi_uid'});return{uid:String(j.uid),username:String(j.username||'Pioneer')}}finally{clearTimeout(timer)}}
async function ownedProduct(id,uid){const {data,error}=await sb.from('products').select('*').eq('id',id).eq('seller_pi_id',uid).maybeSingle();if(error)throw error;if(!data)fail('Product not found','PRODUCT_NOT_FOUND',404);return data}
module.exports=async(req,res)=>{res.setHeader('Cache-Control','no-store');try{const u=await user(req),b=parse(req),action=String(req.query?.action||b.action||'dashboard');
if(req.method==='GET'&&action==='dashboard'){
 const [fav,reviews,verification]=await Promise.all([
  sb.from('favorites').select('product_id,created_at,products(id,name,price_usd,images,country,location,status,promoted_until)').eq('user_pi_id',u.uid).order('created_at',{ascending:false}),
  sb.from('reviews').select('id,rating,comment,created_at,reviewer_username,seller_pi_id,product_id').or(`reviewer_pi_id.eq.${u.uid},seller_pi_id.eq.${u.uid}`).order('created_at',{ascending:false}).limit(100),
  sb.from('app_users').select('verification_level,verification_status,verification_phone,created_at').eq('pi_uid',u.uid).maybeSingle()
 ]);for(const x of [fav,reviews,verification])if(x.error)throw x.error;
 return res.json({favorites:fav.data||[],reviews:reviews.data||[],verification:verification.data||{}})
}
if(req.method==='GET'&&action==='seller'){
 const seller=text(req.query?.seller,1,128,'seller');const [profile,reviews,counts]=await Promise.all([
  sb.from('app_users').select('pi_uid,username,created_at,verification_level,verification_status').eq('pi_uid',seller).maybeSingle(),
  sb.from('reviews').select('id,rating,comment,created_at,reviewer_username,product_id').eq('seller_pi_id',seller).order('created_at',{ascending:false}).limit(50),
  sb.from('products').select('id',{count:'exact',head:true}).eq('seller_pi_id',seller).eq('status','approved')
 ]);if(profile.error||reviews.error||counts.error)throw(profile.error||reviews.error||counts.error);const arr=reviews.data||[],avg=arr.length?arr.reduce((s,x)=>s+Number(x.rating||0),0)/arr.length:0;return res.json({profile:profile.data,reviews:arr,ratingAverage:avg,ratingCount:arr.length,adsCount:counts.count||0})
}
if(req.method==='POST'&&action==='favorite'){
 const id=Number(b.productId);if(!Number.isInteger(id))fail('Invalid product','PRODUCT_ID_INVALID');const {data:product,error:productError}=await sb.from('products').select('id,status').eq('id',id).maybeSingle();if(productError)throw productError;if(!product||product.status!=='approved')fail('Product is unavailable','PRODUCT_UNAVAILABLE',404);if(b.remove){const {error}=await sb.from('favorites').delete().eq('user_pi_id',u.uid).eq('product_id',id);if(error)throw error}else{const {error}=await sb.from('favorites').upsert({user_pi_id:u.uid,product_id:id},{onConflict:'user_pi_id,product_id'});if(error)throw error;await sb.from('product_events').insert({product_id:id,actor_pi_id:u.uid,event_type:'favorite'})}return res.json({success:true})
}


if(req.method==='POST'&&action==='review'){
 const productId=Number(b.productId),rating=Number(b.rating);if(!Number.isInteger(productId)||rating<1||rating>5)fail('Invalid review','REVIEW_INVALID');const {data:p,error:pe}=await sb.from('products').select('seller_pi_id,status,item_status').eq('id',productId).maybeSingle();if(pe)throw pe;if(!p||p.item_status!=='sold')fail('Reviews are available after the item is sold','REVIEW_NOT_ALLOWED');if(p.seller_pi_id===u.uid)fail('You cannot review yourself','REVIEW_SELF');const comment=text(b.comment||'',0,500,'comment');const {data,error}=await sb.from('reviews').upsert({product_id:productId,reviewer_pi_id:u.uid,reviewer_username:u.username,seller_pi_id:p.seller_pi_id,rating,comment},{onConflict:'product_id,reviewer_pi_id'}).select().single();if(error)throw error;return res.json({review:data})
}


if(req.method==='POST'&&action==='verification'){
 const rawPhone=text(b.phone||'',6,24,'phone');const phone=rawPhone.replace(/[\s().-]/g,'');if(!/^\+?\d{6,15}$/.test(phone))fail('Enter a valid phone number using digits only','PHONE_INVALID');const evidence=`telegram_phone:${phone}`;const {error}=await sb.from('verification_requests').insert({user_pi_id:u.uid,requested_level:'phone',evidence,phone,status:'pending'});if(error)throw error;await sb.from('app_users').update({verification_status:'pending',verification_phone:phone}).eq('pi_uid',u.uid);return res.status(201).json({success:true})
}
if(req.method==='PATCH'&&action==='status'){
 const id=Number(b.productId),status=String(b.status);if(!['approved','reserved','sold','expired'].includes(status))fail('Invalid status','STATUS_INVALID');await ownedProduct(id,u.uid);const patch={item_status:status,updated_at:new Date().toISOString()};if(status==='sold')patch.sold_at=new Date().toISOString();const {error}=await sb.from('products').update(patch).eq('id',id).eq('seller_pi_id',u.uid);if(error)throw error;return res.json({success:true})
}
if(req.method==='POST'&&action==='event'){
 const id=Number(b.productId),type=String(b.eventType);if(!Number.isInteger(id)||!['view','chat','contact','share','favorite'].includes(type))fail('Invalid event','EVENT_INVALID');const {error}=await sb.from('product_events').insert({product_id:id,actor_pi_id:u.uid,event_type:type});if(error)throw error;return res.json({success:true})
}
if(req.method==='GET'&&action==='notifications'){
 const {data,error}=await sb.from('notifications').select('id,type,title_ar,title_en,body_ar,body_en,product_id,is_read,created_at').eq('user_pi_id',u.uid).order('created_at',{ascending:false}).limit(100);
 if(error){if(isNotificationsAccessError(error)){console.warn('notifications unavailable:',error.code,error.message);return res.json({notifications:[],temporarilyUnavailable:true})}throw error}
 return res.json({notifications:data||[]})
}
if(req.method==='POST'&&action==='notification-read'){
 const id=Number(b.id);let q=sb.from('notifications').update({is_read:true}).eq('user_pi_id',u.uid);if(Number.isInteger(id))q=q.eq('id',id);const {error}=await q;
 if(error){if(isNotificationsAccessError(error)){console.warn('notification update unavailable:',error.code,error.message);return res.json({success:true,temporarilyUnavailable:true})}throw error}
 return res.json({success:true})
}
if(req.method==='POST'&&action==='client-error'){
 const message=text(b.message||'Unknown error',1,500,'message'),source=text(b.source||'frontend',1,80,'source');await sb.from('app_error_logs').insert({user_pi_id:u.uid,source,code:String(b.code||'').slice(0,80),message,details:b.details&&typeof b.details==='object'?b.details:{}});return res.json({success:true})
}
if(req.method==='GET'&&action==='analytics'){
 const {data:products,error:pe}=await sb.from('products').select('id,name,views,status,promoted_until').eq('seller_pi_id',u.uid);if(pe)throw pe;const ids=(products||[]).map(x=>x.id);let events=[];if(ids.length){const r=await sb.from('product_events').select('product_id,event_type,created_at').in('product_id',ids);if(r.error)throw r.error;events=r.data||[]}const by={};for(const e of events){by[e.product_id]||={favorite:0,chat:0,contact:0,share:0,view:0};by[e.product_id][e.event_type]=(by[e.product_id][e.event_type]||0)+1}return res.json({products:(products||[]).map(p=>({...p,events:by[p.id]||{favorite:0,chat:0,contact:0,share:0,view:0}}))})
}
if(req.method==='POST'&&action==='bump'){
 const id=Number(b.productId),p=await ownedProduct(id,u.uid),last=p.bumped_at?new Date(p.bumped_at).getTime():0;if(Date.now()-last<24*60*60*1000)fail('You can refresh this ad once every 24 hours','BUMP_COOLDOWN',429);const now=new Date().toISOString();const {error}=await sb.from('products').update({bumped_at:now,updated_at:now}).eq('id',id).eq('seller_pi_id',u.uid);if(error)throw error;return res.json({success:true,bumpedAt:now})
}
return res.status(405).json({error:'Unsupported action',code:'ACTION_UNSUPPORTED'})
}catch(e){console.error('marketplace:',e);return res.status(e.statusCode||400).json({error:e.message||'Request failed',code:e.code||'REQUEST_FAILED'})}}
