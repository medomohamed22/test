// netlify/functions/withdraw.js
const fetch = require('node-fetch');

exports.handler = async (event) => {
  // منع أي طلب ليس POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { amount, walletAddress, userId } = JSON.parse(event.body);

  // التحقق من البيانات المطلوبة
  if (!amount || !walletAddress) {
    return { statusCode: 400, body: JSON.stringify({ error: 'بيانات ناقصة' }) };
  }

  const PI_SECRET_KEY = process.env.PI_SECRET_KEY;
  const PI_API_BASE = 'https://api.minepi.com/v2';

  try {
    // 1. إنشاء طلب دفع من التطبيق للمستخدم
    const response = await fetch(`${PI_API_BASE}/payments`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${PI_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payment: {
          amount: parseFloat(amount),
          memo: "Withdrawal from App",
          metadata: { userId: userId },
          uid: userId // معرف المستخدم في شبكة Pi
        }
      }),
    });

    const paymentData = await response.json();

    if (response.ok) {
      return { 
        statusCode: 200, 
        body: JSON.stringify({ success: true, message: 'تم تحويل المبلغ بنجاح', data: paymentData }) 
      };
    } else {
      return { 
        statusCode: response.status, 
        body: JSON.stringify({ error: paymentData }) 
      };
    }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
