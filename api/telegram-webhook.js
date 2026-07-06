import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(200).json({ ok: true });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

    if (!SUPABASE_URL || !SERVICE_KEY || !BOT_TOKEN) {
      console.error("Missing env vars");
      return res.status(200).json({ ok: false, error: "Missing env vars" });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    const msg = req.body.message;
    if (!msg?.text) return res.status(200).json({ ok: true });

    const text = msg.text.trim();
    const chatId = String(msg.chat.id);
    const username = msg.from?.username || null;

    if (!text.startsWith("/start")) return res.status(200).json({ ok: true });

    const token = text.split(" ")[1];

    if (!token) {
      await sendTelegram(BOT_TOKEN, chatId, "افتح البوت من زر الربط داخل Deal Way.");
      return res.status(200).json({ ok: true });
    }

    const { data, error } = await sb
      .from("users")
      .update({
        telegram_chat_id: chatId,
        telegram_username: username,
        telegram_linked_at: new Date().toISOString(),
        telegram_link_token: null
      })
      .eq("telegram_link_token", token)
      .select("pi_id")
      .maybeSingle();

    if (error) {
      console.error("Supabase error:", error);
      await sendTelegram(BOT_TOKEN, chatId, "خطأ في قاعدة البيانات أثناء الربط.");
      return res.status(200).json({ ok: false, error: error.message });
    }

    if (!data) {
      await sendTelegram(BOT_TOKEN, chatId, "كود الربط غير صالح. ارجع للموقع واضغط ربط مرة أخرى.");
      return res.status(200).json({ ok: true, linked: false });
    }

    await sendTelegram(BOT_TOKEN, chatId, "✅ تم ربط تيليجرام بنجاح. ارجع للموقع الآن.");
    return res.status(200).json({ ok: true, linked: true });

  } catch (err) {
    console.error("Webhook fatal error:", err);
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
}

async function sendTelegram(botToken, chatId, text) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}
