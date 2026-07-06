const { createClient } = require("@supabase/supabase-js");

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        error: "Method not allowed"
      });
    }

    const { receiver_pi_id, message } = req.body || {};

    if (!receiver_pi_id || !message) {
      return res.status(400).json({
        error: "receiver_pi_id and message are required"
      });
    }

    if (!process.env.TELEGRAM_BOT_TOKEN) {
      return res.status(500).json({
        error: "TELEGRAM_BOT_TOKEN missing"
      });
    }

    const { data: receiver, error } = await sb
      .from("users")
      .select("telegram_chat_id")
      .eq("pi_id", receiver_pi_id)
      .maybeSingle();

    if (error) {
      return res.status(500).json({
        error: error.message
      });
    }

    if (!receiver?.telegram_chat_id) {
      return res.status(200).json({
        ok: false,
        reason: "telegram_not_linked"
      });
    }

    const tg = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: String(receiver.telegram_chat_id),
          text: message
        })
      }
    );

    const result = await tg.json();

    return res.status(200).json(result);

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      error: err.message || "Internal server error"
    });
  }
};
