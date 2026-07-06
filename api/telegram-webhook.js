export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(200).json({ ok: true, message: "webhook alive" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

    if (!SUPABASE_URL || !SERVICE_KEY || !BOT_TOKEN) {
      return res.status(200).json({
        ok: false,
        error: "Missing ENV",
        hasUrl: !!SUPABASE_URL,
        hasServiceKey: !!SERVICE_KEY,
        hasBotToken: !!BOT_TOKEN
      });
    }

    const msg = req.body?.message;
    if (!msg?.text) return res.status(200).json({ ok: true });

    const chatId = String(msg.chat.id);
    const username = msg.from?.username || null;
    const text = msg.text.trim();

    if (!text.startsWith("/start")) {
      return res.status(200).json({ ok: true });
    }

    const token = text.split(" ")[1];

    if (!token) {
      await sendTelegram(BOT_TOKEN, chatId, "افتح البوت من زر الربط داخل Deal Way.");
      return res.status(200).json({ ok: true });
    }

    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?telegram_link_token=eq.${encodeURIComponent(token)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          telegram_chat_id: chatId,
          telegram_username: username,
          telegram_linked_at: new Date().toISOString(),
          telegram_link_token: null
        })
      }
    );

    const resultText = await updateRes.text();

    if (!updateRes.ok) {
      await sendTelegram(BOT_TOKEN, chatId, "خطأ في قاعدة البيانات أثناء الربط.");
      return res.status(200).json({
        ok: false,
        supabaseStatus: updateRes.status,
        supabaseError: resultText
      });
    }

    const rows = JSON.parse(resultText || "[]");

    if (!rows.length) {
      await sendTelegram(BOT_TOKEN, chatId, "كود الربط غير صالح. ارجع للموقع واضغط ربط مرة أخرى.");
      return res.status(200).json({ ok: true, linked: false });
    }

    await sendTelegram(BOT_TOKEN, chatId, "✅ تم ربط تيليجرام بنجاح. ارجع للموقع الآن.");
    return res.status(200).json({ ok: true, linked: true });

  } catch (err) {
    console.error("WEBHOOK ERROR:", err);
    return res.status(200).json({
      ok: false,
      error: String(err?.message || err)
    });
  }
}

async function sendTelegram(botToken, chatId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}
