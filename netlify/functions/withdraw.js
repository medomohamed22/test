const StellarSdk = require('stellar-sdk');
const { createClient } = require('@supabase/supabase-js');

// 1. إعدادات قاعدة البيانات (مباشرة في الكود)
const SUPABASE_URL = 'https://xncapmzlwuisupkjlftb.supabase.co'; 
const SUPABASE_KEY = 'sb_publishable_zPECXAiI_bDbeLtRYe3vIw_IEt_p_AS'; // تأكد أنه مفتاح الخدمة (Service Role) إذا كنت ستعدل بيانات حساسة

// 2. إعدادات المحفظة (من ENV)
const APP_WALLET_SECRET = process.env.APP_WALLET_SECRET;

// 3. إعدادات شبكة Pi Testnet
const PI_HORIZON_URL = 'https://api.testnet.minepi.com';
const NETWORK_PASSPHRASE = 'Pi Testnet';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { uid, username, amount, walletAddress } = JSON.parse(event.body);
    const withdrawAmount = parseFloat(amount);

    if (!uid || !amount || !walletAddress) {
      return { statusCode: 400, body: JSON.stringify({ error: 'بيانات ناقصة' }) };
    }

    // --- خطوة 1: التحقق من الرصيد في السوبابيس ---
    const { data: donations } = await supabase.from('donations').select('amount').eq('pi_user_id', uid);
    const { data: withdrawals } = await supabase.from('withdrawals').select('amount').eq('pi_user_id', uid);

    const totalDonated = donations ? donations.reduce((sum, row) => sum + parseFloat(row.amount), 0) : 0;
    const totalWithdrawn = withdrawals ? withdrawals.reduce((sum, row) => sum + parseFloat(row.amount), 0) : 0;
    const currentBalance = totalDonated - totalWithdrawn;

    if (currentBalance < withdrawAmount) {
      return { statusCode: 400, body: JSON.stringify({ error: 'رصيد غير كافٍ' }) };
    }

    // --- خطوة 2: تهيئة Stellar بشكل متوافق تماماً ---
    // هذه الطريقة تحل خطأ "Server is not a constructor"
    const server = new StellarSdk.Horizon.Server(PI_HORIZON_URL); 
    
    const sourceKeys = StellarSdk.Keypair.fromSecret(APP_WALLET_SECRET);
    const sourceAccount = await server.loadAccount(sourceKeys.publicKey());

    // بناء المعاملة
    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: "10000", // 0.01 Pi
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: walletAddress,
          asset: StellarSdk.Asset.native(),
          amount: withdrawAmount.toFixed(7).toString(), // ضروري جداً 7 أرقام عشرية
        })
      )
      .setTimeout(30)
      .build();

    // توقيع المعاملة
    transaction.sign(sourceKeys);

    // إرسال المعاملة للبلوكشين
    const result = await server.submitTransaction(transaction);

    // --- خطوة 3: تسجيل العملية في قاعدة البيانات بعد النجاح ---
    await supabase.from('withdrawals').insert([{
      pi_user_id: uid,
      username: username,
      amount: withdrawAmount,
      wallet_address: walletAddress,
      txid: result.hash
    }]);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, txid: result.hash })
    };

  } catch (err) {
    console.error("Final Error Detail:", err);
    let msg = err.message;
    if (err.response && err.response.data) {
        msg = JSON.stringify(err.response.data.extras.result_codes) || JSON.stringify(err.response.data);
    }
    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: 'فشل في معالجة البلوكشين', details: msg }) 
    };
  }
};
