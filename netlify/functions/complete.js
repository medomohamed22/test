const fetch = require('node-fetch'); // تأكد من وجودها أو استخدم النسخة المدمجة في Node 18+

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  
  try {
    const { paymentId, txid } = JSON.parse(event.body);
    
    if (!paymentId || !txid) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing paymentId or txid' }) };
    }
    
    const PI_SECRET_KEY = process.env.PI_SECRET_KEY;
    const PI_API_BASE = 'https://api.minepi.com/v2';
    
    // 1. محاولة إكمال الدفعة مع Pi API
    const response = await fetch(`${PI_API_BASE}/payments/${paymentId}/complete`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${PI_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ txid }),
    });
    
    const data = await response.json();

    // 2. معالجة الرد
    if (response.ok) {
      // نجاح العملية لأول مرة
      return { 
        statusCode: 200, 
        body: JSON.stringify({ success: true, message: "Payment completed", data }) 
      };
    } else {
      // فحص إذا كان الخطأ سببه أن الدفعة مكتملة بالفعل (Already Completed)
      // Pi API يرجع رسالة تحتوي على "already complete" في هذه الحالة
      if (data.message && data.message.toLowerCase().includes("already complete")) {
        return { 
          statusCode: 200, 
          body: JSON.stringify({ success: true, message: "Payment was already completed previously" }) 
        };
      }

      // إذا كان الخطأ لسبب آخر (مثل مفتاح API خطأ أو مشكلة في txid)
      return { 
        statusCode: response.status, 
        body: JSON.stringify({ error: data }) 
      };
    }
  } catch (err) {
    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: "Internal Server Error", message: err.message }) 
    };
  }
};
