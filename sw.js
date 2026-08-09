const CACHE='dealway-v9-shell';
const SHELL=['/','/pages.css','/home-v9.css','/common.js','/offline.html','/app-icon.svg'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const u=new URL(e.request.url);
  if(u.pathname.startsWith('/api/'))return;
  const isAsset=/\.(?:css|js|svg|webp|png|jpg|jpeg|woff2?)$/i.test(u.pathname);
  if(isAsset){
    e.respondWith(caches.match(e.request).then(cached=>{const network=fetch(e.request).then(r=>{if(r.ok)caches.open(CACHE).then(c=>c.put(e.request,r.clone()));return r}).catch(()=>cached);return cached||network}));
    return;
  }
  e.respondWith(fetch(e.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy)).catch(()=>{});return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('/offline.html'))));
});
self.addEventListener('push',e=>{let d={};try{d=e.data.json()}catch{};e.waitUntil(self.registration.showNotification(d.title||'DealWay',{body:d.body||'',icon:'/app-icon.svg',badge:'/app-icon.svg',data:{link:d.link||'/'}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();const link=e.notification.data?.link||'/';e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(ws=>{const w=ws[0];if(w){w.navigate(link);return w.focus()}return clients.openWindow(link)}))});
