const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const PI_API_KEY = "cdydb5aewbkczjb7nh4pf7njkia5tpbgaytgb87ulhwbwjf00xztjzalkeo7rx7q";

app.post('/app-to-user', async (req, res) => {
    const { walletAddress, amount } = req.body;

    try {
        const response = await axios.post('https://api.minepi.com/v2/payments', {
            payment: {
                amount: parseFloat(amount),
                memo: "Manual App-to-User Transfer",
                metadata: { type: "manual_payout" },
                uid: "user-id-from-pi-sdk" // يجب الحصول عليه من تسجيل الدخول
            }
        }, {
            headers: { 'Authorization': `Key ${PI_API_KEY}` }
        });

        res.json({ success: true, data: response.data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.response?.data || error.message });
    }
});

app.listen(3000, () => console.log('Server running!'));
