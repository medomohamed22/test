'use strict';

const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

function httpError(message, statusCode = 400, code = 'BAD_REQUEST') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function cleanText(value, min, max, field) {
  const text = String(value || '').normalize('NFKC').trim();
  if (text.length < min || text.length > max) throw httpError(`${field} length is invalid`);
  if (/<[^>]*>|javascript:|data:text\/html|on\w+\s*=/i.test(text)) throw httpError(`${field} contains forbidden content`);
  return text.replace(/[\u0000-\u001F\u007F]/g, ' ');
}

function html(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

async function verifyPiUser(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+([^\s]+)$/i);
  if (!match) throw httpError('Missing Pi access token', 401, 'PI_TOKEN_MISSING');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('https://api.minepi.com/v2/me', {
      headers: { Authorization: `Bearer ${match[1]}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.uid || !body.username) throw httpError('Invalid Pi access token', 401, 'PI_TOKEN_INVALID');
    return { uid: String(body.uid), username: String(body.username) };
  } catch (error) {
    if (error.name === 'AbortError') throw httpError('Pi authentication service timed out', 503, 'PI_AUTH_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function sendTelegramMessage({ chatId, sender, product, content }) {
  if (!chatId || !process.env.TELEGRAM_BOT_TOKEN) return { sent: false, reason: 'not_configured' };
  const origin = String(process.env.APP_ORIGIN || 'https://deallway.vercel.app').replace(/\/$/, '');
  const productUrl = `${origin}/?product=${encodeURIComponent(product.id)}`;
  const text = [
    '🔔 <b>رسالة جديدة على إعلانك</b>',
    '',
    `👤 <b>المرسل:</b> ${html(sender.username)}`,
    `🆔 <b>Pi UID:</b> <code>${html(sender.uid)}</code>`,
    `📦 <b>الإعلان:</b> ${html(product.name)}`,
    `💵 <b>السعر:</b> $${Number(product.price_usd || 0).toFixed(2)}`,
    `📍 <b>المكان:</b> ${html([product.country, product.location].filter(Boolean).join(' - '))}`,
    '',
    `💬 <b>الرسالة:</b>\n${html(content)}`,
  ].join('\n');

  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: 'فتح الإعلان', url: productUrl }]] },
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram HTTP ${response.status}`);
  return { sent: true };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const user = await verifyPiUser(req);
    const { error: userError } = await sb.from('app_users').upsert({
      pi_uid: user.uid, username: user.username, updated_at: new Date().toISOString(),
    }, { onConflict: 'pi_uid' });
    if (userError) throw userError;

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    if (req.method === 'GET') {
      const productId = body.productId || req.query?.productId;
      let query = sb.from('messages')
        .select('id,product_id,sender_pi_id,receiver_pi_id,content,is_read,created_at,products(name,price_usd)')
        .or(`sender_pi_id.eq.${user.uid},receiver_pi_id.eq.${user.uid}`)
        .order('created_at', { ascending: true });
      if (productId) query = query.eq('product_id', Number(productId));
      const { data, error } = await query;
      if (error) throw error;
      const ids = [...new Set((data || []).flatMap((message) => [message.sender_pi_id, message.receiver_pi_id]))];
      const peopleResult = ids.length ? await sb.from('app_users').select('pi_uid,username').in('pi_uid', ids) : { data: [], error: null };
      if (peopleResult.error) throw peopleResult.error;
      const names = Object.fromEntries((peopleResult.data || []).map((person) => [person.pi_uid, person.username]));
      return res.status(200).json({
        messages: (data || []).map((message) => ({
          ...message,
          sender_username: names[message.sender_pi_id] || 'User',
          receiver_username: names[message.receiver_pi_id] || 'User',
        })),
      });
    }

    if (req.method === 'POST') {
      const productId = Number(body.productId);
      const receiverPiId = String(body.receiverPiId || '');
      const content = cleanText(body.content, 1, 2000, 'message');
      if (!Number.isInteger(productId)) throw httpError('Invalid product');
      if (!receiverPiId) throw httpError('Missing receiver');

      const { data: product, error: productError } = await sb.from('products')
        .select('id,seller_pi_id,seller_username,status,name,price_usd,country,location')
        .eq('id', productId).maybeSingle();
      if (productError) throw productError;
      if (!product || product.status !== 'approved') throw httpError('Product unavailable', 404, 'PRODUCT_UNAVAILABLE');

      // A conversation is only allowed between the seller and another user.
      const validReceiver = receiverPiId !== user.uid && (receiverPiId === product.seller_pi_id || user.uid === product.seller_pi_id);
      if (!validReceiver) throw httpError('Invalid chat target', 403, 'INVALID_CHAT_TARGET');

      const { data: message, error: insertError } = await sb.from('messages').insert({
        product_id: productId,
        sender_pi_id: user.uid,
        receiver_pi_id: receiverPiId,
        content,
      }).select().single();
      if (insertError) throw insertError;

      const { data: target, error: targetError } = await sb.from('app_users')
        .select('pi_uid,username,telegram_chat_id')
        .eq('pi_uid', receiverPiId).maybeSingle();
      if (targetError) console.error('telegram target lookup:', targetError);

      let telegram = { sent: false, reason: 'not_linked' };
      if (target?.telegram_chat_id) {
        try {
          // Await this request so Vercel does not terminate the function before Telegram receives it.
          telegram = await sendTelegramMessage({ chatId: target.telegram_chat_id, sender: user, product, content });
        } catch (telegramError) {
          console.error('telegram notification failed:', telegramError);
          telegram = { sent: false, reason: telegramError.message };
        }
      }

      return res.status(201).json({ message, telegram });
    }

    if (req.method === 'PATCH') {
      const productId = Number(body.productId);
      const otherPiId = String(body.otherPiId || '');
      const { error } = await sb.from('messages').update({ is_read: true })
        .eq('product_id', productId).eq('receiver_pi_id', user.uid).eq('sender_pi_id', otherPiId);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('messages:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Internal server error', code: error.code || 'MESSAGES_ERROR' });
  }
};
