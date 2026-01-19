exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { paymentId } = JSON.parse(event.body);
    const PI_SECRET_KEY = process.env.PI_SECRET_KEY;
    const PI_API_BASE = 'https://api.minepi.com/v2';

    const response = await fetch(`${PI_API_BASE}/payments/${paymentId}/approve`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${PI_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();

    if (response.ok) {
      return { statusCode: 200, body: JSON.stringify({ approved: true }) };
    } else {
      if (data.message && data.message.toLowerCase().includes("already approved")) {
        return { statusCode: 200, body: JSON.stringify({ approved: true }) };
      }
      return { statusCode: response.status, body: JSON.stringify({ error: data }) };
    }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
