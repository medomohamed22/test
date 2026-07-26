'use strict';

// Supabase keys never exist in the browser. The Pi access token is cached locally for at most 24 hours
// to avoid asking the same user to authorize on every visit. It is removed automatically on expiry or auth failure.
const AUTH_CACHE_KEY = 'dealway_pi_session_v1';
const AUTH_TTL_MS = 24 * 60 * 60 * 1000;
const PRODUCTS_CACHE_KEY = 'dealway_public_products_v2';
let piAccessToken = null;
let piInitialized = false;
let piInitPromise = null;
let loginInProgress = false;

function savePiSession(accessToken) {
  try { localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({ accessToken, expiresAt: Date.now() + AUTH_TTL_MS })); } catch (_) {}
}
function restorePiSession() {
  try {
    const cached = JSON.parse(localStorage.getItem(AUTH_CACHE_KEY) || 'null');
    if (!cached?.accessToken || Number(cached.expiresAt) <= Date.now()) { localStorage.removeItem(AUTH_CACHE_KEY); return false; }
    piAccessToken = cached.accessToken;
    return true;
  } catch (_) { return false; }
}
function clearPiSession() {
  piAccessToken = null;
  try { localStorage.removeItem(AUTH_CACHE_KEY); } catch (_) {}
}
function readProductsCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(PRODUCTS_CACHE_KEY) || 'null');
    return Array.isArray(cached?.products) && Date.now()-Number(cached.savedAt||0)<30*1000 ? cached.products : null;
  } catch (_) { return null; }
}
function writeProductsCache(products) {
  try { localStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify({ products, savedAt: Date.now() })); } catch (_) {}
}

function authHeaders(json = true) {
  const headers = { Accept: 'application/json' };
  if (json) headers['Content-Type'] = 'application/json';
  if (piAccessToken) headers.Authorization = `Bearer ${piAccessToken}`;
  return headers;
}

async function parseApiResponse(res) {
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await res.json().catch(() => ({}))
    : { error: await res.text().catch(() => '') };

  if (!res.ok) {
    const message = data.error || data.message || `Request failed (${res.status})`;
    const error = new Error(message);
    error.status = res.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

async function api(path, options = {}) {
  const requestOptions = {
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    ...options,
  };

  let res = await fetch(`/api/${path}`, requestOptions);

  // Some manual Vercel uploads can temporarily expose the physical .js route.
  // This fallback avoids breaking Pi login while the canonical /api route is restored.
  if (res.status === 404 && !path.includes('?') && !path.endsWith('.js')) {
    res = await fetch(`/api/${path}.js`, requestOptions);
  }
  return parseApiResponse(res);
}

function friendlyDbError(error) {
  const ar = currentLang === 'ar';
  const messages = {
    NAME_TOO_SHORT: ar ? 'اكتب اسم المنتج من حرفين على الأقل.' : 'Enter a product name with at least 2 characters.',
    DESCRIPTION_TOO_SHORT: ar ? 'اكتب وصفًا واضحًا لا يقل عن 20 حرفًا.' : 'Write a clear description of at least 20 characters.',
    PRICE_INVALID: ar ? 'اكتب سعرًا صحيحًا بالدولار أكبر من صفر.' : 'Enter a valid USD price greater than zero.',
    CATEGORY_TOO_SHORT: ar ? 'اختر قسم المنتج.' : 'Select a category.',
    COUNTRY_TOO_SHORT: ar ? 'اختر الدولة.' : 'Select a country.',
    LOCATION_TOO_SHORT: ar ? 'اختر المنطقة أو المحافظة.' : 'Select a state or province.',
    IMAGES_REQUIRED: ar ? 'ارفع صورة واحدة على الأقل.' : 'Upload at least one image.',
    IMAGES_MAX: ar ? 'الحد الأقصى 3 صور.' : 'Maximum 3 images.',
    IMAGE_TOO_LARGE: ar ? 'حجم كل صورة بعد الضغط يجب ألا يتجاوز 2 ميجابايت.' : 'Each compressed image must be 2 MB or less.',
    IMAGE_TYPE: ar ? 'ارفع صور JPEG أو PNG أو WEBP فقط.' : 'Upload JPEG, PNG, or WEBP images only.',
    PAYMENT_AMOUNT_MISMATCH: ar ? 'قيمة الدفع لا تطابق الباقة المختارة. حدّث سعر Pi وحاول مجددًا.' : 'Payment amount does not match the selected plan. Refresh Pi price and retry.',
    PAYMENT_NOT_VERIFIED: ar ? 'لم يتم التحقق من المعاملة على شبكة Pi بعد.' : 'The Pi transaction is not verified yet.'
  };
  if (messages[error?.code]) return messages[error.code];
  if (error?.status === 404) return ar ? 'مسار الخادم غير موجود في آخر نشر على Vercel.' : 'The server route is missing from the latest deployment.';
  return error?.message || String(error || (ar ? 'حدث خطأ غير متوقع' : 'Unexpected error'));
}

async function waitForPiSdk(timeoutMs = 10000) {
  const started = Date.now();
  while (!window.Pi && Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!window.Pi) throw new Error('Pi SDK is unavailable. Open the app inside Pi Browser.');
  return window.Pi;
}

async function ensurePiInitialized() {
  if (piInitialized && window.Pi) return window.Pi;
  if (piInitPromise) return piInitPromise;

  piInitPromise = (async () => {
    const pi = await waitForPiSdk();
    await Promise.resolve(pi.init({ version: '2.0', sandbox: false }));
    piInitialized = true;
    return pi;
  })();

  try {
    return await piInitPromise;
  } catch (error) {
    piInitialized = false;
    throw error;
  } finally {
    piInitPromise = null;
  }
}

async function ensurePiPaymentSession() {
  const pi = await ensurePiInitialized();
  const auth = await pi.authenticate(
    ['username', 'payments'],
    payment => console.warn('Incomplete Pi payment found:', payment?.identifier || payment)
  );

  if (!auth?.accessToken) throw new Error(currentLang === 'ar' ? 'تعذر تفعيل جلسة الدفع في Pi Browser.' : 'Could not activate the Pi payment session.');
  piAccessToken = auth.accessToken;
  savePiSession(piAccessToken);
  return pi;
}

function initPi() {
  const btn = el('loginBtn');
  if (!btn) return;

  btn.onclick = async () => {
    if (loginInProgress) return;
    loginInProgress = true;
    btn.disabled = true;

    try {
      const pi = await ensurePiInitialized();
      const auth = await pi.authenticate(
        ['username', 'payments'],
        payment => console.warn('Incomplete Pi payment found:', payment?.identifier || payment)
      );

      if (!auth?.accessToken) throw new Error('Pi did not return an access token.');
      piAccessToken = auth.accessToken;
      savePiSession(piAccessToken);
      await handleLogin();
    } catch (e) {
      console.error('Pi login failed:', e);
      clearPiSession();
      showToast(e.message || 'Login failed', 'error');
    } finally {
      loginInProgress = false;
      btn.disabled = false;
    }
  };
}

async function handleLogin() {
  try {
    const data = await api('session', { method: 'GET', headers: authHeaders(false) });
    if (data.user.isBanned) {
      el('banned-screen').classList.remove('hidden');
      el('banned-screen').style.display = 'flex';
      return;
    }
    user = { uid: data.user.uid, username: data.user.username };
    el('loginBtn').classList.add('hidden');
    el('headerUser').classList.remove('hidden');
    safeSetText('userDispName', user.username);
    el('profile-guest').classList.add('hidden');
    el('profile-user').classList.remove('hidden');
    safeSetText('p-username', user.username);
    await refreshTelegramButton();
    await Promise.all([loadMyAds(), loadInbox(), checkUnreadMessages(), loadMarketplaceState()]);
    setInterval(checkUnreadMessages, 10000);
  } catch (e) {
    piAccessToken = null;
    showToast(friendlyDbError(e), 'error');
  }
}

async function refreshTelegramButton(showErrors=false){const btn=el('telegramLinkBtn'),txt=el('telegramLinkText');if(!btn||!txt||!user)return;try{const d=await api('telegram-link',{headers:authHeaders(false)});btn.disabled=d.linked;btn.classList.toggle('btn-disabled',d.linked);txt.innerText=d.linked?(currentLang==='ar'?'تم الربط':'Linked'):(currentLang==='ar'?'ربط بوت تيليجرام':'Link Telegram Bot')}catch(e){if(showErrors)showToast(e.message,'error')}}
async function linkTelegramBot(){if(!user)return showToast('toast_login_first','error');try{const d=await api('telegram-link',{method:'POST',headers:authHeaders(),body:'{}'});openTelegramExternal(BOT_USERNAME,d.token);if(telegramCheckTimer)clearInterval(telegramCheckTimer);telegramCheckTimer=setInterval(()=>refreshTelegramButton(false),2500)}catch(e){showToast(e.message,'error')}}
async function loadAllProducts(forceFresh=false){const cached=forceFresh?null:readProductsCache();if(cached){globalProducts=cached.slice();populateProductLocations();renderProducts();openProductFromUrlOnce()}else el('loading').style.display='block';try{const d=await api(`public-products?t=${Date.now()}`);globalProducts=d.products||[];writeProductsCache(globalProducts);populateProductLocations();renderProducts();openProductFromUrlOnce()}catch(e){if(!cached)safeSetHtml('products-list',`<div class="empty-state" style="grid-column:1/-1"><h3>خطأ</h3><p>${escapeHtml(e.message)}</p></div>`)}finally{el('loading').style.display='none'}}
function formatSellerJoinDate(value){if(!value)return currentLang==='ar'?'غير متاح':'Not available';const d=new Date(value);if(Number.isNaN(d.getTime()))return currentLang==='ar'?'غير متاح':'Not available';return new Intl.DateTimeFormat(currentLang==='ar'?'ar-EG':'en-US',{year:'numeric',month:'short',day:'numeric'}).format(d)}
async function openProductDetails(pid){const p=globalProducts.find(x=>x.id==pid);if(!p)return;try{const d=await api('public-products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:Number(pid)})});p.views=d.views||p.views}catch(_){}const images=Array.isArray(p.images)&&p.images.length?p.images:['https://placehold.co/600x600/f1f5f9/94a3b8?text=No+Image'];el('detail-slider').innerHTML=images.map(src=>`<div class="slide"><img src="${escapeAttr(src)}" class="slide-img"></div>`).join('');el('detail-dots').innerHTML=images.map((_,i)=>`<div class="dot ${i===0?'active':''}" onclick="goToSlide(${i})"></div>`).join('');safeSetText('detail-title',p.name);updateDetailPrice(p);safeSetText('detail-desc',p.description);safeSetText('detail-loc-text',`${p.country||''} - ${p.location||''}`);safeSetText('detail-views',formatCurrency(p.views||0));safeSetText('detail-seller-name',p.seller_username||'Unknown');safeSetText('detail-seller-avatar',(p.seller_username||'U').charAt(0).toUpperCase());safeSetText('detail-ad-count',formatCurrency(p.seller_ads_count||0));safeSetText('detail-join-date',formatSellerJoinDate(p.seller_joined_at));const own=user&&p.seller_pi_id===user.uid;el('detail-actions').innerHTML=own?`<button onclick="openPromoteOptions(${Number(p.id)})" class="btn" style="width:100%">${escapeHtml(t('promote_ad_btn'))}</button><button onclick="deleteProduct(${Number(p.id)})" class="btn btn-danger" style="width:100%">${escapeHtml(t('delete_btn'))}</button>`:`<button onclick="openChatRoom(${Number(p.id)},'${escapeAttr(p.seller_pi_id)}','${escapeAttr(p.name)}','${escapeAttr(p.seller_username||'User')}')" class="btn btn-primary" style="width:100%">${escapeHtml(t('message_seller'))}</button>`;document.querySelectorAll('.view-section').forEach(e=>e.classList.add('hidden'));el('view-details').classList.remove('hidden')}
function formatPromotionEndDate(value){if(!value)return '';const d=new Date(value);if(Number.isNaN(d.getTime()))return '';return new Intl.DateTimeFormat(currentLang==='ar'?'ar-EG':'en-US',{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(d)}
async function loadMyAds(){if(!user)return;const list=el('my-ads-list');try{const d=await api('products',{headers:authHeaders(false)}),products=d.products||[];safeSetText('stat-ads',products.length);safeSetText('stat-views',formatCurrency(products.reduce((s,p)=>s+(p.views||0),0)));const now=Date.now();list.innerHTML=products.map(p=>{const img=p.images?.[0]||'https://placehold.co/400x400/f1f5f9/94a3b8?text=No+Image',ar=currentLang==='ar',state=p.status==='pending'?(ar?'قيد المراجعة':'Pending'):p.status==='rejected'?(ar?'مرفوض':'Rejected'):(ar?'مقبول':'Approved'),reason=p.status==='rejected'&&p.rejection_reason?`<div style="margin-top:8px;padding:9px;border-radius:10px;background:#fef2f2;color:#b91c1c;font-size:12px">${escapeHtml(ar?'سبب الرفض: ':'Reason: ')}${escapeHtml(p.rejection_reason)}</div>`:'',promotionEnd=p.promoted_until?new Date(p.promoted_until).getTime():0,isPromoted=Number.isFinite(promotionEnd)&&promotionEnd>now,promotionInfo=isPromoted?`<div style="width:100%;margin-top:4px;padding:8px 10px;border-radius:10px;background:#fffbeb;border:1px solid #facc15;color:#854d0e;font-size:11px;font-weight:800;line-height:1.6"><i class="fa-solid fa-crown"></i> ${escapeHtml(ar?'إعلان مميز':'Promoted ad')}<br><i class="fa-regular fa-clock"></i> ${escapeHtml(t('promoted_until'))}: ${escapeHtml(formatPromotionEndDate(p.promoted_until))}</div>`:'';return `<div class="card ${isPromoted?'promoted':''}"><div onclick="openProductDetails(${Number(p.id)})"><div class="card-img-wrap">${isPromoted?`<div class="promo-badge promo-tier-${Math.min(3,Math.max(1,getPromotionLevel(p)))}"><i class="fa-solid fa-crown"></i> ${escapeHtml(t('promoted_badge'))}</div>`:''}<img src="${escapeAttr(img)}" class="card-img" loading="lazy" decoding="async"></div><div class="card-body"><div class="card-title">${escapeHtml(p.name)}</div><div>${escapeHtml(state)}</div>${promotionInfo}${reason}</div></div><div style="display:flex;gap:8px;padding:0 12px 12px"><button class="btn btn-danger" style="flex:1;padding:9px" onclick="deleteProduct(${Number(p.id)})">${escapeHtml(t('delete_btn'))}</button></div></div>`}).join('')||`<div class="empty-state"><h3>${escapeHtml(t('no_products'))}</h3></div>`}catch(e){list.innerHTML=`<div class="empty-state"><p>${escapeHtml(friendlyDbError(e))}</p></div>`}}
function fileToDataUrl(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file)})}
async function submitProduct(){
 if(!user)return showToast(t('toast_login_first'),'error');
 const name=el('addName').value.trim(), description=el('addDesc').value.trim(), price=Number(el('addPrice').value), category=el('addCategory').value, country=el('addCountry').value, location=el('addState').value, btn=el('publishBtn');
 const ar=currentLang==='ar';
 const validation=[
  [!name, ar?'اكتب اسم المنتج.':'Enter the product name.'],
  [name.length>0&&name.length<2, ar?'اسم المنتج قصير جدًا.':'Product name is too short.'],
  [!description, ar?'اكتب وصف المنتج.':'Enter the product description.'],
  [description.length>0&&description.length<20, ar?'اكتب وصفًا أوضح لا يقل عن 20 حرفًا.':'Write a clearer description of at least 20 characters.'],
  [!Number.isFinite(price)||price<=0, ar?'اكتب سعرًا صحيحًا بالدولار.':'Enter a valid USD price.'],
  [!category, ar?'اختر قسم المنتج.':'Select a category.'],
  [!country, ar?'اختر الدولة.':'Select a country.'],
  [!location, ar?'اختر المنطقة أو المحافظة.':'Select a state or province.'],
  [selectedFiles.length===0, ar?'ارفع صورة واحدة على الأقل.':'Upload at least one image.'],
  [selectedFiles.length>3, ar?'الحد الأقصى 3 صور.':'Maximum 3 images.']
 ];
 const first=validation.find(x=>x[0]);if(first)return showToast(first[1],'error');
 btn.disabled=true;btn.innerHTML=ar?'جاري تجهيز الصور...':'Preparing images...';
 try{const images=[];for(const file of selectedFiles){if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Object.assign(new Error(),{code:'IMAGE_TYPE'});const compressed=await imageCompression(file,{maxSizeMB:.8,maxWidthOrHeight:1600,useWebWorker:true,fileType:'image/jpeg',initialQuality:.88});images.push({data:await fileToDataUrl(compressed)})}btn.innerHTML=ar?'جاري الإرسال للمراجعة...':'Sending for review...';await api('products',{method:'POST',headers:authHeaders(),body:JSON.stringify({name,description,priceUsd:price,category,country,location,images,attributes:collectAttributes(),latitude:el('addLatitude')?.value||null,longitude:el('addLongitude')?.value||null})});showToast(ar?'تم إرسال الإعلان للمراجعة.':'Ad sent for review.','success');closeAddModal();await loadMyAds()}catch(e){showToast(friendlyDbError(e),'error')}finally{btn.disabled=false;btn.innerHTML=t('publish_btn')}}
async function deleteProduct(id){if(!confirm(t('confirm_delete')))return;try{await api('products',{method:'DELETE',headers:authHeaders(),body:JSON.stringify({id})});await Promise.all([loadMyAds(),loadAllProducts()]);nav('home')}catch(e){showToast(e.message,'error')}}
function openPromoteOptions(id){currentPromoteProductId=id;renderPromotionPlanPrices();el('promoteModal').style.display='flex'}function closePromoteModal(){el('promoteModal').style.display='none';currentPromoteProductId=null}function triggerPayment(_usd,_days,tier){if(!currentPromoteProductId)return;const id=currentPromoteProductId;closePromoteModal();promoteProduct(id,tier)}
async function promoteProduct(productId,tier){
 if(!user)return showToast(currentLang==='ar'?'سجّل الدخول أولاً.':'Login first.','error');
 const plan={1:1,2:5,3:10}[tier];
 try{
  const pi=await ensurePiPaymentSession();
  await refreshPiPrice();
  if(!piUsdPrice||piUsdPrice<=0)throw new Error(currentLang==='ar'?'تعذر تحديث سعر Pi. حاول مرة أخرى.':'Could not refresh the Pi price. Try again.');
  const amount=Number((plan/piUsdPrice).toFixed(8));
  await Promise.resolve(pi.createPayment({amount,memo:`Promote Ad ${productId}`,metadata:{type:'promotion',productId:Number(productId),tier:Number(tier)}},{onReadyForServerApproval:async paymentId=>{await api('approve',{method:'POST',headers:authHeaders(),body:JSON.stringify({paymentId})})},onReadyForServerCompletion:async(paymentId,txid)=>{await api('complete',{method:'POST',headers:authHeaders(),body:JSON.stringify({paymentId,txid})});showToast(currentLang==='ar'?'تم تمييز الإعلان بنجاح.':'Promotion activated!','success');await Promise.all([loadAllProducts(true),loadMyAds()])},onCancel:()=>showToast(currentLang==='ar'?'تم إلغاء الدفع.':'Payment cancelled.','warning'),onError:e=>showToast(e?.message||(currentLang==='ar'?'فشل الدفع.':'Payment failed.'),'error')}));
 }catch(e){
  console.error('Pi promotion payment failed:',e);
  showToast(friendlyDbError(e),'error');
 }
}
function openChatRoom(pid,otherId,pName,uName){if(!user)return showToast('toast_login_first','error');activeChat={pid,otherId};safeSetText('chatTitle',pName);safeSetText('chatPeer',uName);el('chatModal').style.display='flex';loadMessages();api('messages',{method:'PATCH',headers:authHeaders(),body:JSON.stringify({productId:pid,otherPiId:otherId})}).catch(()=>{})}
async function loadMessages(){if(!activeChat)return;const d=await api(`messages?productId=${encodeURIComponent(activeChat.pid)}`,{headers:authHeaders(false)});el('msgContainer').innerHTML='';(d.messages||[]).filter(m=>(m.sender_pi_id===user.uid&&m.receiver_pi_id===activeChat.otherId)||(m.sender_pi_id===activeChat.otherId&&m.receiver_pi_id===user.uid)).forEach(renderMsg)}
function renderMsg(m){const div=document.createElement('div');div.className=`bubble ${m.sender_pi_id===user.uid?'me':'other'}`;div.innerText=m.content;el('msgContainer').appendChild(div)}
async function sendMsg(){const inp=el('msgInput');if(!activeChat||!inp.value.trim())return;const content=inp.value.trim();inp.value='';const temp={sender_pi_id:user.uid,content};renderMsg(temp);const box=el('msgContainer');box.scrollTop=box.scrollHeight;try{await api('messages',{method:'POST',headers:authHeaders(),body:JSON.stringify({productId:activeChat.pid,receiverPiId:activeChat.otherId,content})});setTimeout(()=>loadMessages().catch(()=>{}),250)}catch(e){showToast(e.message,'error');await loadMessages().catch(()=>{})}}
function closeChat(){el('chatModal').style.display='none';activeChat=null}
async function loadInbox(){if(!user)return;const list=el('inbox-list');try{const d=await api('messages',{headers:authHeaders(false)}),threads=new Map();(d.messages||[]).slice().reverse().forEach(m=>{const other=m.sender_pi_id===user.uid?m.receiver_pi_id:m.sender_pi_id,key=`${m.product_id}_${other}`;if(!threads.has(key))threads.set(key,{pid:m.product_id,otherId:other,pName:m.products?.name||'Item',last:m.content,name:m.sender_pi_id===other?m.sender_username:m.receiver_username,unread:!m.is_read&&m.receiver_pi_id===user.uid})});list.innerHTML=[...threads.values()].map(x=>`<div class="inbox-item ${x.unread?'unread':''}" onclick="openChatRoom(${x.pid},'${escapeAttr(x.otherId)}','${escapeAttr(x.pName)}','${escapeAttr(x.name)}')"><div class="inbox-info"><div class="inbox-name">${escapeHtml(x.name)}</div><div class="inbox-msg">${escapeHtml(x.last)}</div></div></div>`).join('')||`<div class="empty-state"><h3>${escapeHtml(t('no_messages'))}</h3></div>`}catch(e){list.innerHTML=`<p>${escapeHtml(e.message)}</p>`}}
async function checkUnreadMessages(){if(!user)return;try{const d=await api('messages',{headers:authHeaders(false)}),count=(d.messages||[]).filter(m=>!m.is_read&&m.receiver_pi_id===user.uid).length,b=el('chat-badge');if(count){b.innerText=count>9?'+9':count;b.classList.remove('hidden')}else b.classList.add('hidden')}catch(_){}}
let lastProductsRefresh=0;document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&Date.now()-lastProductsRefresh>30000){lastProductsRefresh=Date.now();loadAllProducts(true).catch(()=>{})}});window.addEventListener('focus',()=>{if(Date.now()-lastProductsRefresh>30000){lastProductsRefresh=Date.now();loadAllProducts(true).catch(()=>{})}});document.addEventListener('DOMContentLoaded',()=>{updateLanguage();initDragAndDrop();initPi();ensurePiInitialized().catch(e=>console.warn('Pi SDK initialization deferred:',e?.message||e));refreshPiPrice();lastProductsRefresh=Date.now();loadAllProducts();initLocations();if(restorePiSession())handleLogin().catch(()=>clearPiSession())});setInterval(refreshPiPrice,60000);

// ===== Marketplace feature pack =====
let marketplaceState={favorites:new Set(),savedSearches:[],blocks:new Set(),reviews:[],verification:{}};
const CATEGORY_FIELDS={cars:[['brand','الماركة'],['model','الموديل'],['year','السنة'],['mileage','الكيلومترات'],['transmission','ناقل الحركة']],phones:[['brand','الشركة'],['storage','السعة'],['condition','الحالة'],['warranty','الضمان']],electronics:[['brand','الماركة'],['condition','الحالة'],['warranty','الضمان']],home:[['condition','الحالة'],['material','الخامة']],fashion:[['size','المقاس'],['condition','الحالة']]};
function mpApi(action,options={}){const sep=action.includes('?')?'&':'?';return api(`marketplace${sep}action=${encodeURIComponent(action)}`,options)}
async function loadMarketplaceState(){if(!user)return;try{const d=await mpApi('dashboard',{headers:authHeaders(false)});marketplaceState={favorites:new Set((d.favorites||[]).map(x=>Number(x.product_id))),savedSearches:d.savedSearches||[],blocks:new Set((d.blocks||[]).map(x=>x.blocked_pi_id)),reviews:d.reviews||[],verification:d.verification||{}};renderProducts()}catch(e){console.warn('Marketplace dashboard:',e.message)}}
function statusText(s){const ar=currentLang==='ar';return ({available:ar?'متاح':'Available',reserved:ar?'محجوز':'Reserved',sold:ar?'تم البيع':'Sold',expired:ar?'منتهي':'Expired'})[s||'available']}
async function toggleFavorite(id,ev){ev?.stopPropagation();if(!user)return showToast(t('toast_login_first'),'error');const remove=marketplaceState.favorites.has(Number(id));try{await mpApi('favorite',{method:'POST',headers:authHeaders(),body:JSON.stringify({productId:Number(id),remove})});remove?marketplaceState.favorites.delete(Number(id)):marketplaceState.favorites.add(Number(id));renderProducts();if(el('detail-marketplace'))renderDetailMarketplace(globalProducts.find(x=>x.id==id))}catch(e){showToast(friendlyDbError(e),'error')}}
async function saveCurrentSearch(){if(!user)return showToast(t('toast_login_first'),'error');const name=prompt(currentLang==='ar'?'اسم البحث المحفوظ':'Saved search name');if(!name)return;const filters={query:el('searchInput')?.value||'',category:activeCategory,country:el('countryFilter')?.value||'all',location:el('stateFilter')?.value||'all',sort:el('sortFilter')?.value||'recommended'};try{await mpApi('saved-search',{method:'POST',headers:authHeaders(),body:JSON.stringify({name,filters})});showToast(currentLang==='ar'?'تم حفظ البحث والتنبيه.':'Search alert saved.','success');await loadMarketplaceState()}catch(e){showToast(friendlyDbError(e),'error')}}
function applySavedSearch(id){const x=marketplaceState.savedSearches.find(s=>s.id==id);if(!x)return;const f=x.filters||{};if(el('searchInput'))el('searchInput').value=f.query||'';activeCategory=f.category||'all';initCategories();if(el('countryFilter'))el('countryFilter').value=f.country||'all';syncStateFilter();if(el('stateFilter'))el('stateFilter').value=f.location||'all';if(el('sortFilter'))el('sortFilter').value=f.sort||'recommended';nav('home');renderProducts()}
async function deleteSavedSearch(id){await mpApi('saved-search',{method:'DELETE',headers:authHeaders(),body:JSON.stringify({id})});await loadMarketplaceState();openMarketplacePanel('favorites')}
async function openMarketplacePanel(type){if(!user)return;const box=el('marketplace-panel');if(type==='favorites'){const fav=globalProducts.filter(p=>marketplaceState.favorites.has(Number(p.id)));box.innerHTML=`<div class="market-panel"><h4>المفضلة وعمليات البحث المحفوظة</h4><div class="market-list">${fav.map(p=>`<div class="market-row"><span>${escapeHtml(p.name)}</span><button class="mini-btn mini-primary" onclick="openProductDetails(${p.id})">عرض</button></div>`).join('')||'<small>لا توجد إعلانات مفضلة.</small>'}${marketplaceState.savedSearches.map(x=>`<div class="market-row"><span><i class="fa-solid fa-bell"></i> ${escapeHtml(x.name)}</span><div class="mini-actions"><button class="mini-btn mini-primary" onclick="applySavedSearch(${x.id})">تطبيق</button><button class="mini-btn mini-danger" onclick="deleteSavedSearch(${x.id})">حذف</button></div></div>`).join('')}</div></div>`}
 if(type==='reviews'){const r=marketplaceState.reviews;box.innerHTML=`<div class="market-panel"><h4>التقييمات</h4><div class="market-list">${r.map(x=>`<div class="market-row"><div><div class="stars">${'★'.repeat(x.rating)}${'☆'.repeat(5-x.rating)}</div><small>${escapeHtml(x.comment||'بدون تعليق')}</small></div><small>${escapeHtml(x.reviewer_username||'Pioneer')}</small></div>`).join('')||'<small>لا توجد تقييمات حتى الآن.</small>'}</div></div>`}
 if(type==='verification'){const v=marketplaceState.verification||{};box.innerHTML=`<div class="market-panel"><h4>توثيق الحساب</h4><p>الحالة: <b>${escapeHtml(v.verification_status||'unverified')}</b></p><div class="mini-actions" style="margin-top:12px"><button class="btn btn-primary" onclick="requestVerification('phone')">توثيق الهاتف</button><button class="btn btn-ghost" onclick="requestVerification('identity')">توثيق الهوية</button><button class="btn btn-gold" onclick="requestVerification('business')">تاجر محترف</button></div></div>`}
 if(type==='analytics'){box.innerHTML='<div class="market-panel"><h4>إحصائيات الإعلانات</h4><div id="analyticsRows">جاري التحميل...</div></div>';try{const d=await mpApi('analytics',{headers:authHeaders(false)});el('analyticsRows').innerHTML=(d.products||[]).map(p=>{const e=p.events||{},total=e.favorite+e.chat+e.contact+e.share;return `<div class="market-row"><div style="flex:1"><b>${escapeHtml(p.name)}</b><small style="display:block">مشاهدات ${p.views||0} · مفضلة ${e.favorite||0} · رسائل ${e.chat||0} · مشاركة ${e.share||0}</small><div class="analytics-bar"><span style="width:${Math.min(100,total*5)}%"></span></div></div></div>`}).join('')||'لا توجد بيانات.'}catch(e){el('analyticsRows').textContent=friendlyDbError(e)}}
}
async function requestVerification(level){const evidence=prompt('اكتب وسيلة التحقق أو رقم الطلب بدون بيانات حساسة كاملة:');if(!evidence)return;try{await mpApi('verification',{method:'POST',headers:authHeaders(),body:JSON.stringify({level,evidence})});showToast('تم إرسال طلب التوثيق للمراجعة.','success');await loadMarketplaceState();openMarketplacePanel('verification')}catch(e){showToast(friendlyDbError(e),'error')}}
async function reportProduct(p){if(!user)return showToast(t('toast_login_first'),'error');const reason=prompt('سبب الإبلاغ: إعلان وهمي، سعر مضلل، صور مسروقة، منتج محظور، احتيال');if(!reason)return;const details=prompt('تفاصيل إضافية (اختياري):')||'';try{await mpApi('report',{method:'POST',headers:authHeaders(),body:JSON.stringify({productId:p.id,targetPiId:p.seller_pi_id,reason,details})});showToast('تم إرسال البلاغ للمراجعة.','success')}catch(e){showToast(friendlyDbError(e),'error')}}
async function blockSeller(p){if(!user)return;try{await mpApi('block',{method:'POST',headers:authHeaders(),body:JSON.stringify({targetPiId:p.seller_pi_id})});marketplaceState.blocks.add(p.seller_pi_id);showToast('تم حظر المستخدم.','success');nav('home');renderProducts()}catch(e){showToast(friendlyDbError(e),'error')}}
async function changeItemStatus(id,status){try{await mpApi('status',{method:'PATCH',headers:authHeaders(),body:JSON.stringify({productId:id,status})});showToast('تم تحديث حالة الإعلان.','success');await Promise.all([loadMyAds(),loadAllProducts(true)])}catch(e){showToast(friendlyDbError(e),'error')}}
async function bumpProduct(id){try{await mpApi('bump',{method:'POST',headers:authHeaders(),body:JSON.stringify({productId:id})});showToast('تم رفع الإعلان لأعلى النتائج.','success');await Promise.all([loadMyAds(),loadAllProducts(true)])}catch(e){showToast(friendlyDbError(e),'error')}}
async function submitReview(p){const rating=Number(prompt('التقييم من 1 إلى 5:'));if(!rating)return;const comment=prompt('اكتب تعليقك:')||'';try{await mpApi('review',{method:'POST',headers:authHeaders(),body:JSON.stringify({productId:p.id,rating,comment})});showToast('تم إرسال التقييم.','success')}catch(e){showToast(friendlyDbError(e),'error')}}
async function shareProduct(p){const url=`${location.origin}${location.pathname}?product=${p.id}`;try{if(navigator.share)await navigator.share({title:p.name,text:p.description,url});else{await navigator.clipboard.writeText(url);showToast('تم نسخ رابط الإعلان.','success')}if(user)mpApi('event',{method:'POST',headers:authHeaders(),body:JSON.stringify({productId:p.id,eventType:'share'})}).catch(()=>{})}catch(_) {}}
function renderDetailMarketplace(p){const box=el('detail-marketplace');if(!box||!p)return;const attrs=p.attributes&&typeof p.attributes==='object'?Object.entries(p.attributes):[],fav=marketplaceState.favorites.has(Number(p.id)),own=user&&p.seller_pi_id===user.uid,verified=p.seller_verification_status==='verified';box.innerHTML=`${attrs.length?`<div class="attribute-grid">${attrs.map(([k,v])=>`<div class="attribute-chip"><b>${escapeHtml(k)}</b><br>${escapeHtml(v)}</div>`).join('')}</div>`:''}${p.latitude&&p.longitude?`<div class="map-box"><iframe loading="lazy" referrerpolicy="no-referrer" src="https://www.openstreetmap.org/export/embed.html?bbox=${Number(p.longitude)-.03},${Number(p.latitude)-.03},${Number(p.longitude)+.03},${Number(p.latitude)+.03}&layer=mapnik&marker=${p.latitude},${p.longitude}"></iframe></div>`:''}<div class="detail-market-actions"><button class="btn btn-ghost" onclick="toggleFavorite(${p.id},event)"><i class="fa-${fav?'solid':'regular'} fa-heart"></i>${fav?'محفوظ':'حفظ'}</button><button class="btn btn-ghost" onclick='shareProduct(${JSON.stringify({id:p.id,name:p.name,description:p.description}).replace(/'/g,"&#39;")})'><i class="fa-solid fa-share-nodes"></i>مشاركة</button>${!own?`<button class="btn btn-ghost" onclick="reportProduct(globalProducts.find(x=>x.id==${p.id}))"><i class="fa-solid fa-flag"></i>إبلاغ</button><button class="btn btn-ghost" onclick="blockSeller(globalProducts.find(x=>x.id==${p.id}))"><i class="fa-solid fa-ban"></i>حظر</button>${p.item_status==='sold'?`<button class="btn btn-gold" onclick="submitReview(globalProducts.find(x=>x.id==${p.id}))"><i class="fa-solid fa-star"></i>تقييم</button>`:''}`:''}</div>`;if(verified&&el('detail-seller-name'))el('detail-seller-name').insertAdjacentHTML('beforeend',' <span class="verified-badge"><i class="fa-solid fa-circle-check"></i>موثّق</span>')}
function renderCategoryAttributes(){const c=el('categoryAttributes'),cat=el('addCategory')?.value,fields=CATEGORY_FIELDS[cat]||[];if(!c)return;c.style.display=fields.length?'block':'none';c.innerHTML=fields.length?`<h4>تفاصيل القسم</h4>${fields.map(([k,l])=>`<div class="form-group"><label class="form-label">${l}</label><input class="input-box category-attr" data-key="${k}" maxlength="100"></div>`).join('')}`:''}
function collectAttributes(){return Object.fromEntries([...document.querySelectorAll('.category-attr')].map(x=>[x.dataset.key,x.value.trim()]).filter(x=>x[1]))}
function captureApproxLocation(){if(!navigator.geolocation)return showToast('الموقع غير مدعوم.','error');navigator.geolocation.getCurrentPosition(pos=>{el('addLatitude').value=Number(pos.coords.latitude).toFixed(3);el('addLongitude').value=Number(pos.coords.longitude).toFixed(3);safeSetText('locationPrivacyNote','تم حفظ موقع تقريبي بدقة نحو 100 متر.')},()=>showToast('تعذر قراءة الموقع. يمكنك نشر الإعلان بدونه.','warning'),{enableHighAccuracy:false,timeout:8000,maximumAge:300000})}

// Extend existing screens without changing Pi authentication or payment flows.
const _mpOpenDetails=openProductDetails;openProductDetails=async function(pid){await _mpOpenDetails(pid);const p=globalProducts.find(x=>x.id==pid);renderDetailMarketplace(p);if(user&&p)mpApi('event',{method:'POST',headers:authHeaders(),body:JSON.stringify({productId:Number(pid),eventType:'view'})}).catch(()=>{})};
const _mpRenderProducts=renderProducts;renderProducts=function(){if(marketplaceState.blocks.size)globalProducts=globalProducts.filter(p=>!marketplaceState.blocks.has(p.seller_pi_id));_mpRenderProducts();document.querySelectorAll('#products-list .card').forEach(card=>{const m=String(card.getAttribute('onclick')||'').match(/(\d+)/);if(!m)return;const id=Number(m[1]),p=globalProducts.find(x=>x.id===id);if(!p)return;const btn=document.createElement('button');btn.className=`favorite-btn ${marketplaceState.favorites.has(id)?'active':''}`;btn.innerHTML=`<i class="fa-${marketplaceState.favorites.has(id)?'solid':'regular'} fa-heart"></i>`;btn.onclick=e=>toggleFavorite(id,e);card.appendChild(btn);const st=document.createElement('span');st.className='status-badge';st.textContent=statusText(p.item_status);card.appendChild(st)})};
const _mpLoadMyAds=loadMyAds;loadMyAds=async function(){await _mpLoadMyAds();document.querySelectorAll('#my-ads-list .card').forEach(card=>{const m=card.innerHTML.match(/openProductDetails\((\d+)\)/);if(!m)return;const id=Number(m[1]),p=globalProducts.find(x=>x.id===id);const actions=card.lastElementChild;if(actions){actions.insertAdjacentHTML('afterbegin',`<select class="input-box" style="flex:1;padding:8px" onchange="changeItemStatus(${id},this.value)"><option value="available">متاح</option><option value="reserved">محجوز</option><option value="sold">تم البيع</option><option value="expired">منتهي</option></select><button class="mini-btn mini-primary" onclick="bumpProduct(${id})">رفع</button>`)}})};
document.addEventListener('DOMContentLoaded',()=>{el('addCategory')?.addEventListener('change',renderCategoryAttributes);setTimeout(()=>{if(user)loadMarketplaceState()},800)});
function currentFilteredProducts(){const q=String(el('searchInput')?.value||'').trim().toLocaleLowerCase(),cf=el('countryFilter')?.value||'all',sf=el('stateFilter')?.value||'all';return globalProducts.filter(p=>(activeCategory==='all'||String(p.category)===String(activeCategory))&&(!q||`${p.name||''} ${p.description||''}`.toLocaleLowerCase().includes(q))&&(cf==='all'||p.country===cf)&&(sf==='all'||p.location===sf)&&!marketplaceState.blocks.has(p.seller_pi_id))}
function openProductsMap(){const items=currentFilteredProducts().filter(p=>Number.isFinite(Number(p.latitude))&&Number.isFinite(Number(p.longitude)));const modal=el('productsMapModal'),body=el('productsMapBody');if(!items.length){body.innerHTML='<div class="empty-state"><h3>لا توجد إعلانات بموقع تقريبي ضمن النتائج الحالية.</h3></div>'}else{const p=items[0];body.innerHTML=`<div class="map-box" style="height:300px"><iframe loading="lazy" referrerpolicy="no-referrer" src="https://www.openstreetmap.org/export/embed.html?bbox=${Number(p.longitude)-.08},${Number(p.latitude)-.08},${Number(p.longitude)+.08},${Number(p.latitude)+.08}&layer=mapnik&marker=${p.latitude},${p.longitude}"></iframe></div><div class="market-list" style="margin-top:12px">${items.map(x=>`<div class="market-row"><div><b>${escapeHtml(x.name)}</b><small style="display:block">${escapeHtml(x.country||'')} - ${escapeHtml(x.location||'')}</small></div><button class="mini-btn mini-primary" onclick="closeProductsMap();openProductDetails(${x.id})">عرض</button></div>`).join('')}</div>`}modal.style.display='flex'}
function closeProductsMap(){el('productsMapModal').style.display='none'}
