const { createClient } = require('@supabase/supabase-js');
const { cleanText, imageMime, verifyPiUser } = require('./lib/security');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}});
function cors(res){res.setHeader('Access-Control-Allow-Origin',process.env.APP_ORIGIN||'https://deallway.vercel.app');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');}
function body(req){return typeof req.body==='string'?JSON.parse(req.body):req.body||{};}
module.exports=async(req,res)=>{cors(res);if(req.method==='OPTIONS')return res.status(204).end();
 try{
  const user=await verifyPiUser(req);
  await sb.from('app_users').upsert({pi_uid:user.uid,username:user.username,updated_at:new Date().toISOString()});
  if(req.method==='GET'){
   const {data,error}=await sb.from('products').select('*').eq('seller_pi_id',user.uid).order('created_at',{ascending:false});if(error)throw error;return res.json({products:data});
  }
  const b=body(req);
  if(req.method==='POST'){
   const name=cleanText(b.name,2,120,'name'), description=cleanText(b.description,10,3000,'description');
   const priceUsd=Number(b.priceUsd); if(!Number.isFinite(priceUsd)||priceUsd<=0||priceUsd>10000000)throw new Error('Invalid USD price');
   if(!Array.isArray(b.images)||b.images.length<1||b.images.length>3)throw new Error('1 to 3 images are required');
   const urls=[];
   for(let i=0;i<b.images.length;i++){
    const raw=String(b.images[i].data||'').replace(/^data:[^;]+;base64,/,''); const buf=Buffer.from(raw,'base64');
    if(buf.length<100||buf.length>2*1024*1024)throw new Error('Each image must be 2 MB or less');
    const mime=imageMime(buf); if(!mime)throw new Error('Only real JPEG, PNG, or WEBP images are allowed');
    const ext=mime==='image/jpeg'?'jpg':mime==='image/png'?'png':'webp'; const path=`${user.uid}/${crypto.randomUUID()}.${ext}`;
    const {error}=await sb.storage.from('product-images').upload(path,buf,{contentType:mime,upsert:false});if(error)throw error;
    urls.push(sb.storage.from('product-images').getPublicUrl(path).data.publicUrl);
   }
   const row={seller_pi_id:user.uid,seller_username:user.username,name,description,price_usd:priceUsd,category:cleanText(b.category,1,80,'category'),country:cleanText(b.country,2,80,'country'),location:cleanText(b.location,1,120,'location'),images:urls,status:'pending'};
   const {data,error}=await sb.from('products').insert(row).select().single();if(error)throw error;return res.status(201).json({product:data});
  }
  const id=Number(b.id);if(!Number.isInteger(id)||id<1)throw new Error('Invalid product id');
  const {data:owned}=await sb.from('products').select('id,status').eq('id',id).eq('seller_pi_id',user.uid).maybeSingle();if(!owned)return res.status(404).json({error:'Not found'});
  if(req.method==='DELETE'){const {error}=await sb.from('products').delete().eq('id',id).eq('seller_pi_id',user.uid);if(error)throw error;return res.json({success:true});}
  if(req.method==='PATCH'){
   const patch={status:'pending',reviewed_at:null,reviewed_by:null,rejection_reason:null};
   if(b.name!==undefined)patch.name=cleanText(b.name,2,120,'name');if(b.description!==undefined)patch.description=cleanText(b.description,10,3000,'description');
   if(b.priceUsd!==undefined){const p=Number(b.priceUsd);if(!Number.isFinite(p)||p<=0)throw new Error('Invalid price');patch.price_usd=p;}
   const {data,error}=await sb.from('products').update(patch).eq('id',id).eq('seller_pi_id',user.uid).select().single();if(error)throw error;return res.json({product:data});
  }
  return res.status(405).json({error:'Method not allowed'});
 }catch(e){console.error(e);return res.status(400).json({error:e.message});}
};
