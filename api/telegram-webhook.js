const { createClient } = require("@supabase/supabase-js");

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
  
  const message = req.body.message;
  const text = message?.text || "";
  const chatId = String(message?.chat?.id || "");
  
  if (!chatId) return res.status(200).json({ ok: true });
  
  if (text.startsWith("/start")) {
    const token = text.split(" ")[1];
    
    if (!token) {
      await sendTelegram(chatId, "افتح الموقع واضغط زر ربط بوت تيليجرام.");
      return res.status(200).json({ ok: true });
    }
    
    const { data, error } = await sb
      .from("users")
      .update({
        telegram_chat_id: chatId,
        telegram_linked_at: new Date().toISOString()
      })
      .eq("telegram_link_token", token)
      .select("username")
      .maybeSingle();
    
    if (error || !data) {
      await sendTelegram(chatId, "كود الربط غير صحيح أو حدث خطأ ❌");
      return res.status(200).json({ ok: true });
    }
    
    await sendTelegram(
      chatId,
      `✅ تم ربط تيليجرام بحسابك بنجاح\n\nالحساب: ${data.username || "User"}`
    );
  }
  
  return res.status(200).json({ ok: true });
};
