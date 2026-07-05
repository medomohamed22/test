const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const PI_API_KEY = process.env.PI_API_KEY;
const PI_API_BASE = 'https://api.minepi.com/v2';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req) {
  if (!req.body) return {};
  return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
}

function parseMetadata(metadata) {
  if (!metadata) return {};
  if (typeof metadata === 'string') {
    try { return JSON.parse(metadata); } catch (_) { return {}; }
  }
  return metadata;
}

async function updateProductWithFallback(productId, promotedUntil, level, paymentId, txid) {
  const promotedLevel = Number(level || 1);
  const attempts = [
    { promoted_until: promotedUntil, promoted_level: promotedLevel, promotion_tier: promotedLevel, promoted_priority: promotedLevel, last_payment_id: paymentId || null, last_payment_txid: txid || null },
    { promoted_until: promotedUntil, promoted_level: promotedLevel, promotion_tier: promotedLevel, promoted_priority: promotedLevel },
    { promoted_until: promotedUntil, promoted_level: promotedLevel },
    { promoted_until: promotedUntil, promotion_tier: promotedLevel },
    { promoted_until: promotedUntil, promoted_priority: promotedLevel },
    { promoted_until: promotedUntil }
  ];

  let lastError = null;
  for (const payload of attempts) {
    const { error } = await supabase.from('products').update(payload).eq('id', productId);
    if (!error) return;
    lastError = error;
    if (!/column|schema cache|Could not find|last_payment|promoted_level|promotion_tier|promoted_priority/i.test(error.message || '')) break;
  }
  throw lastError || new Error('Promotion update failed');
}

async function applyPromotion(productId, days, level, paymentId, txid) {
  const { data: prod, error: readError } = await supabase
    .from('products')
    .select('promoted_until')
    .eq('id', productId)
    .single();

  if (readError) throw readError;

  let expiry = new Date();
  if (prod && prod.promoted_until && new Date(prod.promoted_until) > new Date()) {
    expiry = new Date(prod.promoted_until);
  }
  expiry.setDate(expiry.getDate() + Number(days || 3));
  const promotedUntil = expiry.toISOString();

  await updateProductWithFallback(productId, promotedUntil, level, paymentId, txid);
  return promotedUntil;
}

async function logPaymentWithFallback(row) {
  const attempts = [
    row,
    { payment_id: row.payment_id, user_id: row.user_id, product_id: row.product_id, amount: row.amount, status: row.status, txid: row.txid },
  ];

  for (const payload of attempts) {
    const { error } = await supabase.from('payments').upsert(payload, { onConflict: 'payment_id' });
    if (!error) return;
    if (!/column|schema cache|Could not find|amount_pi|amount_usd|pi_usd_price|days|promoted_until/i.test(error.message || '')) {
      console.warn('Payment log warning:', error);
      return;
    }
  }
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = readBody(req);
    const { paymentId, txid } = body;
    if (!paymentId || !txid) return res.status(400).json({ error: 'paymentId and txid are required' });

    const completeRes = await fetch(`${PI_API_BASE}/payments/${paymentId}/complete`, {
      method: 'POST',
      headers: { Authorization: `Key ${PI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ txid })
    });

    if (!completeRes.ok) {
      console.warn('Pi complete warning:', await completeRes.text());
    }

    const piRes = await fetch(`${PI_API_BASE}/payments/${paymentId}`, {
      headers: { Authorization: `Key ${PI_API_KEY}` }
    });

    if (!piRes.ok) throw new Error(`Could not fetch payment from Pi: ${await piRes.text()}`);
    const piData = await piRes.json();
    const metadata = parseMetadata(piData.metadata);

    const productId = metadata.productId || metadata.product_id || metadata.id || body.productId || body.product_id;
    if (!productId) return res.status(200).json({ error: 'Product ID missing from metadata/body' });

    const amountPi = Number(piData.amount || metadata.piAmount || body.piAmount || 0);
    const usdAmount = Number(metadata.usdAmount || body.usdAmount || 0);
    const days = Number(metadata.days || body.days || (usdAmount >= 10 ? 14 : usdAmount >= 5 ? 7 : 3));
    const level = Number(metadata.level || body.level || usdAmount || 1);

    const promotedUntil = await applyPromotion(productId, days, level, paymentId, txid);

    await logPaymentWithFallback({
      payment_id: paymentId,
      user_id: piData.user_uid || metadata.sellerPiId || null,
      product_id: productId,
      amount: amountPi,
      amount_pi: amountPi,
      amount_usd: usdAmount || null,
      pi_usd_price: metadata.piUsdPrice ? Number(metadata.piUsdPrice) : (body.piUsdPrice ? Number(body.piUsdPrice) : null),
      status: 'completed',
      txid,
      days,
      promoted_until: promotedUntil
    });

    return res.status(200).json({
      success: true,
      completed: true,
      productId,
      daysAdded: days,
      promotedLevel: level,
      promotedUntil
    });
  } catch (err) {
    console.error('complete error:', err);
    return res.status(500).json({ error: err.message });
  }
};
