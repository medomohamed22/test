'use strict';
const { createClient } = require('@supabase/supabase-js');
const { verifyPiUser } = require('./lib/security');

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

module.exports = async (req, res) => {
  noStore(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server database environment is not configured', code: 'SERVER_ENV_MISSING' });
  }

  try {
    const piUser = await verifyPiUser(req);
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
    );

    const { data, error } = await sb
      .from('app_users')
      .upsert(
        { pi_uid: piUser.uid, username: piUser.username, updated_at: new Date().toISOString() },
        { onConflict: 'pi_uid' }
      )
      .select('pi_uid,username,role,is_banned,telegram_chat_id,created_at')
      .single();

    if (error) throw error;
    return res.status(200).json({
      user: {
        uid: data.pi_uid,
        username: data.username,
        role: data.role,
        isBanned: data.is_banned,
        telegramLinked: Boolean(data.telegram_chat_id),
        createdAt: data.created_at,
      },
    });
  } catch (e) {
    const status = e.statusCode === 401 ? 401 : 500;
    return res.status(status).json({ error: e.message || 'Login failed', code: e.code || 'LOGIN_FAILED' });
  }
};
