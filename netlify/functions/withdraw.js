// تغيير طريقة الاستيراد لتجنب مشاكل الإصدارات
const { Server, Keypair, TransactionBuilder, Asset, Operation } = require('stellar-sdk');
const { createClient } = require('@supabase/supabase-js');

// 1. إعدادات قاعدة البيانات (مكتوبة داخل الكود)
const SUPABASE_URL = 'https://xncapmzlwuisupkjlftb.supabase.co'; 
const SUPABASE_KEY = 'sb_publishable_zPECXAiI_bDbeLtRYe3vIw_IEt_p_AS'; 

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

  if (!APP_WALLET_SECRET) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Wallet Secret Missing' }) };
  }

  const { uid, username, amount, walletAddress } = JSON.parse(event.body);
  const withdrawAmount = parseFloat(amount);

  try {
    // خطوة 1: التحقق من الرصيد
    const { data: donations } = await supabase.from('donations').select('amount').eq('pi_user_id', uid);
    const { data: withdrawals } = await supabase.from('withdrawals').select('amount').eq('pi_user_id', uid);

    const totalDonated = donations ? donations.reduce((sum, row) => sum + parseFloat(row.amount), 0) : 0;
    const totalWithdrawn = withdrawals ? withdrawals.reduce((sum, row) => sum + parseFloat(row.amount), 0) : 0;
    const currentBalance = totalDonated - totalWithdrawn;

    if (currentBalance < withdrawAmount) {
      return { statusCode: 400, body: JSON.stringify({ error: 'رصيد غير كافٍ' }) };
    }

    // ---------------------------------------------------------
    // خطوة 2: تنفيذ التحويل (بالطريقة الجديدة المتوافقة مع Stellar SDK)
    // ---------------------------------------------------------

    // إنشاء كائن السيرفر
    const server = new Server(PI_HORIZON_URL);
    
    // إنشاء كائن المفاتيح
    const sourceKeys = Keypair.fromSecret(APP_WALLET_SECRET);
    
    // تحميل الحساب
    const sourceAccount = await server.loadAccount(sourceKeys.publicKey());

    // بناء المعاملة
    const transaction = new TransactionBuilder(sourceAccount, {
      fee: "10000", 
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        Operation.payment({
          destination: walletAddress,
          asset: Asset.native(),
          amount: withdrawAmount.toFixed(7).toString(), // ضمان وجود 7 أرقام عشرية كما تطلب Stellar
        })
      )
      .setTimeout(30)
      .build();

    transaction.sign(sourceKeys);
    const result = await server.submitTransaction(transaction);

    // خطوة 3: تسجيل العملية
    await supabase.from('withdrawals').insert([{
      pi_user_id: uid,
      username: username,
      amount: withdrawAmount,
      wallet_address: walletAddress,
      txid: result.hash
    }]);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, txid: result.hash, newBalance: currentBalance - withdrawAmount })
    };

  } catch (err) {
    console.error("Detailed Withdraw Error:", err);
    return { 
      statusCode: 500, 
      body: JSON.stringify({ 
        error: 'فشل التحويل', 
        message: err.message,
        details: err.response ? err.response.data : null 
      }) 
    };
  }
};
