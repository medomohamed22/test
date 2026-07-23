'use strict';
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

  if (String(req.query?.health || '') === '1') {
    return res.status(200).json({
      ok: true,
      sessionRoute: true,
      databaseEnv: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
      piEnv: Boolean(process.env.PI_API_KEY),
      telegramEnv: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    });
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
