const {createClient}=require('@supabase/supabase-js');
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

const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
async function admin(req){const u=await verifyPiUser(req);const {data}=await sb.from('app_users').select('role').eq('pi_uid',u.uid).single();if(data?.role!=='admin')throw new Error('Forbidden');return u;}
module.exports=async(req,res)=>{try{const u=await admin(req);if(req.method==='GET'){const {data,error}=await sb.from('products').select('*').eq('status','pending').order('created_at');if(error)throw error;return res.json({products:data});}if(req.method==='POST'){const b=typeof req.body==='string'?JSON.parse(req.body):req.body||{};const id=Number(b.id),action=String(b.action);if(!['approve','reject'].includes(action))throw new Error('Invalid action');const patch={status:action==='approve'?'approved':'rejected',reviewed_by:u.uid,reviewed_at:new Date().toISOString(),rejection_reason:action==='reject'?cleanText(b.reason||'Not approved',2,500,'reason'):null};const {data,error}=await sb.from('products').update(patch).eq('id',id).eq('status','pending').select().single();if(error)throw error;return res.json({product:data});}return res.status(405).json({error:'Method not allowed'});}catch(e){return res.status(e.message==='Forbidden'?403:400).json({error:e.message});}};
