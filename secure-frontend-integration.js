/* Add after the current app script, then replace direct Supabase product writes with these functions. */
let piAccessToken = null;

async function securePiLogin() {
  const auth = await Pi.authenticate(['username', 'payments'], payment => {
    console.warn('Incomplete payment found', payment);
  });
  piAccessToken = auth.accessToken;
  sessionStorage.setItem('pi_access_token', piAccessToken);
  handleLogin(auth.user.uid, auth.user.username);
}

function apiHeaders() {
  const token = piAccessToken || sessionStorage.getItem('pi_access_token');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

async function fileToCompressedData(file) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) throw new Error(t('images_only') || 'Images only');
  if (file.size > 10 * 1024 * 1024) throw new Error(t('image_too_large') || 'Original image is too large');
  const compressed = await imageCompression(file, {
    maxSizeMB: 1.5,
    maxWidthOrHeight: 1600,
    useWebWorker: true,
    preserveExif: false,
    initialQuality: 0.85
  });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ data: reader.result, name: file.name });
    reader.onerror = reject;
    reader.readAsDataURL(compressed);
  });
}

async function secureSubmitProduct() {
  if (!user) return showToast('toast_login_first', 'error');
  const name = el('addName').value.trim();
  const description = el('addDesc').value.trim();
  const priceUsd = Number(el('addPrice').value);
  if (!name || !description || !priceUsd || selectedFiles.length < 1 || selectedFiles.length > 3) {
    return showToast(currentLang === 'ar' ? 'الاسم والوصف والسعر وصورة واحدة على الأقل مطلوبة' : 'Name, description, price and at least one image are required', 'error');
  }
  const images = [];
  for (const file of selectedFiles) images.push(await fileToCompressedData(file));
  const response = await fetch('/api/products', {
    method: 'POST', headers: apiHeaders(), body: JSON.stringify({
      name, description, priceUsd, images,
      category: el('addCategory').value,
      country: el('addCountry').value,
      location: el('addState').value
    })
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || 'Could not submit ad');
  showToast(currentLang === 'ar' ? 'تم إرسال الإعلان للمراجعة' : 'Ad submitted for review', 'success');
  closeAddModal();
  await secureLoadMyAds();
}

async function secureLoadMyAds() {
  const response = await fetch('/api/products', { headers: apiHeaders() });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error);
  return json.products; // render status badges: pending / approved / rejected
}

async function secureDeleteProduct(id) {
  const accepted = await brandedConfirm({
    title: currentLang === 'ar' ? 'حذف الإعلان؟' : 'Delete ad?',
    message: currentLang === 'ar' ? 'لا يمكن التراجع عن هذا الإجراء.' : 'This action cannot be undone.',
    confirmText: currentLang === 'ar' ? 'حذف' : 'Delete'
  });
  if (!accepted) return;
  const response = await fetch('/api/products', { method: 'DELETE', headers: apiHeaders(), body: JSON.stringify({ id }) });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error);
  await secureLoadMyAds();
}

function brandedConfirm({ title, message, confirmText }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal'; overlay.style.display = 'flex';
    overlay.innerHTML = `<div class="sheet" style="max-width:420px;border-radius:24px;margin:auto">
      <div class="section-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>
      <h3>${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p>
      <div style="display:flex;gap:12px"><button class="btn btn-ghost cancel" style="flex:1">${currentLang==='ar'?'إلغاء':'Cancel'}</button>
      <button class="btn btn-danger ok" style="flex:1">${escapeHtml(confirmText)}</button></div></div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.cancel').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('.ok').onclick = () => { overlay.remove(); resolve(true); };
  });
}

// Live USD -> PI preview under price input.
function installPiPreview() {
  const price = el('addPrice');
  if (!price || document.getElementById('piPricePreview')) return;
  const preview = document.createElement('small'); preview.id = 'piPricePreview'; preview.style.fontWeight = '800';
  price.parentElement.appendChild(preview);
  const update = () => preview.textContent = piUsdPrice && Number(price.value) > 0
    ? `≈ ${formatPi(Number(price.value) / piUsdPrice)} π • OKX`
    : (currentLang === 'ar' ? 'سيظهر المقابل بعملة Pi هنا' : 'PI equivalent appears here');
  price.addEventListener('input', update); setInterval(update, 60000); update();
}
