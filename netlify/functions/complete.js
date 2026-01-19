exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  
  try {
    const { paymentId, txid } = JSON.parse(event.body);
    const PI_SECRET_KEY = process.env.PI_SECRET_KEY;

    // إرسال طلب التأكيد لـ Pi API
    const response = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/complete`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${PI_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ txid }),
    });
    
    const data = await response.json();

    if (response.ok) {
      return { statusCode: 200, body: JSON.stringify({ success: true, data }) };
    } else {
      // إذا كانت الدفعة مكتملة مسبقاً، نعتبرها نجاحاً لتجاوز الخطأ في التطبيق
      if (data.message && data.message.toLowerCase().includes("already complete")) {
        return { statusCode: 200, body: JSON.stringify({ success: true, message: "Already processed" }) };
      }
      return { statusCode: response.status, body: JSON.stringify({ error: data }) };
    }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
