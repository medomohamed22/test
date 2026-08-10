const { send, allowMethods, body, requireUser, sb, realtimeBroadcast, storageDelete } = require('./_lib');

async function assertRoomMember(userId, roomId) {
  const rows = await sb(`room_members?room_id=eq.${encodeURIComponent(roomId)}&user_id=eq.${encodeURIComponent(userId)}&select=room_id&limit=1`);
  if (!rows?.length) {
    const e = new Error('not_room_member'); e.status = 403; throw e;
  }
}

async function recipientsFor(roomId, senderId) {
  const rows = await sb(`room_members?room_id=eq.${encodeURIComponent(roomId)}&user_id=neq.${encodeURIComponent(senderId)}&select=user_id`);
  return [...new Set((rows || []).map(x => x.user_id).filter(Boolean))];
}

async function enqueue(me, b) {
  const roomId = String(b.roomId || '');
  const clientId = String(b.clientId || '').slice(0, 120);
  const payload = b.payload && typeof b.payload === 'object' ? b.payload : null;
  const storagePath = b.storagePath ? String(b.storagePath).slice(0, 600) : null;
  if (!roomId || !clientId || !payload) throw Object.assign(new Error('invalid_delivery'), { status: 400 });
  await assertRoomMember(me.sub, roomId);
  const recipients = await recipientsFor(roomId, me.sub);
  if (!recipients.length) return { queued: 0 };

  const rows = recipients.map(recipientId => ({
    room_id: roomId,
    sender_id: me.sub,
    recipient_id: recipientId,
    client_id: clientId,
    payload,
    storage_path: storagePath,
  }));
  await sb('pending_deliveries?on_conflict=recipient_id,client_id', {
    method: 'POST',
    data: rows,
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
  });

  await Promise.allSettled(recipients.map(uid => realtimeBroadcast(`user:${uid}`, 'delivery_available', { roomId, clientId })));
  return { queued: recipients.length };
}

async function pull(me) {
  // Expired text envelopes are removed opportunistically. Media objects are removed after ACK;
  // stale storage can be cleaned separately if you choose a shorter retention policy.
  await sb(`pending_deliveries?recipient_id=eq.${encodeURIComponent(me.sub)}&expires_at=lt.${encodeURIComponent(new Date().toISOString())}`, { method: 'DELETE' }).catch(() => {});
  const rows = await sb(`pending_deliveries?recipient_id=eq.${encodeURIComponent(me.sub)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=id,room_id,sender_id,client_id,payload,storage_path,created_at&order=created_at.asc&limit=100`);
  return { deliveries: rows || [] };
}

async function ack(me, b) {
  const clientId = String(b.clientId || '').slice(0, 120);
  const roomId = String(b.roomId || '');
  if (!clientId || !roomId) throw Object.assign(new Error('invalid_ack'), { status: 400 });
  const rows = await sb(`pending_deliveries?recipient_id=eq.${encodeURIComponent(me.sub)}&room_id=eq.${encodeURIComponent(roomId)}&client_id=eq.${encodeURIComponent(clientId)}&select=id,sender_id,storage_path`);
  if (!rows?.length) return { ok: true, alreadyAcked: true };
  const senderId = rows[0].sender_id;
  const paths = [...new Set(rows.map(x => x.storage_path).filter(Boolean))];
  await sb(`pending_deliveries?recipient_id=eq.${encodeURIComponent(me.sub)}&room_id=eq.${encodeURIComponent(roomId)}&client_id=eq.${encodeURIComponent(clientId)}`, { method: 'DELETE' });

  for (const path of paths) {
    const remain = await sb(`pending_deliveries?storage_path=eq.${encodeURIComponent(path)}&select=id&limit=1`);
    if (!remain?.length) await storageDelete(path);
  }
  await realtimeBroadcast(`user:${senderId}`, 'delivery_receipt', { roomId, clientId, status: 'delivered' }).catch(() => {});
  return { ok: true };
}

module.exports = async function handler(req, res) {
  if (!allowMethods(req, res, ['GET', 'POST'])) return;
  try {
    const me = requireUser(req);
    if (req.method === 'GET') return send(res, 200, await pull(me));
    const b = body(req);
    if (b.action === 'enqueue') return send(res, 200, await enqueue(me, b));
    if (b.action === 'ack') return send(res, 200, await ack(me, b));
    return send(res, 400, { error: 'invalid_action' });
  } catch (e) {
    console.error('messages error', e, e.detail || '');
    send(res, e.status || (/token|signature|claims/.test(e.message) ? 401 : 500), { error: e.message || 'messages_failed', detail: e.detail || undefined });
  }
};
