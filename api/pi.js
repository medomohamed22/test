const PI_BASE = process.env.PI_API_BASE || 'https://api.minepi.com/v2';

async function piFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const res = await fetch(`${PI_BASE}${path}`, { ...options, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body?.message || body?.error || `Pi API ${res.status}`);
  return body;
}

export async function verifyPiAccessToken(accessToken) {
  if (!accessToken) throw new Error('Missing Pi access token');
  return piFetch('/me', { headers: { Authorization: `Bearer ${accessToken}` } });
}

function serverHeaders() {
  if (!process.env.PI_API_KEY) throw new Error('PI_API_KEY is not configured');
  return { Authorization: `Key ${process.env.PI_API_KEY}` };
}

export const getPiPayment = id => piFetch(`/payments/${id}`, { headers: serverHeaders() });
export const approvePiPayment = id => piFetch(`/payments/${id}/approve`, { method: 'POST', headers: serverHeaders(), body: '{}' });
export const completePiPayment = (id, txid) => piFetch(`/payments/${id}/complete`, { method: 'POST', headers: serverHeaders(), body: JSON.stringify({ txid }) });
export const cancelPiPayment = id => piFetch(`/payments/${id}/cancel`, { method: 'POST', headers: serverHeaders(), body: '{}' });
