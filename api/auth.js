const { send, allowMethods, body, signJwt, verifyPiAccessToken, sb, publicConfig } = require('./_lib');

module.exports = async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  try {
    const { accessToken } = body(req);
    const me = await verifyPiAccessToken(accessToken);
    const rows = await sb('app_users?on_conflict=pi_uid&select=id,pi_uid,username,created_at,last_seen_at', {
      method: 'POST',
      data: [{ pi_uid: me.uid, username: me.username, last_seen_at: new Date().toISOString() }],
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    });
    const user = Array.isArray(rows) ? rows[0] : null;
    if (!user) throw new Error('user_upsert_failed');
    const token = signJwt({ sub: user.id, pi_uid: user.pi_uid, username: user.username }, 86400);
    send(res, 200, { ok: true, token, user, ...publicConfig(), expiresIn: 86400 });
  } catch (e) {
    console.error('auth error', e);
    const status = e.message === 'pi_unauthorized' ? 401 : 500;
    send(res, status, { error: e.message || 'auth_failed', detail: e.detail || undefined });
  }
};
