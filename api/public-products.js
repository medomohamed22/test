'use strict';
const {createClient}=require('@supabase/supabase-js');

const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{
  auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}
});

const SORTS={
  newest:(a,b)=>dateValue(b.created_at)-dateValue(a.created_at)||Number(b.id||0)-Number(a.id||0),
  price_asc:(a,b)=>Number(a.price_usd||0)-Number(b.price_usd||0),
  price_desc:(a,b)=>Number(b.price_usd||0)-Number(a.price_usd||0),
  views_desc:(a,b)=>Number(b.views||0)-Number(a.views||0)
};

function dateValue(value){const n=new Date(value||0).getTime();return Number.isFinite(n)?n:0}
function cleanStatus(value){return String(value||'').trim().toLowerCase()}
function normalizeImages(value){
  if(Array.isArray(value))return value.filter(x=>typeof x==='string'&&x.trim());
  if(typeof value==='string'){
    try{const parsed=JSON.parse(value);if(Array.isArray(parsed))return parsed.filter(x=>typeof x==='string'&&x.trim())}catch(_){if(value.trim())return [value.trim()]}
  }
  return [];
}
function normalizeProduct(p){
  return {
    ...p,
    id:Number(p.id),
    images:normalizeImages(p.images),
    views:Number(p.views||0),
    price_usd:Number(p.price_usd||0),
    promotion_tier:Number(p.promotion_tier||1),
    renewal_count:Number(p.renewal_count||0),
    item_status:p.item_status||'available',
    attributes:p.attributes&&typeof p.attributes==='object'&&!Array.isArray(p.attributes)?p.attributes:{},
    latitude:p.latitude==null?null:Number(p.latitude),
    longitude:p.longitude==null?null:Number(p.longitude)
  };
}
function promoted(p){const end=dateValue(p.promoted_until);return end>Date.now()?1:0}
function compareProducts(a,b,mode){
  const promo=promoted(b)-promoted(a);
  if(promo)return promo;
  const cmp=(SORTS[mode]||SORTS.newest)(a,b);
  return cmp||SORTS.newest(a,b);
}

async function loadApprovedProducts(){
  // Select * intentionally: this project has several historical schema versions.
  // Naming optional columns explicitly made the whole homepage fail when one migration was missing.
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),12000);
  try{
    const {data,error}=await sb.from('products').select('*').order('created_at',{ascending:false}).limit(1000).abortSignal(controller.signal);
    if(error)throw error;
    return (data||[]).filter(p=>cleanStatus(p.status)==='approved').map(normalizeProduct);
  }finally{clearTimeout(timer)}
}

async function enrichSellerStats(products){
  if(!products.length)return products;
  const sellerIds=[...new Set(products.map(p=>String(p.seller_pi_id||'')).filter(Boolean))];
  if(!sellerIds.length)return products;
  let users=[],approvedAds=[];
  try{
    const result=await sb.from('app_users').select('*').in('pi_uid',sellerIds);
    if(!result.error)users=result.data||[];else console.error('seller users:',result.error.message);
  }catch(e){console.error('seller users:',e.message)}
  try{
    const result=await sb.from('products').select('seller_pi_id,status').in('seller_pi_id',sellerIds);
    if(!result.error)approvedAds=(result.data||[]).filter(x=>cleanStatus(x.status)==='approved');else console.error('seller counts:',result.error.message);
  }catch(e){console.error('seller counts:',e.message)}
  const userMap=new Map(users.map(u=>[String(u.pi_uid),u]));
  const counts=new Map();
  for(const ad of approvedAds)counts.set(String(ad.seller_pi_id),(counts.get(String(ad.seller_pi_id))||0)+1);
  return products.map(p=>{
    const u=userMap.get(String(p.seller_pi_id))||{};
    return {...p,
      seller_joined_at:u.created_at||null,
      seller_verification_level:u.verification_level||'none',
      seller_verification_status:u.verification_status||'unverified',
      seller_ads_count:counts.get(String(p.seller_pi_id))||0
    };
  });
}

module.exports=async(req,res)=>{
  res.setHeader('Cache-Control','no-store, max-age=0');
  try{
    if(req.method==='GET'){
      const limit=Math.min(50,Math.max(1,Number(req.query?.limit)||20));
      const offset=Math.max(0,Number(req.query?.offset)||0);
      const mode=String(req.query?.sort||'newest');
      let products=await loadApprovedProducts();
      if(req.query?.category)products=products.filter(p=>String(p.category)===String(req.query.category));
      if(req.query?.country)products=products.filter(p=>String(p.country)===String(req.query.country));
      if(req.query?.location)products=products.filter(p=>String(p.location)===String(req.query.location));
      products.sort((a,b)=>compareProducts(a,b,mode));
      const page=products.slice(offset,offset+limit);
      return res.status(200).json({products:await enrichSellerStats(page),offset,limit,hasMore:offset+limit<products.length,total:products.length});
    }
    if(req.method==='POST'){
      const b=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{}),id=Number(b.id);
      if(!Number.isInteger(id)||id<1)return res.status(400).json({error:'Invalid id'});
      const {data,error}=await sb.rpc('increment_product_views',{product_id_input:id});
      if(error){console.error('view count:',error.message);return res.status(200).json({views:null,counted:false})}
      return res.status(200).json({views:data,counted:true});
    }
    return res.status(405).json({error:'Method not allowed'});
  }catch(e){
    console.error('public-products:',e);
    const message=e?.name==='AbortError'?'Products request timed out':(e.message||'Request failed');
    return res.status(500).json({error:message,code:'PUBLIC_PRODUCTS_FAILED'});
  }
};
