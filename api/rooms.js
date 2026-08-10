const { send, allowMethods, body, requireUser, sb, uuidList, realtimeBroadcast } = require('./_lib');

async function hydrateRooms(userId) {
  const mine = await sb(`room_members?user_id=eq.${userId}&select=room_id,role`);
  const ids = (mine || []).map(x => x.room_id);
  if (!ids.length) return [];
  const inIds = uuidList(ids);
  const [rooms, memberships, groupRows] = await Promise.all([
    sb(`rooms?id=in.(${inIds})&select=id,kind,created_by,created_at&order=created_at.desc`),
    sb(`room_members?room_id=in.(${inIds})&select=room_id,user_id,role`),
    sb(`groups?room_id=in.(${inIds})&select=room_id,name,description,avatar_url,created_at`),
  ]);
  const userIds = [...new Set((memberships || []).map(x => x.user_id))];
  const users = userIds.length ? await sb(`app_users?id=in.(${uuidList(userIds)})&select=id,username,last_seen_at`) : [];
  const userMap = Object.fromEntries((users || []).map(u => [u.id, u]));
  const groupMap = Object.fromEntries((groupRows || []).map(g => [g.room_id, g]));
  return (rooms || []).map(r => {
    const members = (memberships || []).filter(m => m.room_id === r.id).map(m => ({ ...m, ...(userMap[m.user_id] || {}) }));
    const group = groupMap[r.id] || null;
    const other = r.kind === 'direct' ? members.find(m => m.user_id !== userId) : null;
    return {
      id: r.id,
      topic: `room:${r.id}`,
      kind: r.kind,
      createdAt: r.created_at,
      createdBy: r.created_by,
      name: r.kind === 'group' ? (group?.name || 'مجموعة') : (other?.username || 'مستخدم Pi'),
      description: group?.description || '',
      avatarUrl: group?.avatar_url || null,
      members,
    };
  });
}

module.exports = async function handler(req, res) {
  if (!allowMethods(req, res, ['GET', 'POST'])) return;
  try {
    const me = requireUser(req);
    if (req.method === 'GET') return send(res, 200, { rooms: await hydrateRooms(me.sub) });

    const b = body(req);
    let affected = [];
    if (b.kind === 'direct') {
      const peerId = String(b.peerId || '');
      if (!peerId || peerId === me.sub) return send(res, 400, { error: 'invalid_peer' });
      const peer = await sb(`app_users?id=eq.${peerId}&select=id&limit=1`);
      if (!peer?.length) return send(res, 404, { error: 'peer_not_found' });
      await sb('rpc/api_create_direct_room', { method: 'POST', data: { p_creator: me.sub, p_peer: peerId } });
      affected = [me.sub, peerId];
    } else if (b.kind === 'group') {
      const name = String(b.name || '').trim().slice(0, 80);
      const description = String(b.description || '').trim().slice(0, 240);
      const memberIds = Array.isArray(b.memberIds) ? [...new Set(b.memberIds.map(String))] : [];
      if (!name) return send(res, 400, { error: 'group_name_required' });
      await sb('rpc/api_create_group', { method: 'POST', data: { p_creator: me.sub, p_name: name, p_description: description, p_members: memberIds } });
      affected = [me.sub, ...memberIds];
    } else {
      return send(res, 400, { error: 'invalid_room_kind' });
    }

    await Promise.allSettled([...new Set(affected)].map(uid =>
      realtimeBroadcast(`user:${uid}`, 'room_changed', { by: me.sub })
    ));
    send(res, 200, { ok: true, rooms: await hydrateRooms(me.sub) });
  } catch (e) {
    console.error('rooms error', e, e.detail || '');
    send(res, /token|signature|claims/.test(e.message) ? 401 : 500, { error: e.message || 'rooms_failed', detail: e.detail || undefined });
  }
};
