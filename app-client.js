'use strict';

// Pi access tokens are intentionally kept only in memory.
// No cookies, localStorage, sessionStorage, or frontend database keys are used.
let piAccessToken = null;
let piInitialized = false;
let loginInProgress = false;

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
    cache: String(path).startsWith('public-products') && (!options.method || options.method === 'GET') ? 'default' : 'no-store',
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
  if (piInitialized) return window.Pi;
  const pi = await waitForPiSdk();
  await Promise.resolve(pi.init({ version: '2.0', sandbox: false }));
  piInitialized = true;
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
      await handleLogin();
    } catch (e) {
      console.error('Pi login failed:', e);
      piAccessToken = null;
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
    await Promise.all([loadMyAds(), loadInbox(), checkUnreadMessages()]);
    setInterval(checkUnreadMessages, 10000);
  } catch (e) {
    piAccessToken = null;
    showToast(friendlyDbError(e), 'error');
  }
}

async function refreshTelegramButton(showErrors=false){const btn=el('telegramLinkBtn'),txt=el('telegramLinkText');if(!btn||!txt||!user)return;try{const d=await api('telegram-link',{headers:authHeaders(false)});btn.disabled=d.linked;btn.classList.toggle('btn-disabled',d.linked);txt.innerText=d.linked?(currentLang==='ar'?'تم الربط':'Linked'):(currentLang==='ar'?'ربط بوت تيليجرام':'Link Telegram Bot')}catch(e){if(showErrors)showToast(e.message,'error')}}
async function linkTelegramBot(){if(!user)return showToast('toast_login_first','error');try{const d=await api('telegram-link',{method:'POST',headers:authHeaders(),body:'{}'});openTelegramExternal(BOT_USERNAME,d.token);if(telegramCheckTimer)clearInterval(telegramCheckTimer);telegramCheckTimer=setInterval(()=>refreshTelegramButton(false),2500)}catch(e){showToast(e.message,'error')}}
async function loadAllProducts(){el('loading').style.display='block';try{const d=await api('public-products');globalProducts=(d.products||[]).sort(sortProductsByPromotion);renderProducts();openProductFromUrlOnce()}catch(e){safeSetHtml('products-list',`<div class="empty-state" style="grid-column:1/-1"><h3>خطأ</h3><p>${escapeHtml(e.message)}</p></div>`)}finally{el('loading').style.display='none'}}
async function openProductDetails(pid){const p=globalProducts.find(x=>x.id==pid);if(!p)return;try{const d=await api('public-products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:Number(pid)})});p.views=d.views||p.views}catch(_){}const images=Array.isArray(p.images)&&p.images.length?p.images:['https://placehold.co/600x600/f1f5f9/94a3b8?text=No+Image'];el('detail-slider').innerHTML=images.map(src=>`<div class="slide"><img src="${escapeAttr(src)}" class="slide-img"></div>`).join('');el('detail-dots').innerHTML=images.map((_,i)=>`<div class="dot ${i===0?'active':''}" onclick="goToSlide(${i})"></div>`).join('');safeSetText('detail-title',p.name);updateDetailPrice(p);safeSetText('detail-desc',p.description);safeSetText('detail-loc-text',`${p.country||''} - ${p.location||''}`);safeSetText('detail-views',formatCurrency(p.views||0));safeSetText('detail-seller-name',p.seller_username||'Unknown');safeSetText('detail-seller-avatar',(p.seller_username||'U').charAt(0).toUpperCase());const own=user&&p.seller_pi_id===user.uid;el('detail-actions').innerHTML=own?`<button onclick="openPromoteOptions(${Number(p.id)})" class="btn" style="width:100%">${escapeHtml(t('promote_ad_btn'))}</button><button onclick="deleteProduct(${Number(p.id)})" class="btn btn-danger" style="width:100%">${escapeHtml(t('delete_btn'))}</button>`:`<button onclick="openChatRoom(${Number(p.id)},'${escapeAttr(p.seller_pi_id)}','${escapeAttr(p.name)}','${escapeAttr(p.seller_username||'User')}')" class="btn btn-primary" style="width:100%">${escapeHtml(t('message_seller'))}</button>`;document.querySelectorAll('.view-section').forEach(e=>e.classList.add('hidden'));el('view-details').classList.remove('hidden')}
async function loadMyAds(){if(!user)return;const list=el('my-ads-list');try{const d=await api('products',{headers:authHeaders(false)}),products=d.products||[];safeSetText('stat-ads',products.length);safeSetText('stat-views',formatCurrency(products.reduce((s,p)=>s+(p.views||0),0)));list.innerHTML=products.map(p=>{const img=p.images?.[0]||'https://placehold.co/400x400/f1f5f9/94a3b8?text=No+Image',ar=currentLang==='ar',state=p.status==='pending'?(ar?'قيد المراجعة':'Pending'):p.status==='rejected'?(ar?'مرفوض':'Rejected'):(ar?'مقبول':'Approved'),reason=p.status==='rejected'&&p.rejection_reason?`<div style="margin-top:8px;padding:9px;border-radius:10px;background:#fef2f2;color:#b91c1c;font-size:12px">${escapeHtml(ar?'سبب الرفض: ':'Reason: ')}${escapeHtml(p.rejection_reason)}</div>`:'';return `<div class="card"><div onclick="openProductDetails(${Number(p.id)})"><div class="card-img-wrap"><img src="${escapeAttr(img)}" class="card-img" loading="lazy"></div><div class="card-body"><div class="card-title">${escapeHtml(p.name)}</div><div>${escapeHtml(state)}</div>${reason}</div></div><div style="display:flex;gap:8px;padding:0 12px 12px"><button class="btn btn-danger" style="flex:1;padding:9px" onclick="deleteProduct(${Number(p.id)})">${escapeHtml(t('delete_btn'))}</button></div></div>`}).join('')||`<div class="empty-state"><h3>${escapeHtml(t('no_products'))}</h3></div>`}catch(e){list.innerHTML=`<div class="empty-state"><p>${escapeHtml(friendlyDbError(e))}</p></div>`}}
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
 try{const images=[];for(const file of selectedFiles){if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Object.assign(new Error(),{code:'IMAGE_TYPE'});const compressed=await imageCompression(file,{maxSizeMB:.8,maxWidthOrHeight:1600,useWebWorker:true,fileType:'image/jpeg',initialQuality:.88});images.push({data:await fileToDataUrl(compressed)})}btn.innerHTML=ar?'جاري الإرسال للمراجعة...':'Sending for review...';await api('products',{method:'POST',headers:authHeaders(),body:JSON.stringify({name,description,priceUsd:price,category,country,location,images})});showToast(ar?'تم إرسال الإعلان للمراجعة.':'Ad sent for review.','success');closeAddModal();await loadMyAds()}catch(e){showToast(friendlyDbError(e),'error')}finally{btn.disabled=false;btn.innerHTML=t('publish_btn')}}
async function deleteProduct(id){if(!confirm(t('confirm_delete')))return;try{await api('products',{method:'DELETE',headers:authHeaders(),body:JSON.stringify({id})});await Promise.all([loadMyAds(),loadAllProducts()]);nav('home')}catch(e){showToast(e.message,'error')}}
function openPromoteOptions(id){currentPromoteProductId=id;renderPromotionPlanPrices();el('promoteModal').style.display='flex'}function closePromoteModal(){el('promoteModal').style.display='none';currentPromoteProductId=null}function triggerPayment(_usd,_days,tier){if(!currentPromoteProductId)return;const id=currentPromoteProductId;closePromoteModal();promoteProduct(id,tier)}
async function promoteProduct(productId,tier){if(!window.Pi||!user)return showToast('Pi Browser Required','error');const plan={1:1,2:5,3:10}[tier];try{await refreshPiPrice();const amount=Number((plan/piUsdPrice).toFixed(8));window.Pi.createPayment({amount,memo:`Promote Ad ${productId}`,metadata:{type:'promotion',productId:Number(productId),tier:Number(tier)}},{onReadyForServerApproval:async paymentId=>{await api('approve',{method:'POST',headers:authHeaders(),body:JSON.stringify({paymentId})})},onReadyForServerCompletion:async(paymentId,txid)=>{await api('complete',{method:'POST',headers:authHeaders(),body:JSON.stringify({paymentId,txid})});showToast('Promotion Active!','success');await loadAllProducts()},onCancel:()=>showToast('Payment Cancelled','warning'),onError:e=>showToast(e.message||'Payment Failed','error')})}catch(e){showToast(friendlyDbError(e),'error')}}
function openChatRoom(pid,otherId,pName,uName){if(!user)return showToast('toast_login_first','error');activeChat={pid,otherId};safeSetText('chatTitle',pName);safeSetText('chatPeer',uName);el('chatModal').style.display='flex';loadMessages();api('messages',{method:'PATCH',headers:authHeaders(),body:JSON.stringify({productId:pid,otherPiId:otherId})}).catch(()=>{})}
async function loadMessages(){if(!activeChat)return;const d=await api(`messages?productId=${encodeURIComponent(activeChat.pid)}`,{headers:authHeaders(false)});el('msgContainer').innerHTML='';(d.messages||[]).filter(m=>(m.sender_pi_id===user.uid&&m.receiver_pi_id===activeChat.otherId)||(m.sender_pi_id===activeChat.otherId&&m.receiver_pi_id===user.uid)).forEach(renderMsg)}
function renderMsg(m){const div=document.createElement('div');div.className=`bubble ${m.sender_pi_id===user.uid?'me':'other'}`;div.innerText=m.content;el('msgContainer').appendChild(div)}
async function sendMsg(){const inp=el('msgInput');if(!activeChat||!inp.value.trim())return;try{await api('messages',{method:'POST',headers:authHeaders(),body:JSON.stringify({productId:activeChat.pid,receiverPiId:activeChat.otherId,content:inp.value.trim()})});inp.value='';await loadMessages()}catch(e){showToast(e.message,'error')}}
function closeChat(){el('chatModal').style.display='none';activeChat=null}
async function loadInbox(){if(!user)return;const list=el('inbox-list');try{const d=await api('messages',{headers:authHeaders(false)}),threads=new Map();(d.messages||[]).slice().reverse().forEach(m=>{const other=m.sender_pi_id===user.uid?m.receiver_pi_id:m.sender_pi_id,key=`${m.product_id}_${other}`;if(!threads.has(key))threads.set(key,{pid:m.product_id,otherId:other,pName:m.products?.name||'Item',last:m.content,name:m.sender_pi_id===other?m.sender_username:m.receiver_username,unread:!m.is_read&&m.receiver_pi_id===user.uid})});list.innerHTML=[...threads.values()].map(x=>`<div class="inbox-item ${x.unread?'unread':''}" onclick="openChatRoom(${x.pid},'${escapeAttr(x.otherId)}','${escapeAttr(x.pName)}','${escapeAttr(x.name)}')"><div class="inbox-info"><div class="inbox-name">${escapeHtml(x.name)}</div><div class="inbox-msg">${escapeHtml(x.last)}</div></div></div>`).join('')||`<div class="empty-state"><h3>${escapeHtml(t('no_messages'))}</h3></div>`}catch(e){list.innerHTML=`<p>${escapeHtml(e.message)}</p>`}}
async function checkUnreadMessages(){if(!user)return;try{const d=await api('messages',{headers:authHeaders(false)}),count=(d.messages||[]).filter(m=>!m.is_read&&m.receiver_pi_id===user.uid).length,b=el('chat-badge');if(count){b.innerText=count>9?'+9':count;b.classList.remove('hidden')}else b.classList.add('hidden')}catch(_){}}
document.addEventListener('DOMContentLoaded',()=>{updateLanguage();initDragAndDrop();initPi();refreshPiPrice();loadAllProducts();initLocations()});setInterval(refreshPiPrice,60000);
