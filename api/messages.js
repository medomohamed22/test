const { createClient } = require('@supabase/supabase-js');
const { cleanText, verifyPiUser } = require('./lib/security');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
module.exports = async (req,res) => {
 try {
  const u = await verifyPiUser(req);
  await sb.from('app_users').upsert({pi_uid:u.uid,username:u.username,updated_at:new Date().toISOString()},{onConflict:'pi_uid'});
  const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  if(req.method==='GET') {
    const productId = b.productId || req.query?.productId;
    let q=sb.from('messages').select('id,product_id,sender_pi_id,receiver_pi_id,content,is_read,created_at,products(name)').or(`sender_pi_id.eq.${u.uid},receiver_pi_id.eq.${u.uid}`).order('created_at',{ascending:true});
    if(productId) q=q.eq('product_id',Number(productId));
    const {data,error}=await q;if(error)throw error;
    const ids=[...new Set((data||[]).flatMap(m=>[m.sender_pi_id,m.receiver_pi_id]))];
    const {data:people}=ids.length?await sb.from('app_users').select('pi_uid,username').in('pi_uid',ids):{data:[]};
    const names=Object.fromEntries((people||[]).map(x=>[x.pi_uid,x.username]));
    return res.json({messages:(data||[]).map(m=>({...m,sender_username:names[m.sender_pi_id]||'User',receiver_username:names[m.receiver_pi_id]||'User'}))});
  }
  if(req.method==='POST') {
    const productId=Number(b.productId), receiver=String(b.receiverPiId||''); const content=cleanText(b.content,1,2000,'message');
    const {data:p}=await sb.from('products').select('id,seller_pi_id,status,name').eq('id',productId).single();
    if(!p||p.status!=='approved') throw new Error('Product unavailable');
    if(receiver===u.uid || (p.seller_pi_id!==receiver && p.seller_pi_id!==u.uid)) throw new Error('Invalid chat target');
    const {data,error}=await sb.from('messages').insert({product_id:productId,sender_pi_id:u.uid,receiver_pi_id:receiver,content}).select().single();if(error)throw error;
    return res.status(201).json({message:data});
  }
  if(req.method==='PATCH') {
    const productId=Number(b.productId), other=String(b.otherPiId||'');
    const {error}=await sb.from('messages').update({is_read:true}).eq('product_id',productId).eq('receiver_pi_id',u.uid).eq('sender_pi_id',other);if(error)throw error;
    return res.json({success:true});
  }
  return res.status(405).json({error:'Method not allowed'});
 } catch(e) { return res.status(400).json({error:e.message}); }
};
