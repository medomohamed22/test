const { createClient } = require("@supabase/supabase-js");

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed"
      });
    }

    const { receiver_pi_id, message } = req.body || {};

    if (!receiver_pi_id || !message) {
      return res.status(400).json({
        ok: false,
        error: "receiver_pi_id and message are required"
      });
    }

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

    if (!process.env.SUPABASE_URL) {
      return res.status(500).json({
        ok: false,
        error: "SUPABASE_URL missing"
      });
    }

    if (
      !process.env.SUPABASE_SERVICE_ROLE_KEY &&
      !process.env.SUPABASE_SERVICE_KEY
    ) {
      return res.status(500).json({
        ok: false,
        error: "SUPABASE_SERVICE_ROLE_KEY missing"
      });
    }

    if (!BOT_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: "TELEGRAM_BOT_TOKEN missing"
      });
    }

    // البحث عن المستخدم
    const { data: receiver, error } = await sb
      .from("users")
      .select("telegram_chat_id")
      .eq("pi_id", receiver_pi_id)
      .maybeSingle();

    if (error) {
      console.error("Supabase error:", error);

      return res.status(500).json({
        ok: false,
        error: error.message
      });
    }

    // المستخدم لم يربط تيليجرام
    if (!receiver?.telegram_chat_id) {
      return res.status(200).json({
        ok: false,
        reason: "telegram_not_linked"
      });
    }

    // إرسال الرسالة
    const tgRes = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: String(receiver.telegram_chat_id),
          text: String(message)
        })
      }
    );

    const tgData = await tgRes.json().catch(() => null);

    if (!tgRes.ok || !tgData?.ok) {
      console.error("Telegram error:", tgData);

      return res.status(500).json({
        ok: false,
        error: "telegram_send_failed",
        telegram: tgData
      });
    }

    return res.status(200).json({
      ok: true,
      telegram: tgData
    });

  } catch (err) {
    console.error("SEND TELEGRAM ERROR:", err);

    return res.status(500).json({
      ok: false,
      error: err?.message || "Internal server error"
    });
  }
};
