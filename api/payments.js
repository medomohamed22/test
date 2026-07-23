'use strict';
const { createClient } = require('@supabase/supabase-js');
function cleanText(value, min, max, field) {
  const s = String(value || '').normalize('NFKC').trim();
  if (s.length < min || s.length > max) throw new Error(`${field} length is invalid`);
  if (/<[^>]*>|javascript:|data:text\/html|on\w+\s*=/i.test(s)) throw new Error(`${field} contains forbidden content`);
  return s.replace(/[\u0000-\u001F\u007F]/g, ' ');
}

function imageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff]))) return 'image/jpeg';
  if (buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
  if (buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WEBP') return 'image/webp';
  return null;
}

async function verifyPiUser(req) {
  const authorization = String(req.headers.authorization || '');
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) {
    const err = new Error('Missing Pi access token');
    err.statusCode = 401;
    err.code = 'PI_TOKEN_MISSING';
    throw err;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('https://api.minepi.com/v2/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${match[1]}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.uid || !body.username) {
      const err = new Error(body.error || body.message || 'Invalid Pi access token');
      err.statusCode = 401;
      err.code = 'PI_TOKEN_INVALID';
      throw err;
    }
    return { uid: String(body.uid), username: String(body.username) };
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('Pi authentication service timed out');
      err.statusCode = 503;
      err.code = 'PI_AUTH_TIMEOUT';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}


const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
);

const PI_API = 'https://api.minepi.com/v2';
const PLANS = Object.freeze({
  1: { usd: 1, days: 3 },
  2: { usd: 5, days: 7 },
  3: { usd: 10, days: 14 },
});

function bodyOf(req) {
  return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
}

async function readPiPayment(paymentId) {
  const response = await fetch(`${PI_API}/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Key ${process.env.PI_API_KEY}` },
  });
  if (!response.ok) throw new Error('Cannot verify Pi payment');
  return response.json();
}

function paymentMetadata(payment) {
  return typeof payment.metadata === 'string'
    ? JSON.parse(payment.metadata || '{}')
    : (payment.metadata || {});
}

async function readPlanAndProduct(payment, userUid) {
  const metadata = paymentMetadata(payment);
  const productId = Number(metadata.productId || metadata.product_id);
  const tier = Number(metadata.tier || metadata.level);
  const plan = PLANS[tier];
  if (!productId || !plan || payment.user_uid !== userUid) {
    throw new Error('Invalid payment metadata');
  }

  const { data: product, error } = await sb
    .from('products')
    .select('id,seller_pi_id,status,promoted_until')
    .eq('id', productId)
    .single();
  if (error) throw error;
  if (!product || product.seller_pi_id !== userUid || product.status !== 'approved') {
    throw new Error('Product not eligible');
  }
  return { productId, tier, plan, product };
}

async function readPiUsdPrice() {
  const response = await fetch('https://www.okx.com/api/v5/market/ticker?instId=PI-USDT');
  const json = await response.json();
  const price = Number(json.data?.[0]?.last);
  if (!response.ok || !price) throw new Error('Cannot verify PI price');
  return price;
}

function verifyAmount(payment, plan, piUsdPrice) {
  const expected = plan.usd / piUsdPrice;
  const paid = Number(payment.amount);
  if (!paid || Math.abs(paid - expected) / expected > 0.03) {
    throw new Error('Payment amount mismatch');
  }
  return paid;
}

async function approvePayment(req, res, caller) {
  const body = bodyOf(req);
  if (!body.paymentId) throw new Error('paymentId required');

  const payment = await readPiPayment(body.paymentId);
  const { plan } = await readPlanAndProduct(payment, caller.uid);
  const piUsdPrice = await readPiUsdPrice();
  verifyAmount(payment, plan, piUsdPrice);

  const response = await fetch(
    `${PI_API}/payments/${encodeURIComponent(body.paymentId)}/approve`,
    {
      method: 'POST',
      headers: {
        Authorization: `Key ${process.env.PI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }
  );
  if (!response.ok) throw new Error(await response.text());
  return res.status(200).json({ approved: true });
}

async function completePayment(req, res, caller) {
  const body = bodyOf(req);
  if (!body.paymentId || !body.txid) throw new Error('paymentId and txid required');

  const completion = await fetch(
    `${PI_API}/payments/${encodeURIComponent(body.paymentId)}/complete`,
    {
      method: 'POST',
      headers: {
        Authorization: `Key ${process.env.PI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ txid: body.txid }),
    }
  );
  if (!completion.ok) throw new Error(`Pi completion rejected: ${await completion.text()}`);

  const payment = await readPiPayment(body.paymentId);
  if (
    !payment.status?.developer_completed ||
    !payment.status?.transaction_verified ||
    payment.status?.cancelled ||
    payment.status?.user_cancelled
  ) throw new Error('Payment is not fully verified');
  if (payment.transaction?.txid !== body.txid) throw new Error('Transaction mismatch');

  const { productId, tier, plan, product } = await readPlanAndProduct(payment, caller.uid);
  const piUsdPrice = await readPiUsdPrice();
  const paid = verifyAmount(payment, plan, piUsdPrice);

  let expiry = new Date();
  if (product.promoted_until && new Date(product.promoted_until) > expiry) {
    expiry = new Date(product.promoted_until);
  }
  expiry.setUTCDate(expiry.getUTCDate() + plan.days);

  const { error: paymentError } = await sb.from('payments').insert({
    payment_id: body.paymentId,
    user_id: payment.user_uid,
    product_id: productId,
    txid: body.txid,
    amount_pi: paid,
    amount_usd: plan.usd,
    pi_usd_price: piUsdPrice,
    tier,
    days: plan.days,
    status: 'completed',
    raw_payment: payment,
    completed_at: new Date().toISOString(),
  });
  if (paymentError && paymentError.code !== '23505') throw paymentError;

  const { error: productError } = await sb
    .from('products')
    .update({
      promoted_until: expiry.toISOString(),
      promotion_tier: tier,
      promoted_level: tier,
      promoted_priority: tier,
      last_payment_id: body.paymentId,
      last_payment_txid: body.txid,
    })
    .eq('id', productId);
  if (productError) throw productError;

  return res.status(200).json({ success: true, promotedUntil: expiry.toISOString(), tier });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const caller = await verifyPiUser(req);
    const action = String(req.query?.action || bodyOf(req).action || '').toLowerCase();
    if (action === 'approve') return approvePayment(req, res, caller);
    if (action === 'complete') return completePayment(req, res, caller);
    return res.status(400).json({ error: 'Invalid payment action' });
  } catch (error) {
    console.error('payments error:', error);
    return res.status(error.statusCode === 401 ? 401 : 400).json({ error: error.message });
  }
};
