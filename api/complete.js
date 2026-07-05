const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PI_API_KEY = process.env.PI_API_KEY;
const PI_API_BASE = 'https://api.minepi.com/v2';

if (!SUPABASE_URL) throw new Error('Missing SUPABASE_URL');
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
if (!PI_API_KEY) throw new Error('Missing PI_API_KEY');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

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
    try { return JSON.parse(metadata); } catch { return {}; }
  }
  return metadata;
}

async function applyPromotion(productId, days, level, paymentId, txid) {
  const { data: product, error: readError } = await supabase
    .from('products')
    .select('id, promoted_until')
    .eq('id', productId)
    .single();

  if (readError) throw readError;
  if (!product) throw new Error('Product not found');

  let expiry = new Date();

  if (product.promoted_until && new Date(product.promoted_until) > expiry) {
    expiry = new Date(product.promoted_until);
  }

  expiry.setDate(expiry.getDate() + Number(days || 3));

  const payload = {
    promoted_until: expiry.toISOString(),
    promoted_level: Number(level || 1),
    promotion_tier: Number(level || 1),
    promoted_priority: Number(level || 1),
    last_payment_id: paymentId,
    last_payment_txid: txid
  };

  const { error } = await supabase
    .from('products')
    .update(payload)
    .eq('id', productId);

  if (error) throw error;

  return expiry.toISOString();
}

async function logPayment(row) {
  const { error } = await supabase
    .from('payments')
    .upsert(row, { onConflict: 'payment_id' });

  if (error) console.warn('Payment log warning:', error.message);
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = readBody(req);
    const { paymentId, txid } = body;

    if (!paymentId || !txid) {
      return res.status(400).json({ error: 'paymentId and txid are required' });
    }

    await fetch(`${PI_API_BASE}/payments/${paymentId}/complete`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${PI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ txid })
    });

    const piRes = await fetch(`${PI_API_BASE}/payments/${paymentId}`, {
      headers: { Authorization: `Key ${PI_API_KEY}` }
    });

    if (!piRes.ok) {
      throw new Error(`Could not fetch payment from Pi: ${await piRes.text()}`);
    }

    const piData = await piRes.json();
    const metadata = parseMetadata(piData.metadata);

    const productId =
      metadata.productId ||
      metadata.product_id ||
      body.productId ||
      body.product_id;

    if (!productId) {
      return res.status(400).json({ error: 'Product ID missing' });
    }

    const usdAmount = Number(metadata.usdAmount || body.usdAmount || 0);
    const days = Number(metadata.days || body.days || (usdAmount >= 10 ? 14 : usdAmount >= 5 ? 7 : 3));
    const level = Number(metadata.level || body.level || usdAmount || 1);
    const amountPi = Number(piData.amount || metadata.piAmount || body.piAmount || 0);

    const promotedUntil = await applyPromotion(productId, days, level, paymentId, txid);

    await logPayment({
      payment_id: paymentId,
      user_id: piData.user_uid || metadata.sellerPiId || null,
      product_id: productId,
      amount: amountPi,
      amount_pi: amountPi,
      amount_usd: usdAmount || null,
      pi_usd_price: metadata.piUsdPrice || body.piUsdPrice || null,
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
