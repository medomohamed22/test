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
  if(!document.getElementById('dw-page-progress')){
    document.body.insertAdjacentHTML('afterbegin','<div id="dw-page-progress" class="dw-page-progress" aria-hidden="true"><i></i></div><div id="dw-global-loader" class="dw-global-loader" hidden><div class="dw-loader-card"><span class="dw-spinner"></span><b id="dw-loader-label">جاري التحميل...</b></div></div>');
  }
}
window.DWLoading={
  show(label='جاري التحميل...'){ensureShell();const x=document.getElementById('dw-global-loader');document.getElementById('dw-loader-label').textContent=label;x.hidden=false;requestAnimationFrame(()=>x.classList.add('show'))},
  hide(){const x=document.getElementById('dw-global-loader');if(!x)return;x.classList.remove('show');setTimeout(()=>{x.hidden=true},160)},
  progress(){ensureShell();const p=document.getElementById('dw-page-progress');p.classList.remove('done');p.classList.add('active')},
  done(){const p=document.getElementById('dw-page-progress');if(!p)return;p.classList.add('done');setTimeout(()=>p.classList.remove('active','done'),240)}
};
window.setButtonLoading=function(btn,on,label='جاري التنفيذ...'){
  if(!btn)return;
  if(on){if(!btn.dataset.originalHtml)btn.dataset.originalHtml=btn.innerHTML;btn.disabled=true;btn.classList.add('is-loading');btn.innerHTML=`<span class="dw-mini-spinner" aria-hidden="true"></span><span>${label}</span>`}
  else{btn.disabled=false;btn.classList.remove('is-loading');if(btn.dataset.originalHtml){btn.innerHTML=btn.dataset.originalHtml;delete btn.dataset.originalHtml}}
};
window.goBackSafe=function(){DWLoading?.progress();location.href='/';};
window.navigateTo=function(url){DWLoading.progress();if(document.startViewTransition){document.startViewTransition(()=>{location.href=url})}else location.href=url};
window.loadPiSDK=async function(){
  if(window.Pi)return window.Pi;
  if(window.__piSdkPromise)return window.__piSdkPromise;
  window.__piSdkPromise=new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://sdk.minepi.com/pi-sdk.js';s.async=true;s.onload=()=>resolve(window.Pi);s.onerror=()=>reject(new Error('تعذر تحميل Pi SDK'));document.head.appendChild(s)});
  return window.__piSdkPromise;
};

document.addEventListener('DOMContentLoaded',()=>{
  DW.apply();ensureShell();DWLoading.done();
  document.querySelectorAll('.back').forEach(b=>{b.onclick=goBackSafe;b.setAttribute('aria-label','رجوع')});
  document.addEventListener('click',e=>{
    const a=e.target.closest('a[href]');if(!a||a.target==='_blank'||a.hasAttribute('download')||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
    try{const u=new URL(a.href,location.href);if(u.origin===location.origin&&u.href!==location.href){e.preventDefault();navigateTo(u.href)}}catch{}
  });
});
window.addEventListener('pageshow',()=>DWLoading.done());
window.addEventListener('beforeunload',()=>DWLoading.progress());
if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
let dwInstallPrompt=null;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();dwInstallPrompt=e;document.querySelectorAll('[data-install-app]').forEach(b=>b.hidden=false)});
window.installDealWay=async()=>{if(dwInstallPrompt){dwInstallPrompt.prompt();await dwInstallPrompt.userChoice;dwInstallPrompt=null}else alert(DW.locale==='ar'?'استخدم خيار إضافة إلى الشاشة الرئيسية من المتصفح.':'Use Add to Home Screen from your browser menu.')};
window.enableDealWayPush=async function(){
  const token=localStorage.getItem('dw_token'); if(!token) throw new Error(DW.locale==='ar'?'سجل الدخول أولًا':'Sign in first');
  if(!('serviceWorker' in navigator)||!('PushManager' in window)) throw new Error('Push is not supported');
  const cfg=await fetch('/api/config').then(r=>r.json()); if(!cfg.vapidPublicKey) throw new Error(DW.locale==='ar'?'الإشعارات الخارجية غير مفعلة على الخادم':'Push is not configured on the server');
  const permission=await Notification.requestPermission(); if(permission!=='granted') throw new Error(DW.locale==='ar'?'لم يتم السماح بالإشعارات':'Notification permission denied');
  const reg=await navigator.serviceWorker.ready;
  let k=cfg.vapidPublicKey.replace(/-/g,'+').replace(/_/g,'/');while(k.length%4)k+='=';const bytes=Uint8Array.from(atob(k),c=>c.charCodeAt(0));
  const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
  const r=await fetch('/api/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify(sub)});if(!r.ok)throw new Error('Push subscription failed');return true;
};
