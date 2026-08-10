const { send, allowMethods, body, requireUser, sb, uuidList, realtimeBroadcast } = require('./_lib');

async function hydrateRooms(userId) {
  const mine = await sb(`room_members?user_id=eq.${userId}&select=room_id,role`);
  const ids = (mine || []).map(x => x.room_id);
  if (!ids.length) return [];
  const inIds = uuidList(ids);
  const [rooms, memberships, groupRows] = await Promise.all([
    sb(`rooms?id=in.(${inIds})&select=id,kind,created_by,created_at&order=created_at.desc`),
    sb(`room_members?room_id=in.(${inIds})&select=room_id,user_id,role`),
    sb(`groups?room_id=in.(${inIds})&select=room_id,name,description,avatar_url,only_admins_send,only_admins_edit,only_admins_add,join_approval,invite_code,invite_expires_at,invite_max_uses,invite_uses,created_at`),
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
      groupSettings: group ? {
        onlyAdminsSend: !!group.only_admins_send,
        onlyAdminsEdit: !!group.only_admins_edit,
        onlyAdminsAdd: !!group.only_admins_add,
        joinApproval: !!group.join_approval,
        inviteCode: group.invite_code || null,
        inviteExpiresAt: group.invite_expires_at || null,
        inviteMaxUses: group.invite_max_uses ?? null,
        inviteUses: group.invite_uses || 0,
      } : null,
      myRole: (members.find(m=>m.user_id===userId)||{}).role || 'member',
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
    const action = String(b.action || '');

    async function membership(roomId){
      const rows=await sb(`room_members?room_id=eq.${encodeURIComponent(roomId)}&user_id=eq.${encodeURIComponent(me.sub)}&select=role&limit=1`);
      return rows?.[0]||null;
    }
    async function groupRow(roomId){
      const rows=await sb(`groups?room_id=eq.${encodeURIComponent(roomId)}&select=*&limit=1`);
      return rows?.[0]||null;
    }
    async function notifyRoom(roomId){
      const ms=await sb(`room_members?room_id=eq.${encodeURIComponent(roomId)}&select=user_id`);
      await Promise.allSettled((ms||[]).map(x=>realtimeBroadcast(`user:${x.user_id}`,'room_changed',{roomId,by:me.sub})));
      return (ms||[]).map(x=>x.user_id);
    }

    if(action==='group_settings'){
      const roomId=String(b.roomId||''), mem=await membership(roomId);
      if(!mem||!['owner','admin'].includes(mem.role))return send(res,403,{error:'admin_required'});
      const current=await groupRow(roomId);if(!current)return send(res,404,{error:'group_not_found'});
      const patch={};
      if(typeof b.name==='string'&&b.name.trim())patch.name=b.name.trim().slice(0,80);
      if(typeof b.description==='string')patch.description=b.description.trim().slice(0,240);
      if(typeof b.onlyAdminsSend==='boolean')patch.only_admins_send=b.onlyAdminsSend;
      if(typeof b.onlyAdminsEdit==='boolean')patch.only_admins_edit=b.onlyAdminsEdit;
      if(typeof b.onlyAdminsAdd==='boolean')patch.only_admins_add=b.onlyAdminsAdd;
      if(typeof b.joinApproval==='boolean')patch.join_approval=b.joinApproval;
      if(Object.keys(patch).length)await sb(`groups?room_id=eq.${encodeURIComponent(roomId)}`,{method:'PATCH',data:patch,headers:{Prefer:'return=minimal'}});
      affected=await notifyRoom(roomId);
    } else if(action==='member_role'){
      const roomId=String(b.roomId||''), target=String(b.userId||''), role=String(b.role||'member');
      const mem=await membership(roomId);if(!mem||mem.role!=='owner')return send(res,403,{error:'owner_required'});
      if(!['admin','member'].includes(role))return send(res,400,{error:'invalid_role'});
      await sb(`room_members?room_id=eq.${encodeURIComponent(roomId)}&user_id=eq.${encodeURIComponent(target)}`,{method:'PATCH',data:{role},headers:{Prefer:'return=minimal'}});
      affected=await notifyRoom(roomId);
    } else if(action==='invite_create'){
      const roomId=String(b.roomId||''),mem=await membership(roomId);
      if(!mem||!['owner','admin'].includes(mem.role))return send(res,403,{error:'admin_required'});
      const code=require('crypto').randomBytes(18).toString('base64url');
      const hours=Math.max(0,Math.min(720,Number(b.expiresHours)||0));
      const maxUses=Math.max(0,Math.min(10000,Number(b.maxUses)||0));
      const patch={invite_code:code,invite_uses:0,invite_expires_at:hours?new Date(Date.now()+hours*3600000).toISOString():null,invite_max_uses:maxUses||null};
      await sb(`groups?room_id=eq.${encodeURIComponent(roomId)}`,{method:'PATCH',data:patch,headers:{Prefer:'return=minimal'}});
      affected=await notifyRoom(roomId);
    } else if(action==='invite_reset'){
      const roomId=String(b.roomId||''),mem=await membership(roomId);
      if(!mem||!['owner','admin'].includes(mem.role))return send(res,403,{error:'admin_required'});
      await sb(`groups?room_id=eq.${encodeURIComponent(roomId)}`,{method:'PATCH',data:{invite_code:null,invite_expires_at:null,invite_max_uses:null,invite_uses:0},headers:{Prefer:'return=minimal'}});
      affected=await notifyRoom(roomId);
    } else if(action==='join_by_invite'){
      const code=String(b.code||'').trim();
      const rows=await sb(`groups?invite_code=eq.${encodeURIComponent(code)}&select=room_id,join_approval,invite_expires_at,invite_max_uses,invite_uses&limit=1`);
      const g=rows?.[0];if(!g)return send(res,404,{error:'invalid_invite'});
      if(g.invite_expires_at&&Date.parse(g.invite_expires_at)<Date.now())return send(res,410,{error:'invite_expired'});
      if(g.invite_max_uses&&g.invite_uses>=g.invite_max_uses)return send(res,410,{error:'invite_exhausted'});
      const already=await membership(g.room_id);if(already)return send(res,200,{ok:true,status:'already_member',rooms:await hydrateRooms(me.sub)});
      if(g.join_approval){
        await sb('group_join_requests?on_conflict=room_id,user_id',{method:'POST',data:[{room_id:g.room_id,user_id:me.sub,status:'pending'}],headers:{Prefer:'resolution=merge-duplicates,return=minimal'}});
        affected=await notifyRoom(g.room_id);
        return send(res,200,{ok:true,status:'pending'});
      }
      await sb('room_members',{method:'POST',data:[{room_id:g.room_id,user_id:me.sub,role:'member'}],headers:{Prefer:'return=minimal'}});
      await sb(`groups?room_id=eq.${encodeURIComponent(g.room_id)}`,{method:'PATCH',data:{invite_uses:(g.invite_uses||0)+1},headers:{Prefer:'return=minimal'}});
      affected=await notifyRoom(g.room_id);affected.push(me.sub);
    } else if(action==='join_requests'){
      const roomId=String(b.roomId||''),mem=await membership(roomId);
      if(!mem||!['owner','admin'].includes(mem.role))return send(res,403,{error:'admin_required'});
      const reqs=await sb(`group_join_requests?room_id=eq.${encodeURIComponent(roomId)}&status=eq.pending&select=id,user_id,created_at&order=created_at.asc`);
      const ids=[...new Set((reqs||[]).map(x=>x.user_id))];
      const us=ids.length?await sb(`app_users?id=in.(${uuidList(ids)})&select=id,username`):[];
      const um=Object.fromEntries((us||[]).map(u=>[u.id,u]));
      return send(res,200,{requests:(reqs||[]).map(x=>({...x,username:um[x.user_id]?.username||'Pi'}))});
    } else if(action==='join_request_action'){
      const roomId=String(b.roomId||''),requestId=Number(b.requestId),decision=String(b.decision||'');
      const mem=await membership(roomId);if(!mem||!['owner','admin'].includes(mem.role))return send(res,403,{error:'admin_required'});
      const rr=await sb(`group_join_requests?id=eq.${requestId}&room_id=eq.${encodeURIComponent(roomId)}&status=eq.pending&select=id,user_id&limit=1`);
      const reqRow=rr?.[0];if(!reqRow)return send(res,404,{error:'request_not_found'});
      if(decision==='approve'){
        await sb('room_members',{method:'POST',data:[{room_id:roomId,user_id:reqRow.user_id,role:'member'}],headers:{Prefer:'return=minimal'}});
        await sb(`group_join_requests?id=eq.${requestId}`,{method:'PATCH',data:{status:'approved'},headers:{Prefer:'return=minimal'}});
      }else{
        await sb(`group_join_requests?id=eq.${requestId}`,{method:'PATCH',data:{status:'rejected'},headers:{Prefer:'return=minimal'}});
      }
      affected=await notifyRoom(roomId);affected.push(reqRow.user_id);
    } else if (b.kind === 'direct') {
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
      return send(res, 400, { error: 'invalid_room_action' });
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
