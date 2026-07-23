const { createClient } = require('@supabase/supabase-js');
const { verifyPiUser } = require('./lib/security');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
module.exports = async (req,res) => {
  if(req.method !== 'GET') return res.status(405).json({error:'Method not allowed'});
  try {
    const u = await verifyPiUser(req);
    const { data, error } = await sb.from('app_users').upsert({pi_uid:u.uid,username:u.username,updated_at:new Date().toISOString()},{onConflict:'pi_uid'}).select('pi_uid,username,role,is_banned,telegram_chat_id,created_at').single();
    if(error) throw error;
    return res.json({user:{uid:data.pi_uid,username:data.username,role:data.role,isBanned:data.is_banned,telegramLinked:!!data.telegram_chat_id,createdAt:data.created_at}});
  } catch(e) { return res.status(401).json({error:e.message}); }
};
