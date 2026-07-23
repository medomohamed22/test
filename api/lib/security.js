const ALLOWED_IMAGE_TYPES = new Map([
  ['image/jpeg', [[0xff,0xd8,0xff]]],
  ['image/png', [[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]]],
  ['image/webp', [[0x52,0x49,0x46,0x46]]]
]);
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
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i,'');
  if (!token) throw new Error('Missing Pi access token');
  const r = await fetch('https://api.minepi.com/v2/me', { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error('Invalid Pi access token');
  const u = await r.json();
  if (!u.uid || !u.username) throw new Error('Invalid Pi user');
  return u;
}
module.exports = { cleanText, imageMime, verifyPiUser };
