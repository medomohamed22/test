'use strict';
const {createClient}=require('@supabase/supabase-js');
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
const SORTS={newest:['created_at',false],price_asc:['price_usd',true],price_desc:['price_usd',false],views_desc:['views',false]};
const REQUIRED_COLUMNS=['id','seller_pi_id','seller_username','name','description','category','country','location','price_usd','images','status','views','promoted_until','promotion_tier','created_at'];
const OPTIONAL_COLUMNS=['item_status','attributes','latitude','longitude','bumped_at','expires_at','renewed_at','renewal_count'];

function missingColumn(error){
  const text=String(error?.message||'');
  const match=text.match(/column(?:\s+products\.)?["']?([a-zA-Z0-9_]+)["']?\s+does not exist/i)||text.match(/Could not find the ['"]([a-zA-Z0-9_]+)['"] column/i);
  return match?.[1]||null;
}

async function fetchProducts(req,limit,offset,sort){
  let columns=[...REQUIRED_COLUMNS,...OPTIONAL_COLUMNS];
  for(let attempt=0;attempt<OPTIONAL_COLUMNS.length+2;attempt++){
    let query=sb.from('products').select(columns.join(',')).eq('status','approved');
    if(req.query?.category)query=query.eq('category',String(req.query.category).slice(0,80));
    if(req.query?.country)query=query.eq('country',String(req.query.country).slice(0,100));
    if(req.query?.location)query=query.eq('location',String(req.query.location).slice(0,100));
    const result=await query.order(sort[0],{ascending:sort[1],nullsFirst:false}).range(offset,offset+limit-1);
    if(!result.error)return result;
    const missing=missingColumn(result.error);
    if(missing&&columns.includes(missing)&&OPTIONAL_COLUMNS.includes(missing)){
      columns=columns.filter(c=>c!==missing);
      continue;
    }
    throw result.error;
  }
  throw new Error('Unable to load products');
}

async function enrichSellerStats(products){
  if(!products.length)return products;
  const sellerIds=[...new Set(products.map(p=>p.seller_pi_id).filter(Boolean))];
  if(!sellerIds.length)return products;
  const [{data:users,error:usersError},{data:approvedAds,error:adsError}]=await Promise.all([
    sb.from('app_users').select('pi_uid,created_at,verification_level,verification_status').in('pi_uid',sellerIds),
    sb.from('products').select('seller_pi_id').eq('status','approved').in('seller_pi_id',sellerIds)
  ]);
  if(usersError)console.error('seller users:',usersError.message);
  if(adsError)console.error('seller ad counts:',adsError.message);
  const userMap=new Map((users||[]).map(u=>[u.pi_uid,u]));
  const counts=new Map();
  for(const ad of approvedAds||[])counts.set(ad.seller_pi_id,(counts.get(ad.seller_pi_id)||0)+1);
  return products.map(p=>{const u=userMap.get(p.seller_pi_id)||{};return {...p,item_status:p.item_status||'available',attributes:p.attributes||{},latitude:p.latitude??null,longitude:p.longitude??null,bumped_at:p.bumped_at||null,expires_at:p.expires_at||null,renewed_at:p.renewed_at||null,renewal_count:Number(p.renewal_count||0),seller_joined_at:u.created_at||null,seller_verification_level:u.verification_level||'none',seller_verification_status:u.verification_status||'unverified',seller_ads_count:counts.get(p.seller_pi_id)||0}});
}

module.exports=async(req,res)=>{try{
  if(req.method==='GET'){
    res.setHeader('Cache-Control','no-store, max-age=0');
    const limit=Math.min(50,Math.max(1,Number(req.query?.limit)||20));
    const offset=Math.max(0,Number(req.query?.offset)||0);
    const sort=SORTS[req.query?.sort]||SORTS.newest;
    const result=await fetchProducts(req,limit,offset,sort);
    const data=result.data||[];
    return res.json({products:await enrichSellerStats(data),offset,limit,hasMore:data.length===limit});
  }
  if(req.method==='POST'){
    res.setHeader('Cache-Control','no-store');
    const b=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{}),id=Number(b.id);
    if(!Number.isInteger(id)||id<1)return res.status(400).json({error:'Invalid id'});
    const {data,error}=await sb.rpc('increment_product_views',{product_id_input:id});
    if(error){console.error('view count:',error.message);return res.json({views:null,counted:false})}
    return res.json({views:data,counted:true});
  }
  return res.status(405).json({error:'Method not allowed'});
}catch(e){console.error('public-products:',e);return res.status(500).json({error:e.message||'Request failed'})}};
