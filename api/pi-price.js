const OKX_TICKER_URL = 'https://www.okx.com/api/v5/market/ticker?instId=PI-USDT';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const okxRes = await fetch(OKX_TICKER_URL, { cache: 'no-store' });
    const json = await okxRes.json();

    if (!okxRes.ok || json.code !== '0' || !json.data || !json.data[0]) {
      throw new Error(json.msg || 'Could not fetch PI-USDT price from OKX');
    }

    const ticker = json.data[0];
    const priceUsd = Number(ticker.last || ticker.askPx || ticker.bidPx);
    if (!priceUsd || priceUsd <= 0) throw new Error('Invalid PI-USDT price');

    return res.status(200).json({
      symbol: 'PI-USDT',
      priceUsd,
      source: 'OKX',
      ts: new Date(Number(ticker.ts || Date.now())).toISOString()
    });
  } catch (err) {
    console.error('pi-price error:', err);
    return res.status(500).json({ error: err.message });
  }
};
