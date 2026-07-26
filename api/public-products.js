'use strict';
const {createClient}=require('@supabase/supabase-js');
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
const SORTS={newest:['created_at',false],price_asc:['price_usd',true],price_desc:['price_usd',false],views_desc:['views',false]};

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
  return products.map(p=>{const u=userMap.get(p.seller_pi_id)||{};return {...p,seller_joined_at:u.created_at||null,seller_verification_level:u.verification_level||'none',seller_verification_status:u.verification_status||'unverified',seller_ads_count:counts.get(p.seller_pi_id)||0}});
}

module.exports=async(req,res)=>{try{
  if(req.method==='GET'){
    // Always validate against the database so a newly approved ad from a new country appears immediately.
    res.setHeader('Cache-Control','no-store, max-age=0');
    const limit=Math.min(50,Math.max(1,Number(req.query?.limit)||20)),offset=Math.max(0,Number(req.query?.offset)||0),sort=SORTS[req.query?.sort]||SORTS.newest;
    const baseColumns='id,seller_pi_id,seller_username,name,description,category,country,location,price_usd,images,status,item_status,attributes,latitude,longitude,views,promoted_until,promotion_tier,bumped_at,created_at,renewed_at,renewal_count';
    const buildQuery=(includeExpiry)=>{
      let query=sb.from('products').select(`${baseColumns}${includeExpiry?',expires_at':''}`).eq('status','approved');
      if(includeExpiry)query=query.or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
      if(req.query?.category)query=query.eq('category',String(req.query.category).slice(0,80));
      if(req.query?.country)query=query.eq('country',String(req.query.country).slice(0,100));
      if(req.query?.location)query=query.eq('location',String(req.query.location).slice(0,100));
      return query.order(sort[0],{ascending:sort[1],nullsFirst:false}).range(offset,offset+limit-1);
    };
    let result=await buildQuery(true);
    // Keep the current production site readable while the renewal migration is being applied.
    if(result.error && (result.error.code==='42703'||/expires_at/i.test(result.error.message||''))){
      console.warn('expires_at is not available yet; using legacy product query');
      result=await buildQuery(false);
    }
    if(result.error)throw result.error;
    let data=result.data||[];
    let legacyExpiryRecovered=false;

    // Compatibility recovery for ads that were approved before the expiry feature was deployed.
    // The first migration used created_at + 30 days, which immediately expired older live ads.
    // This fallback is deliberately limited to pre-rollout, never-renewed ads and only runs when
    // the normal active feed is empty. Run sql/11_restore_legacy_approved_ads.sql to repair them.
    if(!data.length && offset===0){
      let legacy=sb.from('products')
        .select(`${baseColumns},expires_at`)
        .eq('status','approved')
        .lt('created_at','2026-07-26T00:00:00.000Z')
        .or('renewal_count.is.null,renewal_count.eq.0')
        .order(sort[0],{ascending:sort[1],nullsFirst:false})
        .range(0,limit-1);
      if(req.query?.category)legacy=legacy.eq('category',String(req.query.category).slice(0,80));
      if(req.query?.country)legacy=legacy.eq('country',String(req.query.country).slice(0,100));
      if(req.query?.location)legacy=legacy.eq('location',String(req.query.location).slice(0,100));
      const legacyResult=await legacy;
      if(!legacyResult.error && (legacyResult.data||[]).length){
        data=legacyResult.data;
        legacyExpiryRecovered=true;
      }
    }

    return res.json({products:await enrichSellerStats(data),offset,limit,hasMore:data.length===limit,legacyExpiryRecovered});
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
}catch(e){console.error('public-products:',e);return res.status(500).json({error:'Request failed'})}};
