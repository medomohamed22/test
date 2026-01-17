// ملاحظة: هذا الكود يفترض أنك تستخدم بيئة Node.js الحديثة على Netlify
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { amount, uid } = JSON.parse(event.body);
  
  // مفاتيح سرية يتم جلبها من إعدادات Netlify للأمان
  const PI_API_KEY = process.env.PI_SECRET_KEY; //ApiKey من لوحة المطورين
  const WALLET_PRIVATE_SEED = process.env.WALLET_PRIVATE_SEED; // السلسلة السرية للمحفظة
  
  const PI_API_BASE = 'https://api.minepi.com/v2';

  try {
    // خطوة 1: إنشاء طلب الدفع في سيرفر باي
    const response = await fetch(`${PI_API_BASE}/payments`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${PI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        payment: {
          amount: parseFloat(amount),
          memo: "Withdrawal from App",
          metadata: { type: "withdrawal" },
          uid: uid 
        }
      }),
    });

    const paymentData = await response.json();

    if (!response.ok) {
      throw new Error(JSON.stringify(paymentData));
    }

    // ملاحظة: في شبكة باي، السحب (App-to-User) يتطلب خطوة إضافية 
    // وهي "التوقيع" (Signing) الذي يتم عبر الـ SDK الخاص بالسيرفر.
    // إذا كنت تستخدم الـ API المباشر، باي تقوم بالتنفيذ إذا كانت محفظة التطبيق مربوطة.

    return { 
      statusCode: 200, 
      body: JSON.stringify({ success: true, paymentId: paymentData.identifier }) 
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
