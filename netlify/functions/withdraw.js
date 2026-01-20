const StellarSdk = require('stellar-sdk');
const { createClient } = require('@supabase/supabase-js');

// ============================================================
// 1. إعدادات قاعدة البيانات (مكتوبة داخل الكود)
// ============================================================
const SUPABASE_URL = 'https://xncapmzlwuisupkjlftb.supabase.co'; // رابط مشروعك كما هو
const SUPABASE_KEY = 'sb_publishable_zPECXAiI_bDbeLtRYe3vIw_IEt_p_AS'; // ⚠️ استبدل هذا بالمفتاح الخاص بك

// ============================================================
// 2. إعدادات المحفظة (من متغيرات البيئة - Env Variables)
// ============================================================
// يجب إضافة هذا المتغير في إعدادات Netlify باسم APP_WALLET_SECRET
const APP_WALLET_SECRET = process.env.APP_WALLET_SECRET;

// ============================================================
// 3. إعدادات شبكة Pi Testnet (ثابتة)
// ============================================================
const PI_HORIZON_URL = 'https://api.testnet.minepi.com';
const NETWORK_PASSPHRASE = 'Pi Testnet';

// تهيئة Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

exports.handler = async (event) => {
  // التأكد من أن الطلب هو POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // تحقق أمني سريع: هل مفتاح المحفظة موجود في البيئة؟
  if (!APP_WALLET_SECRET) {
    console.error("Missing APP_WALLET_SECRET in environment variables");
    return { statusCode: 500, body: JSON.stringify({ error: 'Server Configuration Error: Wallet Secret Missing' }) };
  }

  const { uid, username, amount, walletAddress } = JSON.parse(event.body);
  const withdrawAmount = parseFloat(amount);

  if (!uid || !withdrawAmount || !walletAddress) {
    return { statusCode: 400, body: JSON.stringify({ error: 'بيانات ناقصة' }) };
  }

  try {
    // ---------------------------------------------------------
    // خطوة 1: التحقق من الرصيد (باستخدام إعدادات Supabase الموجودة في الكود)
    // ---------------------------------------------------------
    
    // جلب التبرعات
    const { data: donations } = await supabase
      .from('donations')
      .select('amount')
      .eq('pi_user_id', uid);
      
    // جلب السحوبات
    const { data: withdrawals } = await supabase
      .from('withdrawals')
      .select('amount')
      .eq('pi_user_id', uid);

    const totalDonated = donations ? donations.reduce((sum, row) => sum + parseFloat(row.amount), 0) : 0;
    const totalWithdrawn = withdrawals ? withdrawals.reduce((sum, row) => sum + parseFloat(row.amount), 0) : 0;
    const currentBalance = totalDonated - totalWithdrawn;

    if (currentBalance < withdrawAmount) {
      return { statusCode: 400, body: JSON.stringify({ error: 'رصيدك غير كافٍ للسحب' }) };
    }

    // ---------------------------------------------------------
    // خطوة 2: تنفيذ التحويل (باستخدام المفتاح السري من الـ ENV)
    // ---------------------------------------------------------

    const server = new StellarSdk.Server(PI_HORIZON_URL);
    const sourceKeys = StellarSdk.Keypair.fromSecret(APP_WALLET_SECRET);
    const sourceAccount = await server.loadAccount(sourceKeys.publicKey());

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: "10000",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: walletAddress,
          asset: StellarSdk.Asset.native(),
          amount: withdrawAmount.toString(),
        })
      )
      .setTimeout(30)
      .build();

    transaction.sign(sourceKeys);
    const result = await server.submitTransaction(transaction);

    // ---------------------------------------------------------
    // خطوة 3: تسجيل العملية
    // ---------------------------------------------------------
    
    await supabase.from('withdrawals').insert([{
      pi_user_id: uid,
      username: username,
      amount: withdrawAmount,
      wallet_address: walletAddress,
      txid: result.hash
    }]);

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        txid: result.hash, 
        newBalance: currentBalance - withdrawAmount 
      })
    };

  } catch (err) {
    console.error("Withdraw Error:", err);
    let errorDetail = err.message;
    if (err.response && err.response.data) {
        errorDetail = JSON.stringify(err.response.data); // تفاصيل خطأ البلوكشين
    }
    return { statusCode: 500, body: JSON.stringify({ error: 'فشل التحويل', details: errorDetail }) };
  }
};
