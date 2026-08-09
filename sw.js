const VERSION='2026.08.09.1936';
const CACHE=`dealway-${VERSION}`;
const SHELL=['/','/offline.html','/app-icon.svg'];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).catch(()=>{}).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    const old=keys.filter(k=>k.startsWith('dealway-')&&k!==CACHE);
    await Promise.all(old.map(k=>caches.delete(k)));
    await self.clients.claim();
    const all=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of all){
      client.postMessage({type:'DW_SW_UPDATED',version:VERSION});
      if(old.length){try{await client.navigate(client.url)}catch{}}
    }
  })());
});

async function networkFirst(request,fallback){
  try{
    const response=await fetch(request,{cache:'no-store'});
    if(response&&response.ok){const c=await caches.open(CACHE);c.put(request,response.clone()).catch(()=>{})}
    return response;
  }catch{
    return (await caches.match(request)) || (fallback?await caches.match(fallback):Response.error());
  }
}

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const u=new URL(event.request.url);
  if(u.origin!==self.location.origin)return;
  if(u.pathname.startsWith('/api/'))return;
  if(u.pathname==='/sw.js'||u.pathname==='/version.json'){
    event.respondWith(fetch(event.request,{cache:'no-store'}));return;
  }
  const isCode=/\.(?:html|css|js|webmanifest)$/i.test(u.pathname)||!u.pathname.includes('.');
  if(isCode){event.respondWith(networkFirst(event.request,'/offline.html'));return}
  const isImage=/\.(?:svg|webp|png|jpg|jpeg|gif|ico|woff2?)$/i.test(u.pathname);
  if(isImage){
    event.respondWith((async()=>{const cached=await caches.match(event.request);const net=fetch(event.request).then(async r=>{if(r.ok){const c=await caches.open(CACHE);c.put(event.request,r.clone()).catch(()=>{})}return r}).catch(()=>null);return cached||(await net)||Response.error()})());
  }
});

self.addEventListener('push',e=>{let d={};try{d=e.data.json()}catch{};e.waitUntil(self.registration.showNotification(d.title||'DealWay',{body:d.body||'',icon:'/app-icon.svg',badge:'/app-icon.svg',data:{link:d.link||'/'}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();const link=e.notification.data?.link||'/';e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(ws=>{const w=ws[0];if(w){w.navigate(link);return w.focus()}return clients.openWindow(link)}))});
