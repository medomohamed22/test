const { createClient } = require('@supabase/supabase-js');
function cleanText(value, min, max, field) {
  const s = String(value || '').normalize('NFKC').trim();
  if (s.length < min || s.length > max) throw new Error(`${field} length is invalid`);
  if (/<[^>]*>|javascript:|data:text\/html|on\w+\s*=/i.test(s)) throw new Error(`${field} contains forbidden content`);
  return s.replace(/[\u0000-\u001F\u007F]/g, ' ');
}

function imageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff]))) return 'image/jpeg';
  if (buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WEBP') return 'image/webp';
  return null;
}

async function verifyPiUser(req) {
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) {
    const err = new Error('Missing Pi access token');
    err.statusCode = 401;
    err.code = 'PI_TOKEN_MISSING';
    throw err;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('https://api.minepi.com/v2/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${match[1]}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.uid || !body.username) {
      const err = new Error(body.error || body.message || 'Invalid Pi access token');
      err.statusCode = 401;
      err.code = 'PI_TOKEN_INVALID';
      throw err;
    }
    return { uid: String(body.uid), username: String(body.username) };
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('Pi authentication service timed out');
      err.statusCode = 503;
      err.code = 'PI_AUTH_TIMEOUT';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

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
    const {data:target}=await sb.from('app_users').select('telegram_chat_id').eq('pi_uid',receiver).maybeSingle();
    if(target?.telegram_chat_id&&process.env.TELEGRAM_BOT_TOKEN){fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:target.telegram_chat_id,text:`رسالة جديدة على ${p.name} من ${u.username}:\n${content.slice(0,400)}`})}).catch(e=>console.error('telegram notify:',e.message));}
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
