self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || 'ChatWay';
  const options = {
    body: data.body || 'لديك رسالة جديدة',
    icon: data.icon || '/favicon.ico',
    badge: data.badge || '/favicon.ico',
    tag: data.tag || 'chatway-message',
    renotify: true,
    data: { url: data.url || '/', roomId: data.roomId || '' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification?.data?.url || '/';
  event.waitUntil((async()=>{
    const all = await clients.matchAll({type:'window', includeUncontrolled:true});
    for(const client of all){
      if('focus' in client){
        try { client.postMessage({type:'open_room', roomId:event.notification?.data?.roomId||''}); } catch {}
        await client.focus();
        return;
      }
    }
    if(clients.openWindow) return clients.openWindow(url);
  })());
});
