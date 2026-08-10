const { send, allowMethods, requireUser, sb } = require('./_lib');

module.exports = async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    const me = requireUser(req);
    const raw = String(req.query?.q || '').trim();
    if (raw.length < 2) return send(res, 200, { users: [] });
    const q = raw.replace(/[,%()]/g, '').slice(0, 30);
    const rows = await sb(`app_users?username=ilike.*${encodeURIComponent(q)}*&id=neq.${me.sub}&select=id,username,last_seen_at&order=username.asc&limit=20`);
    send(res, 200, { users: rows || [] });
  } catch (e) {
    console.error('users error', e);
    send(res, /token|signature|claims/.test(e.message) ? 401 : 500, { error: e.message || 'users_failed' });
  }
};
