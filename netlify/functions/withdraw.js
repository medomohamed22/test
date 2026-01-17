exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { amount, userId } = JSON.parse(event.body);
  const PI_SECRET_KEY = process.env.PI_SECRET_KEY;
  const PI_API_BASE = 'https://api.minepi.com/v2';

  try {
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
          uid: userId 
        }
      }),
    });

    const paymentData = await response.json();

    if (response.ok) {
      return { 
        statusCode: 200, 
        body: JSON.stringify({ success: true, data: paymentData }) 
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
