const { send, allowMethods, body, requireUser, sb } = require('./_lib');

module.exports = async function handler(req,res){
  if(!allowMethods(req,res,['POST'])) return;
  try{
    const me=requireUser(req), b=body(req), action=String(b.action||'subscribe');
    if(action==='unsubscribe'){
      const endpoint=String(b.endpoint||'');
      if(endpoint) await sb(`push_subscriptions?user_id=eq.${encodeURIComponent(me.sub)}&endpoint=eq.${encodeURIComponent(endpoint)}`,{method:'DELETE'});
      return send(res,200,{ok:true});
    }
    const sub=b.subscription||{};
    const endpoint=String(sub.endpoint||'').slice(0,1600);
    const p256dh=String(sub.keys?.p256dh||'').slice(0,500);
    const authKey=String(sub.keys?.auth||'').slice(0,300);
    if(!endpoint||!p256dh||!authKey)return send(res,400,{error:'invalid_subscription'});
    await sb('push_subscriptions?on_conflict=endpoint',{
      method:'POST',
      data:[{user_id:me.sub,endpoint,p256dh,auth_key:authKey,user_agent:String(req.headers['user-agent']||'').slice(0,300),updated_at:new Date().toISOString()}],
      headers:{Prefer:'resolution=merge-duplicates,return=minimal'}
    });
    send(res,200,{ok:true});
  }catch(e){
    console.error('push error',e,e.detail||'');
    send(res,/token|signature|claims/.test(e.message)?401:(e.status||500),{error:e.message||'push_failed',detail:e.detail||undefined});
  }
};
