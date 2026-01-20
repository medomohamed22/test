const StellarSdk = require('stellar-sdk');
const { createClient } = require('@supabase/supabase-js');

// 1. إعدادات قاعدة البيانات
const SUPABASE_URL = 'https://xncapmzlwuisupkjlftb.supabase.co'; 
const SUPABASE_KEY = 'ضع_مفتاح_SUPABASE_SERVICE_ROLE_KEY_هنا'; 

// 2. إعدادات المحفظة (من متغيرات البيئة)
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

    // --- التحقق من الرصيد ---
    const { data: donations } = await supabase.from('donations').select('amount').eq('pi_user_id', uid);
    const { data: withdrawals } = await supabase.from('withdrawals').select('amount').eq('pi_user_id', uid);

    const totalDonated = donations ? donations.reduce((sum, row) => sum + parseFloat(row.amount), 0) : 0;
    const totalWithdrawn = withdrawals ? withdrawals.reduce((sum, row) => sum + parseFloat(row.amount), 0) : 0;
    const currentBalance = totalDonated - totalWithdrawn;

    if (currentBalance < withdrawAmount) {
      return { statusCode: 400, body: JSON.stringify({ error: 'رصيد غير كافٍ' }) };
    }

    // --- إعداد Stellar بالأسلوب المتوافق مع الإصدارات الجديدة والقديمة ---
    
    // تأكد من الوصول إلى الكلاسات سواء كانت مباشرة أو داخل كائن StellarSdk
    const HorizonServer = StellarSdk.Server || StellarSdk.Horizon.Server;
    if (!HorizonServer) {
        throw new Error("Could not find Stellar Server constructor in the SDK");
    }

    const server = new HorizonServer(PI_HORIZON_URL);
    const sourceKeys = StellarSdk.Keypair.fromSecret(APP_WALLET_SECRET);
    const sourceAccount = await server.loadAccount(sourceKeys.publicKey());

    // بناء المعاملة
    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE || "10000", 
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: walletAddress,
          asset: StellarSdk.Asset.native(),
          amount: withdrawAmount.toFixed(7).toString(), 
        })
      )
      .setTimeout(30)
      .build();

    transaction.sign(sourceKeys);
    const result = await server.submitTransaction(transaction);

    // تسجيل العملية في Supabase
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
    console.error("Final Error Log:", err);
    return { 
      statusCode: 500, 
      body: JSON.stringify({ 
        error: 'خطأ في عملية السحب', 
        message: err.message 
      }) 
    };
  }
};
