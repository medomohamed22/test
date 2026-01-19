exports.handler = async (event) => {
  // التأكد من أن الطلب من نوع POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { paymentId } = JSON.parse(event.body);

    if (!paymentId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing paymentId' }) };
    }

    const PI_SECRET_KEY = process.env.PI_SECRET_KEY;
    const PI_API_BASE = 'https://api.minepi.com/v2';

    // إرسال طلب الموافقة إلى Pi API
    const response = await fetch(`${PI_API_BASE}/payments/${paymentId}/approve`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${PI_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();

    if (response.ok) {
      // تمت الموافقة بنجاح
      return { 
        statusCode: 200, 
        body: JSON.stringify({ approved: true, message: "Payment approved successfully" }) 
      };
    } else {
      // فحص إذا كانت الدفعة موافق عليها بالفعل لتجنب إظهار خطأ للمستخدم
      if (data.message && data.message.toLowerCase().includes("already approved")) {
        return { 
          statusCode: 200, 
          body: JSON.stringify({ approved: true, message: "Payment was already approved" }) 
        };
      }

      // أي خطأ آخر يتم تمريره كما هو
      return { 
        statusCode: response.status, 
        body: JSON.stringify({ error: data }) 
      };
    }
  } catch (err) {
    // خطأ في السيرفر أو الاتصال
    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: "Internal Server Error", details: err.message }) 
    };
  }
};
