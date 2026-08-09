const DW_APP_VERSION='2026.08.09.1936';
window.DW_APP_VERSION=DW_APP_VERSION;

const DW={
  locale:localStorage.getItem('dw_locale')||((navigator.language||'ar').startsWith('ar')?'ar':'en'),
  currency:localStorage.getItem('dw_currency')||'USD',
  t:{
    ar:{home:'الرئيسية',chats:'الرسائل',sell:'بيع',favorites:'المفضلة',account:'حسابي',search:'بحث',dashboard:'لوحة البائع',settings:'الإعدادات',install:'تثبيت التطبيق',notifications:'الإشعارات'},
    en:{home:'Home',chats:'Chats',sell:'Sell',favorites:'Favorites',account:'Account',search:'Search',dashboard:'Seller dashboard',settings:'Settings',install:'Install app',notifications:'Notifications'}
  },
  tr(k){return this.t[this.locale]?.[k]||this.t.ar[k]||k},
  apply(){document.documentElement.lang=this.locale;document.documentElement.dir=this.locale==='ar'?'rtl':'ltr';document.querySelectorAll('[data-i18n]').forEach(el=>{const v=this.tr(el.dataset.i18n);if(v)el.textContent=v})},
  setLocale(v){localStorage.setItem('dw_locale',v);this.locale=v;this.apply()},
  setCurrency(v){localStorage.setItem('dw_currency',v);this.currency=v;location.reload()},
  money(usd,pi){if(this.currency==='PI')return `${Number(pi||0).toLocaleString(undefined,{maximumFractionDigits:4})} π`;return new Intl.NumberFormat(this.locale==='ar'?'ar-EG':'en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(Number(usd||0))}
};
window.DW=DW;

function ensureShell(){
  if(!document.body)return;
  if(!document.getElementById('dw-page-progress')){
    document.body.insertAdjacentHTML('afterbegin','<div id="dw-page-progress" class="dw-page-progress" aria-hidden="true"><i></i></div><div id="dw-global-loader" class="dw-global-loader" hidden aria-hidden="true"><div class="dw-loader-card"><span class="dw-spinner"></span><b id="dw-loader-label">جاري التحميل...</b></div></div>');
  }
}

let dwLoaderFailsafe=0;
function forceUnlockUI(){
  const x=document.getElementById('dw-global-loader');
  if(x){x.classList.remove('show');x.hidden=true;x.setAttribute('aria-hidden','true');x.style.pointerEvents='none'}
  document.documentElement.classList.remove('dw-ui-locked');
  document.body?.classList.remove('dw-ui-locked');
}

window.DWLoading={
  show(label='جاري التحميل...'){
    ensureShell();
    const x=document.getElementById('dw-global-loader');
    const l=document.getElementById('dw-loader-label');
    if(!x)return;
    if(l)l.textContent=label;
    x.hidden=false;x.setAttribute('aria-hidden','false');x.style.pointerEvents='auto';
    requestAnimationFrame(()=>x.classList.add('show'));
    clearTimeout(dwLoaderFailsafe);
    dwLoaderFailsafe=setTimeout(forceUnlockUI,12000);
  },
  hide(){clearTimeout(dwLoaderFailsafe);forceUnlockUI()},
  progress(){ensureShell();const p=document.getElementById('dw-page-progress');if(!p)return;p.classList.remove('done');p.classList.add('active')},
  done(){forceUnlockUI();const p=document.getElementById('dw-page-progress');if(!p)return;p.classList.add('done');setTimeout(()=>p.classList.remove('active','done'),240)}
};

window.setButtonLoading=function(btn,on,label='جاري التنفيذ...'){
  if(!btn)return;
  if(on){if(!btn.dataset.originalHtml)btn.dataset.originalHtml=btn.innerHTML;btn.disabled=true;btn.classList.add('is-loading');btn.innerHTML=`<span class="dw-mini-spinner" aria-hidden="true"></span><span>${label}</span>`}
  else{btn.disabled=false;btn.classList.remove('is-loading');if(btn.dataset.originalHtml){btn.innerHTML=btn.dataset.originalHtml;delete btn.dataset.originalHtml}}
};

window.goBackSafe=function(){
  forceUnlockUI();
  if(history.length>1)history.back();else location.assign('/');
};
window.navigateTo=function(url){forceUnlockUI();location.assign(url)};

window.loadPiSDK=async function(){
  if(window.Pi)return window.Pi;
  if(window.__piSdkPromise)return window.__piSdkPromise;
  window.__piSdkPromise=new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://sdk.minepi.com/pi-sdk.js';s.async=true;s.onload=()=>resolve(window.Pi);s.onerror=()=>reject(new Error('تعذر تحميل Pi SDK'));document.head.appendChild(s)});
  return window.__piSdkPromise;
};

async function clearDealWayCaches(){
  if(!('caches' in window))return;
  try{const keys=await caches.keys();await Promise.all(keys.filter(k=>k.startsWith('dealway-')).map(k=>caches.delete(k)))}catch{}
}

async function checkDealWayVersion(){
  try{
    const r=await fetch('/version.json?t='+Date.now(),{cache:'no-store',headers:{'Cache-Control':'no-cache'}});
    if(!r.ok)return;
    const data=await r.json();
    const remote=String(data.version||'');
    if(!remote)return;
    const saved=localStorage.getItem('dw_app_version');
    if(saved&&saved!==remote){
      localStorage.setItem('dw_app_version',remote);
      await clearDealWayCaches();
      if('serviceWorker' in navigator){try{const reg=await navigator.serviceWorker.getRegistration();await reg?.update()}catch{}}
      const key='dw_version_reload_'+remote;
      if(!sessionStorage.getItem(key)){sessionStorage.setItem(key,'1');location.reload();return}
    }else if(!saved){
      localStorage.setItem('dw_app_version',remote);
    }
  }catch{}
}
window.checkDealWayVersion=checkDealWayVersion;

function bindCommonUI(){
  DW.apply();ensureShell();DWLoading.done();
  document.querySelectorAll('header .back, .top > .topin .back').forEach(b=>{
    b.onclick=goBackSafe;b.setAttribute('aria-label','رجوع');
  });
  // لا نعترض كل الروابط عالميًا. التنقل الأصلي للمتصفح أكثر ثباتًا داخل Pi Browser.
}

document.addEventListener('DOMContentLoaded',()=>{bindCommonUI();checkDealWayVersion()});
window.addEventListener('pageshow',()=>{DWLoading.done();checkDealWayVersion()});
window.addEventListener('focus',forceUnlockUI);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)forceUnlockUI()});
window.addEventListener('error',forceUnlockUI);
window.addEventListener('unhandledrejection',forceUnlockUI);

if('serviceWorker' in navigator){
  navigator.serviceWorker.addEventListener('message',async e=>{
    if(e.data?.type==='DW_SW_UPDATED'){
      const v=String(e.data.version||'');
      const saved=localStorage.getItem('dw_app_version');
      if(v&&saved&&saved!==v){localStorage.setItem('dw_app_version',v);await clearDealWayCaches();location.reload()}
    }
  });
  navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).then(reg=>reg.update()).catch(()=>{});
}

let dwInstallPrompt=null;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();dwInstallPrompt=e;document.querySelectorAll('[data-install-app]').forEach(b=>b.hidden=false)});
window.installDealWay=async()=>{if(dwInstallPrompt){dwInstallPrompt.prompt();await dwInstallPrompt.userChoice;dwInstallPrompt=null}else alert(DW.locale==='ar'?'استخدم خيار إضافة إلى الشاشة الرئيسية من المتصفح.':'Use Add to Home Screen from your browser menu.')};
window.enableDealWayPush=async function(){
  const token=localStorage.getItem('dw_token'); if(!token) throw new Error(DW.locale==='ar'?'سجل الدخول أولًا':'Sign in first');
  if(!('serviceWorker' in navigator)||!('PushManager' in window)) throw new Error('Push is not supported');
  const cfg=await fetch('/api/config',{cache:'no-store'}).then(r=>r.json()); if(!cfg.vapidPublicKey) throw new Error(DW.locale==='ar'?'الإشعارات الخارجية غير مفعلة على الخادم':'Push is not configured on the server');
  const permission=await Notification.requestPermission(); if(permission!=='granted') throw new Error(DW.locale==='ar'?'لم يتم السماح بالإشعارات':'Notification permission denied');
  const reg=await navigator.serviceWorker.ready;
  let k=cfg.vapidPublicKey.replace(/-/g,'+').replace(/_/g,'/');while(k.length%4)k+='=';const bytes=Uint8Array.from(atob(k),c=>c.charCodeAt(0));
  const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
  const r=await fetch('/api/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify(sub)});if(!r.ok)throw new Error('Push subscription failed');return true;
};
