// Pi Platform API helper.
// Keep the base URL at the API root (https://api.minepi.com) and put /v2 in
// each endpoint. This matches the current official Pi demo app and also avoids
// accidental double-/v2 or missing-/v2 errors when PI_API_BASE is configured.
const RAW_PI_BASE = process.env.PI_API_BASE || process.env.PLATFORM_API_URL || 'https://api.minepi.com';
const PI_ROOT = String(RAW_PI_BASE).trim().replace(/\/+$/, '').replace(/\/v2$/i, '');
const PI_TIMEOUT_MS = Math.max(3000, Math.min(30000, Number(process.env.PI_API_TIMEOUT_MS || 12000)));

export class PiPlatformError extends Error {
  constructor(message, { status = 0, path = '', response = null } = {}) {
    super(message);
    this.name = 'PiPlatformError';
    this.status = status;
    this.path = path;
    this.response = response;
  }
}

async function piFetch(path, options = {}) {
  const endpoint = path.startsWith('/') ? path : `/${path}`;
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PI_TIMEOUT_MS);
  try {
    const res = await fetch(`${PI_ROOT}${endpoint}`, { ...options, headers, signal: options.signal || controller.signal });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; }
    catch { body = text ? { raw: text.slice(0, 1000) } : {}; }
    if (!res.ok) {
      const message = body?.message || body?.error || body?.detail || `Pi API ${res.status}`;
      throw new PiPlatformError(message, { status: res.status, path: endpoint, response: body });
    }
    return body;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new PiPlatformError('Pi API request timed out', { status: 504, path: endpoint });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyPiAccessToken(accessToken) {
  if (!accessToken) throw new Error('Missing Pi access token');
  return piFetch('/v2/me', { headers: { Authorization: `Bearer ${accessToken}` } });
}

function serverHeaders() {
  const key = String(process.env.PI_API_KEY || '').trim();
  if (!key) throw new Error('PI_API_KEY is not configured');
  return { Authorization: `Key ${key}` };
}

export const getPiPayment = id => piFetch(`/v2/payments/${encodeURIComponent(id)}`, { headers: serverHeaders() });
export const approvePiPayment = id => piFetch(`/v2/payments/${encodeURIComponent(id)}/approve`, { method: 'POST', headers: serverHeaders(), body: '{}' });
export const completePiPayment = (id, txid) => piFetch(`/v2/payments/${encodeURIComponent(id)}/complete`, { method: 'POST', headers: serverHeaders(), body: JSON.stringify({ txid }) });
export const cancelPiPayment = id => piFetch(`/v2/payments/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: serverHeaders(), body: '{}' });

// Official Pi Demo App endpoint:
// POST https://api.minepi.com/v2/in_app_notifications/notify
export const sendPiInAppNotifications = notifications => {
  if (!Array.isArray(notifications) || notifications.length === 0) {
    throw new Error('notifications array is required');
  }
  return piFetch('/v2/in_app_notifications/notify', {
    method: 'POST',
    headers: serverHeaders(),
    body: JSON.stringify({ notifications })
  });
};

export function piApiDiagnostics() {
  return {
    apiRoot: PI_ROOT,
    notificationsEndpoint: `${PI_ROOT}/v2/in_app_notifications/notify`,
    apiKeyConfigured: Boolean(String(process.env.PI_API_KEY || '').trim()),
    timeoutMs: PI_TIMEOUT_MS
  };
}
