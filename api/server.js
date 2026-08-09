import app from '../app.js';

/**
 * Vercel exposes this file as the /api/server function.
 * vercel.json rewrites every /api/* request here and passes the original
 * sub-path in __path. Rebuild req.url before handing it to Express so routes
 * such as /api/listings and /api/auth/pi keep working exactly as they do
 * locally.
 */
export default function handler(req, res) {
  try {
    const incoming = new URL(req.url || '/api/server', 'http://localhost');
    const rawPath = incoming.searchParams.get('__path') || '';
    incoming.searchParams.delete('__path');

    const cleanPath = rawPath
      .split('/')
      .map(part => encodeURIComponent(decodeURIComponent(part)))
      .join('/');

    const qs = incoming.searchParams.toString();
    req.url = `/api/${cleanPath}${qs ? `?${qs}` : ''}`;
    return app(req, res);
  } catch (error) {
    console.error('[vercel api router]', error);
    return res.status(500).json({
      error: 'تعذر توجيه طلب API على Vercel',
      code: 'VERCEL_ROUTER_ERROR'
    });
  }
}
