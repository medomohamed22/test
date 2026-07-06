import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false });
    }

    const msg = req.body.message;
    if (!msg || !msg.text) {
      return res.status(200).json({ ok: true });
    }

    const text = msg.text.trim();
    const chatId = String(msg.chat.id);
    const username = msg.from?.username || null;

    if (!text.startsWith("/start")) {
      return res.status(200).json({ ok: true });
    }

    const token = text.split(" ")[1];

    if (!token) {
      await sendTelegram(chatId, "افتح البوت من زر الربط داخل Deal Way.");
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
      console.error(error);
      await sendTelegram(chatId, "حدث خطأ أثناء الربط.");
      return res.status(500).json({ ok: false });
    }

    if (!data) {
      await sendTelegram(chatId, "كود الربط غير صالح أو منتهي. ارجع للموقع واضغط ربط مرة أخرى.");
      return res.status(200).json({ ok: true });
    }

    await sendTelegram(chatId, "✅ تم ربط تيليجرام بحسابك في Deal Way بنجاح. ارجع للموقع الآن.");

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false });
  }
}

async function sendTelegram(chatId, text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });
}
