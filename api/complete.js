const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
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

async function applyPromotion(productId, days, level) {
  const { data: prod } = await supabase
    .from('products')
    .select('promoted_until')
    .eq('id', productId)
    .single();

  let newExpiry = new Date();
  if (prod && prod.promoted_until && new Date(prod.promoted_until) > new Date()) {
    newExpiry = new Date(prod.promoted_until);
  }
  newExpiry.setDate(newExpiry.getDate() + Number(days || 3));

  const fullUpdate = {
    promoted_until: newExpiry.toISOString(),
    promoted_level: Number(level || 1),
    promotion_tier: Number(level || 1)
  };

  let { error } = await supabase.from('products').update(fullUpdate).eq('id', productId);

  // لو الأعمدة الجديدة لسه مش موجودة في Supabase، التمييز هيشتغل بالعمود القديم فقط.
  if (error && /promoted_level|promotion_tier|column/i.test(error.message || '')) {
    ({ error } = await supabase
      .from('products')
      .update({ promoted_until: newExpiry.toISOString() })
      .eq('id', productId));
  }

  if (error) throw error;
  return newExpiry.toISOString();
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { paymentId, txid } = readBody(req);
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

    const productId = metadata.productId || metadata.product_id || metadata.id;
    if (!productId) return res.status(200).json({ error: 'Product ID missing from metadata' });

    const amountPi = Number(piData.amount || 0);
    const usdAmount = Number(metadata.usdAmount || 0);
    const days = Number(metadata.days || (usdAmount >= 10 ? 14 : usdAmount >= 5 ? 7 : 3));
    const level = Number(metadata.level || usdAmount || 1);

    const { error: payError } = await supabase.from('payments').upsert({
      payment_id: paymentId,
      user_id: piData.user_uid,
      product_id: productId,
      amount: amountPi,
      amount_pi: amountPi,
      amount_usd: usdAmount || null,
      pi_usd_price: metadata.piUsdPrice ? Number(metadata.piUsdPrice) : null,
      status: 'completed',
      txid
    }, { onConflict: 'payment_id' });

    if (payError) console.error('payment log warning:', payError);

    const promotedUntil = await applyPromotion(productId, days, level);

    return res.status(200).json({
      success: true,
      completed: true,
      daysAdded: days,
      promotedLevel: level,
      promotedUntil
    });
  } catch (err) {
    console.error('complete error:', err);
    return res.status(500).json({ error: err.message });
  }
};
