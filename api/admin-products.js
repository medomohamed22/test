'use strict';

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
);
const BUCKET = 'product-images';

function httpError(message, statusCode = 400, code = 'BAD_REQUEST') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function clean(value, min, max) {
  const text = String(value || '').normalize('NFKC').trim();
  if (text.length < min || text.length > max) throw httpError('سبب الرفض يجب أن يكون بين 3 و500 حرف');
  if (/<[^>]*>|javascript:|data:text\/html|on\w+\s*=/i.test(text)) throw httpError('سبب الرفض يحتوي على محتوى غير مسموح');
  return text.replace(/[\u0000-\u001F\u007F]/g, ' ');
}

async function verifyAdmin(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+([^\s]+)$/i);
  if (!match) throw httpError('سجّل الدخول بحساب Pi أولًا', 401, 'PI_TOKEN_MISSING');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('https://api.minepi.com/v2/me', {
      headers: { Authorization: `Bearer ${match[1]}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    const piUser = await response.json().catch(() => ({}));
    if (!response.ok || !piUser.uid) throw httpError('جلسة Pi غير صالحة، سجّل الدخول من جديد', 401, 'PI_TOKEN_INVALID');

    const { data, error } = await sb
      .from('app_users')
      .select('pi_uid,username,role,is_banned')
      .eq('pi_uid', String(piUser.uid))
      .maybeSingle();
    if (error) throw httpError(`تعذر التحقق من صلاحية الأدمن: ${error.message}`, 500, 'ADMIN_LOOKUP_FAILED');
    if (!data || data.role !== 'admin') throw httpError('هذا الحساب ليس لديه صلاحية الأدمن', 403, 'NOT_ADMIN');
    if (data.is_banned) throw httpError('هذا الحساب محظور', 403, 'ADMIN_BANNED');
    return { uid: String(piUser.uid), username: data.username || piUser.username || 'Admin' };
  } catch (error) {
    if (error.name === 'AbortError') throw httpError('انتهت مهلة التحقق من Pi، حاول مرة أخرى', 503, 'PI_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function storagePath(url) {
  try {
    const parsed = new URL(url);
    const marker = '/storage/v1/object/public/product-images/';
    const index = parsed.pathname.indexOf(marker);
    return index < 0 ? null : decodeURIComponent(parsed.pathname.slice(index + marker.length));
  } catch {
    return null;
  }
}

async function removeImages(urls) {
  const paths = (urls || []).map(storagePath).filter(Boolean);
  if (!paths.length) return;
  const { error } = await sb.storage.from(BUCKET).remove(paths);
  if (error) throw httpError(`تعذر حذف صور الإعلان: ${error.message}`, 500, 'IMAGE_DELETE_FAILED');
}

async function safeQuery(label, promise, fallback) {
  try {
    const result = await promise;
    if (result.error) throw result.error;
    return { value: result.data ?? fallback, warning: null };
  } catch (error) {
    console.error(`admin query ${label}:`, error);
    return { value: fallback, warning: `${label}: ${error.message}` };
  }
}

async function countRows(table, filter) {
  let query = sb.from(table).select('*', { count: 'exact', head: true });
  if (filter) query = filter(query);
  const { count, error } = await query;
  if (error) throw error;
  return count || 0;
}

async function getDashboard() {
  const [pendingResult, usersResult, paymentsResult] = await Promise.all([
    safeQuery('الإعلانات المعلقة', sb.from('products').select('*').eq('status', 'pending').order('created_at', { ascending: true }).limit(200), []),
    safeQuery('المستخدمون', sb.from('app_users').select('pi_uid,username,role,is_banned,telegram_chat_id,telegram_username,created_at').order('created_at', { ascending: false }).limit(500), []),
    safeQuery('المدفوعات', sb.from('payments').select('payment_id,user_id,product_id,amount_pi,amount_usd,tier,days,status,txid,completed_at,created_at').order('created_at', { ascending: false }).limit(250), []),
  ]);

  const warnings = [pendingResult.warning, usersResult.warning, paymentsResult.warning].filter(Boolean);
  const users = usersResult.value;
  const payments = paymentsResult.value;

  // Enrich payments without requiring database joins or foreign-key metadata.
  const userMap = Object.fromEntries(users.map((u) => [u.pi_uid, u.username]));
  const productIds = [...new Set(payments.map((p) => p.product_id).filter(Boolean))];
  const productResult = productIds.length
    ? await safeQuery('بيانات منتجات المدفوعات', sb.from('products').select('id,name,seller_username').in('id', productIds), [])
    : { value: [], warning: null };
  if (productResult.warning) warnings.push(productResult.warning);
  const productMap = Object.fromEntries(productResult.value.map((p) => [String(p.id), p]));
  const enrichedPayments = payments.map((payment) => ({
    ...payment,
    username: userMap[payment.user_id] || payment.user_id,
    product_name: productMap[String(payment.product_id)]?.name || `#${payment.product_id || '-'}`,
  }));

  const countTasks = {
    users: () => countRows('app_users'),
    products: () => countRows('products'),
    pending: () => countRows('products', (q) => q.eq('status', 'pending')),
    approved: () => countRows('products', (q) => q.eq('status', 'approved')),
    rejected: () => countRows('products', (q) => q.eq('status', 'rejected')),
    promoted: () => countRows('products', (q) => q.eq('status', 'approved').gt('promoted_until', new Date().toISOString())),
    completedPayments: () => countRows('payments', (q) => q.eq('status', 'completed')),
  };
  const stats = {};
  await Promise.all(Object.entries(countTasks).map(async ([key, task]) => {
    try { stats[key] = await task(); }
    catch (error) { stats[key] = 0; warnings.push(`${key}: ${error.message}`); }
  }));

  const viewsResult = await safeQuery('إجمالي المشاهدات', sb.from('products').select('views'), []);
  if (viewsResult.warning) warnings.push(viewsResult.warning);
  stats.totalViews = viewsResult.value.reduce((sum, row) => sum + Number(row.views || 0), 0);

  const completed = payments.filter((p) => p.status === 'completed');
  stats.promotionRevenueUsd = completed.reduce((sum, p) => sum + Number(p.amount_usd || 0), 0);
  stats.promotionRevenuePi = completed.reduce((sum, p) => sum + Number(p.amount_pi || 0), 0);

  return {
    pending: pendingResult.value,
    users,
    payments: enrichedPayments,
    stats,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const admin = await verifyAdmin(req);

    if (req.method === 'GET') {
      const dashboard = await getDashboard();
      return res.status(200).json({ ...dashboard, admin });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const id = Number(body.id);
      const action = String(body.action || '');
      if (!Number.isInteger(id) || !['approve', 'reject'].includes(action)) throw httpError('طلب مراجعة غير صالح');

      const { data: product, error: productError } = await sb.from('products').select('*').eq('id', id).eq('status', 'pending').maybeSingle();
      if (productError) throw httpError(productError.message, 500, 'PRODUCT_LOOKUP_FAILED');
      if (!product) throw httpError('الإعلان غير موجود أو تمت مراجعته بالفعل', 404, 'PRODUCT_NOT_PENDING');

      if (action === 'approve') {
        if (!Array.isArray(product.images) || !product.images.length) throw httpError('لا يمكن قبول إعلان بدون صور');
        const { data, error } = await sb.from('products').update({
          status: 'approved', reviewed_by: admin.uid, reviewed_at: new Date().toISOString(), rejection_reason: null,
        }).eq('id', id).select().single();
        if (error) throw httpError(error.message, 500, 'APPROVE_FAILED');
        return res.status(200).json({ product: data });
      }

      const reason = clean(body.reason, 3, 500);
      await removeImages(product.images);
      const { data, error } = await sb.from('products').update({
        status: 'rejected', images: [], reviewed_by: admin.uid, reviewed_at: new Date().toISOString(), rejection_reason: reason,
        promoted_until: null, promotion_tier: null, promoted_level: null, promoted_priority: null,
      }).eq('id', id).select().single();
      if (error) throw httpError(error.message, 500, 'REJECT_FAILED');
      return res.status(200).json({ product: data });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('admin-products:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Internal server error', code: error.code || 'ADMIN_ERROR' });
  }
};
