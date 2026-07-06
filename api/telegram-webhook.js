const APP_NAME = "Deal Way";

export default async function handler(req, res) {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

    if (req.method !== "POST") {
      return res.status(200).json({
        ok: true,
        message: "Telegram webhook alive",
        hasUrl: !!SUPABASE_URL,
        hasServiceRoleKey: !!SERVICE_KEY,
        serviceRoleKeyStart: SERVICE_KEY ? SERVICE_KEY.slice(0, 12) : null,
        serviceRoleKeyLength: SERVICE_KEY ? SERVICE_KEY.length : 0,
        hasBotToken: !!BOT_TOKEN
      });
    }

    if (!SUPABASE_URL || !SERVICE_KEY || !BOT_TOKEN) {
      return res.status(200).json({
        ok: false,
        error: "Missing ENV",
        hasUrl: !!SUPABASE_URL,
        hasServiceRoleKey: !!SERVICE_KEY,
        serviceRoleKeyStart: SERVICE_KEY ? SERVICE_KEY.slice(0, 12) : null,
        serviceRoleKeyLength: SERVICE_KEY ? SERVICE_KEY.length : 0,
        hasBotToken: !!BOT_TOKEN
      });
    }

    const msg = req.body?.message;
    if (!msg) return res.status(200).json({ ok: true });

    const chatId = String(msg.chat?.id || "");
    const username = msg.from?.username || null;
    const firstName = msg.from?.first_name || "";
    const text = String(msg.text || "").trim();

    console.log("Telegram message:", { chatId, username, text });
    console.log("Supabase ENV:", {
      url: SUPABASE_URL,
      keyStart: SERVICE_KEY.slice(0, 12),
      keyLength: SERVICE_KEY.length
    });

    if (!chatId || !text) {
      return res.status(200).json({ ok: true });
    }

    if (text === "/help") {
      await sendTelegram(BOT_TOKEN, chatId, helpMessage());
      return res.status(200).json({ ok: true });
    }

    if (text === "/status") {
      return await handleStatus({
        res,
        SUPABASE_URL,
        SERVICE_KEY,
        BOT_TOKEN,
        chatId
      });
    }

    if (text === "/unlink") {
      return await handleUnlink({
        res,
        SUPABASE_URL,
        SERVICE_KEY,
        BOT_TOKEN,
        chatId
      });
    }

    if (!text.startsWith("/start")) {
      await sendTelegram(
        BOT_TOKEN,
        chatId,
        `👋 أهلاً بك في ${APP_NAME}.\n\nاستخدم /help لمعرفة الأوامر.`
      );

      return res.status(200).json({ ok: true });
    }

    const token = extractStartToken(text);

    if (!token) {
      await sendTelegram(
        BOT_TOKEN,
        chatId,
        `👋 أهلاً ${firstName || ""}\n\nلربط حسابك، افتح الموقع واضغط زر "ربط بوت تيليجرام" من صفحة حسابي.`
      );

      return res.status(200).json({
        ok: true,
        linked: false,
        reason: "missing_start_token"
      });
    }

    if (!isValidLinkToken(token)) {
      await sendTelegram(
        BOT_TOKEN,
        chatId,
        `❌ كود الربط غير صحيح.\n\nالكود الذي وصل للبوت:\n${token}\n\nارجع للموقع واضغط ربط بوت تيليجرام مرة أخرى.`
      );

      return res.status(200).json({
        ok: true,
        linked: false,
        reason: "invalid_token_format",
        token
      });
    }

    const linked = await linkTelegramAccount({
      SUPABASE_URL,
      SERVICE_KEY,
      BOT_TOKEN,
      chatId,
      username,
      token
    });

    return res.status(200).json(linked);
  } catch (err) {
    console.error("WEBHOOK ERROR:", err);

    return res.status(200).json({
      ok: false,
      error: String(err?.message || err)
    });
  }
}

function extractStartToken(text) {
  const parts = String(text || "").trim().split(/\s+/);
  if (parts.length < 2) return null;
  return parts[1].trim();
}

function isValidLinkToken(token) {
  return /^tg_[A-Za-z0-9_-]{8,60}$/.test(token);
}

async function linkTelegramAccount({
  SUPABASE_URL,
  SERVICE_KEY,
  BOT_TOKEN,
  chatId,
  username,
  token
}) {
  const url =
    `${SUPABASE_URL}/rest/v1/users` +
    `?telegram_link_token=eq.${encodeURIComponent(token)}`;

  const updateRes = await fetch(url, {
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
  });

  const rows = await safeJson(updateRes);

  if (!updateRes.ok) {
    console.error("Supabase link error:", updateRes.status, rows);

    await sendTelegram(
      BOT_TOKEN,
      chatId,
      `❌ حدث خطأ أثناء الربط.\nكود الخطأ: ${updateRes.status}`
    );

    return {
      ok: false,
      linked: false,
      supabaseStatus: updateRes.status,
      supabaseError: rows
    };
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    await sendTelegram(
      BOT_TOKEN,
      chatId,
      "❌ كود الربط غير صالح أو تم استخدامه من قبل.\n\nارجع للموقع واضغط ربط بوت تيليجرام مرة أخرى."
    );

    return {
      ok: true,
      linked: false,
      reason: "token_not_found"
    };
  }

  await sendTelegram(
    BOT_TOKEN,
    chatId,
    `✅ تم ربط تيليجرام بحسابك في ${APP_NAME} بنجاح.\n\nستصلك الآن إشعارات الرسائل الجديدة هنا.`
  );

  return {
    ok: true,
    linked: true,
    pi_id: rows[0]?.pi_id || null
  };
}

async function handleStatus({
  res,
  SUPABASE_URL,
  SERVICE_KEY,
  BOT_TOKEN,
  chatId
}) {
  const url =
    `${SUPABASE_URL}/rest/v1/users` +
    `?telegram_chat_id=eq.${encodeURIComponent(chatId)}` +
    `&select=pi_id,username,telegram_username,telegram_linked_at`;

  const checkRes = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`
    }
  });

  const rows = await safeJson(checkRes);

  if (!checkRes.ok) {
    console.error("Supabase status error:", checkRes.status, rows);

    await sendTelegram(
      BOT_TOKEN,
      chatId,
      `❌ حدث خطأ أثناء فحص حالة الربط.\nكود الخطأ: ${checkRes.status}`
    );

    return res.status(200).json({
      ok: false,
      linked: false,
      supabaseStatus: checkRes.status,
      supabaseError: rows
    });
  }

  if (Array.isArray(rows) && rows.length > 0) {
    const user = rows[0];

    await sendTelegram(
      BOT_TOKEN,
      chatId,
      `✅ حسابك مربوط بالفعل.\n\n👤 المستخدم: ${user.username || "غير محدد"}\n🆔 Pi ID: ${user.pi_id || "غير محدد"}`
    );

    return res.status(200).json({
      ok: true,
      linked: true
    });
  }

  await sendTelegram(
    BOT_TOKEN,
    chatId,
    "❌ حسابك غير مربوط حالياً.\n\nافتح Deal Way واضغط زر ربط بوت تيليجرام."
  );

  return res.status(200).json({
    ok: true,
    linked: false
  });
}

async function handleUnlink({
  res,
  SUPABASE_URL,
  SERVICE_KEY,
  BOT_TOKEN,
  chatId
}) {
  const unlinkRes = await fetch(
    `${SUPABASE_URL}/rest/v1/users?telegram_chat_id=eq.${encodeURIComponent(chatId)}`,
    {
      method: "PATCH",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        telegram_chat_id: null,
        telegram_username: null,
        telegram_linked_at: null,
        telegram_link_token: null
      })
    }
  );

  const rows = await safeJson(unlinkRes);

  if (!unlinkRes.ok) {
    console.error("Supabase unlink error:", unlinkRes.status, rows);

    await sendTelegram(
      BOT_TOKEN,
      chatId,
      `❌ حدث خطأ أثناء إلغاء الربط.\nكود الخطأ: ${unlinkRes.status}`
    );

    return res.status(200).json({
      ok: false,
      unlinked: false,
      supabaseStatus: unlinkRes.status,
      error: rows
    });
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    await sendTelegram(
      BOT_TOKEN,
      chatId,
      "حسابك غير مربوط بالفعل."
    );

    return res.status(200).json({
      ok: true,
      unlinked: false
    });
  }

  await sendTelegram(
    BOT_TOKEN,
    chatId,
    "✅ تم إلغاء ربط تيليجرام بنجاح."
  );

  return res.status(200).json({
    ok: true,
    unlinked: true
  });
}

function helpMessage() {
  return `🤖 أوامر بوت Deal Way:

/start
بدء الربط أو تشغيل البوت.

/status
معرفة هل حسابك مربوط أم لا.

/unlink
إلغاء ربط تيليجرام بحسابك.

/help
عرض هذه الرسالة.

لربط حسابك:
افتح Deal Way ← حسابي ← ربط بوت تيليجرام.`;
}

async function sendTelegram(botToken, chatId, text) {
  try {
    const tgRes = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          text
        })
      }
    );

    const result = await tgRes.json().catch(() => null);

    if (!tgRes.ok) {
      console.error("Telegram send failed:", tgRes.status, result);
    }

    return result;
  } catch (err) {
    console.error("Telegram send error:", err);
    return null;
  }
}

async function safeJson(response) {
  const text = await response.text();

  try {
    return JSON.parse(text || "[]");
  } catch {
    return text;
  }
}
