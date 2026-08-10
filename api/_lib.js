const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVER_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
const PI_API_BASE = (process.env.PI_API_BASE || 'https://api.minepi.com').replace(/\/$/, '');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

function assertEnv() {
  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVER_KEY) missing.push('SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)');
  if (!SUPABASE_PUBLISHABLE_KEY) missing.push('SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY)');
  if (!SUPABASE_JWT_SECRET) missing.push('SUPABASE_JWT_SECRET');
  if (missing.length) throw new Error('Missing environment variables: ' + missing.join(', '));
}

function serverHeaders(extra = {}) {
  // New sb_secret_* keys are opaque and belong in apikey. Legacy service_role is a JWT
  // and is also accepted in Authorization. Never expose either value to the browser.
  return {
    apikey: SUPABASE_SERVER_KEY,
    ...(SUPABASE_SERVER_KEY.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${SUPABASE_SERVER_KEY}` }),
    ...extra,
  };
}

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function allowMethods(req, res, methods) {
  if (methods.includes(req.method)) return true;
  res.setHeader('Allow', methods.join(', '));
  send(res, 405, { error: 'method_not_allowed' });
  return false;
}

function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

function b64url(input) { return Buffer.from(input).toString('base64url'); }

function signJwt(payload, expiresInSec = 3600) {
  assertEnv();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const claims = { aud: 'authenticated', role: 'authenticated', iat: now, exp: now + expiresInSec, iss: 'violet-pi-chat', ...payload };
  const encoded = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = crypto.createHmac('sha256', SUPABASE_JWT_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyJwt(token) {
  assertEnv();
  if (!token || typeof token !== 'string') throw new Error('missing_token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('invalid_token');
  const [h, p, s] = parts;
  const expected = crypto.createHmac('sha256', SUPABASE_JWT_SECRET).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, 'base64url');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) throw new Error('invalid_signature');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) throw new Error('token_expired');
  if (payload.role !== 'authenticated' || !payload.sub) throw new Error('invalid_claims');
  return payload;
}

function requireUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return verifyJwt(token);
}

async function verifyPiAccessToken(accessToken) {
  if (!accessToken) throw new Error('missing_pi_access_token');
  const r = await fetch(`${PI_API_BASE}/v2/me`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const e = new Error(r.status === 401 ? 'pi_unauthorized' : 'pi_api_error');
    e.status = r.status; e.detail = text.slice(0, 300); throw e;
  }
  const me = await r.json();
  if (!me || !me.uid || !me.username) throw new Error('pi_profile_incomplete');
  return me;
}

async function sb(path, { method = 'GET', data, headers = {} } = {}) {
  assertEnv();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: serverHeaders({
      Accept: 'application/json',
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    }),
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });
  const text = await r.text();
  let parsed = null;
  if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
  if (!r.ok) {
    const e = new Error('supabase_request_failed'); e.status = r.status; e.detail = parsed; throw e;
  }
  return parsed;
}

async function realtimeBroadcast(topic, event, payload) {
  assertEnv();
  const url = `${SUPABASE_URL}/realtime/v1/api/broadcast/${encodeURIComponent(topic)}/events/${encodeURIComponent(event)}?private=true`;
  const r = await fetch(url, { method: 'POST', headers: serverHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload || {}) });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    console.warn('realtime broadcast failed', r.status, detail.slice(0, 300));
    return false;
  }
  return true;
}

async function storageDelete(path) {
  if (!path) return true;
  assertEnv();
  const safePath = String(path).split('/').map(encodeURIComponent).join('/');
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/violet-delivery/${safePath}`, { method: 'DELETE', headers: serverHeaders() });
  if (!r.ok && r.status !== 404) {
    console.warn('storage delete failed', r.status, await r.text().catch(() => ''));
    return false;
  }
  return true;
}

function publicConfig() {
  assertEnv();
  return { supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_PUBLISHABLE_KEY, googleClientId: GOOGLE_CLIENT_ID };
}

function uuidList(ids) { return ids.filter(Boolean).join(','); }



module.exports = {
  send, allowMethods, body, signJwt, verifyJwt, requireUser,
  verifyPiAccessToken, sb, publicConfig, uuidList, realtimeBroadcast, storageDelete,
};
