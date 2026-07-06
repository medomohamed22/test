const { createClient } = require("@supabase/supabase-js");

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  
  const { receiver_pi_id, message } = req.body;
  
  const { data: receiver } = await sb
    .from("users")
    .select("telegram_chat_id")
    .eq("pi_id", receiver_pi_id)
    .maybeSingle();
  
  if (!receiver?.telegram_chat_id) {
    return res.status(200).json({ ok: false, reason: "telegram_not_linked" });
  }
  
  const tg = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: receiver.telegram_chat_id,
      text: message
    })
  });
  
  const result = await tg.json();
  return res.status(200).json(result);
};
