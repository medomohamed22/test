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

    const safeToken = encodeURIComponent(token);

    const updateRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?telegram_link_token=eq.${safeToken}`,
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

    let rows = [];
    try {
      rows = JSON.parse(resultText || "[]");
    } catch {
      rows = [];
    }

    if (!updateRes.ok) {
      console.error("Supabase error:", updateRes.status, resultText);

      await sendTelegram(
        BOT_TOKEN,
        chatId,
        `خطأ في قاعدة البيانات أثناء الربط. كود الخطأ: ${updateRes.status}`
      );

      return res.status(200).json({
        ok: false,
        supabaseStatus: updateRes.status,
        supabaseError: resultText
      });
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      await sendTelegram(
        BOT_TOKEN,
        chatId,
        "كود الربط غير صالح أو تم استخدامه من قبل. ارجع للموقع واضغط ربط مرة أخرى."
      );

      return res.status(200).json({
        ok: true,
        linked: false,
        reason: "token_not_found"
      });
    }

    await sendTelegram(
      BOT_TOKEN,
      chatId,
      "✅ تم ربط تيليجرام بنجاح. ارجع للموقع الآن."
    );

    return res.status(200).json({
      ok: true,
      linked: true,
      pi_id: rows[0]?.pi_id || null
    });

  } catch (err) {
    console.error("WEBHOOK ERROR:", err);

    return res.status(200).json({
      ok: false,
      error: String(err?.message || err)
    });
  }
}

async function sendTelegram(botToken, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text
      })
    });
  } catch (err) {
    console.error("Telegram send error:", err);
  }
}
