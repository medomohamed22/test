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

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { paymentId } = readBody(req);
    if (!paymentId) return res.status(400).json({ error: 'paymentId is required' });

    const piRes = await fetch(`${PI_API_BASE}/payments/${paymentId}`, {
      headers: { Authorization: `Key ${PI_API_KEY}` }
    });

    if (!piRes.ok) throw new Error(`Pi API Error: ${await piRes.text()}`);
    const piData = await piRes.json();
    const metadata = parseMetadata(piData.metadata);

    const productId = metadata.productId || metadata.product_id || metadata.id || null;
    const amount = Number(piData.amount || 0);

    const { error } = await supabase.from('payments').upsert({
      payment_id: paymentId,
      user_id: piData.user_uid,
      product_id: productId,
      amount,
      amount_pi: amount,
      amount_usd: metadata.usdAmount ? Number(metadata.usdAmount) : null,
      pi_usd_price: metadata.piUsdPrice ? Number(metadata.piUsdPrice) : null,
      status: 'approved'
    }, { onConflict: 'payment_id' });

    if (error) console.error('payments upsert warning:', error);

    const approveRes = await fetch(`${PI_API_BASE}/payments/${paymentId}/approve`, {
      method: 'POST',
      headers: { Authorization: `Key ${PI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (!approveRes.ok) throw new Error(`Pi approve failed: ${await approveRes.text()}`);
    return res.status(200).json({ approved: true });
  } catch (err) {
    console.error('approve error:', err);
    return res.status(500).json({ error: err.message });
  }
};
