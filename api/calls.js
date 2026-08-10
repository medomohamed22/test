const { send, allowMethods, body, requireUser, sb, realtimeBroadcast } = require('./_lib');

const DAILY_API_KEY = process.env.DAILY_API_KEY || '';
const DAILY_API = 'https://api.daily.co/v1';

async function daily(path, options = {}) {
  if (!DAILY_API_KEY) throw new Error('missing_DAILY_API_KEY');
  const res = await fetch(`${DAILY_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${DAILY_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const e = new Error(data?.info || data?.error || 'daily_request_failed');
    e.status = res.status;
    e.detail = data;
    throw e;
  }
  return data;
}

async function roomMembership(roomId, userId) {
  const rows = await sb(`room_members?room_id=eq.${encodeURIComponent(roomId)}&user_id=eq.${encodeURIComponent(userId)}&select=role&limit=1`);
  return rows?.[0] || null;
}

async function roomMembers(roomId) {
  const rows = await sb(`room_members?room_id=eq.${encodeURIComponent(roomId)}&select=user_id,role`);
  return rows || [];
}

function dailyName(roomId) {
  return `cw_${String(roomId).replace(/-/g,'').slice(0,20)}_${require('crypto').randomBytes(7).toString('hex')}`;
}

function belongsToRoomName(roomId, roomName) {
  const prefix = `cw_${String(roomId).replace(/-/g,'').slice(0,20)}_`;
  return String(roomName || '').startsWith(prefix);
}

async function createMeetingToken(roomName, me, type) {
  const exp = Math.floor(Date.now()/1000) + 60 * 60 * 3;
  const d = await daily('/meeting-tokens', {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        room_name: roomName,
        exp,
        user_name: '@' + String(me.username || 'Pi').slice(0, 90),
        user_id: String(me.sub).slice(0, 36),
        start_video_off: type === 'audio',
        start_audio_off: false,
        enable_screenshare: false
      }
    })
  });
  return d.token;
}

module.exports = async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  try {
    const me = requireUser(req);
    const b = body(req);
    const action = String(b.action || '');
    const appRoomId = String(b.roomId || '');
    const type = b.type === 'video' ? 'video' : 'audio';

    if (!appRoomId) return send(res, 400, { error: 'room_required' });
    const membership = await roomMembership(appRoomId, me.sub);
    if (!membership) return send(res, 403, { error: 'not_room_member' });

    const members = await roomMembers(appRoomId);
    const recipientIds = members.map(x=>x.user_id).filter(x=>x !== me.sub);

    if (action === 'start') {
      const roomName = dailyName(appRoomId);
      const exp = Math.floor(Date.now()/1000) + 60 * 60 * 2;
      const created = await daily('/rooms', {
        method: 'POST',
        body: JSON.stringify({
          name: roomName,
          privacy: 'private',
          properties: {
            exp,
            start_video_off: type === 'audio',
            start_audio_off: false,
            enable_chat: false,
            enable_screenshare: false,
            max_participants: Math.max(2, Math.min(200, members.length || 2))
          }
        })
      });
      const token = await createMeetingToken(roomName, me, type);
      const callId = require('crypto').randomUUID();
      const invite = {
        callId,
        roomId: appRoomId,
        dailyRoomName: roomName,
        dailyUrl: created.url,
        type,
        callerId: me.sub,
        callerUsername: me.username || 'Pi',
        startedAt: Date.now()
      };
      await Promise.allSettled(recipientIds.map(uid =>
        realtimeBroadcast(`user:${uid}`, 'call_invite', invite)
      ));
      return send(res, 200, { ok:true, ...invite, token });
    }

    if (action === 'join') {
      const roomName = String(b.dailyRoomName || '');
      const dailyUrl = String(b.dailyUrl || '');
      if (!belongsToRoomName(appRoomId, roomName)) return send(res, 400, { error: 'invalid_call_room' });
      const token = await createMeetingToken(roomName, me, type);
      return send(res, 200, { ok:true, token, dailyUrl, dailyRoomName:roomName, type });
    }

    if (action === 'event') {
      const event = String(b.event || '');
      const allowed = new Set(['ringing','accepted','rejected','ended','busy']);
      if (!allowed.has(event)) return send(res, 400, { error:'invalid_call_event' });
      const payload = {
        event,
        callId: String(b.callId || ''),
        roomId: appRoomId,
        dailyRoomName: String(b.dailyRoomName || ''),
        type,
        byUserId: me.sub,
        byUsername: me.username || 'Pi',
        at: Date.now()
      };
      const targets = b.targetUserId
        ? recipientIds.filter(x=>x===String(b.targetUserId))
        : recipientIds;
      await Promise.allSettled(targets.map(uid =>
        realtimeBroadcast(`user:${uid}`, 'call_event', payload)
      ));
      return send(res, 200, { ok:true });
    }

    return send(res, 400, { error:'invalid_call_action' });
  } catch (e) {
    console.error('calls error', e, e.detail || '');
    const status = /token|claims|signature/.test(e.message) ? 401 : (e.status || 500);
    send(res, status, { error:e.message || 'calls_failed', detail:e.detail || undefined });
  }
};
