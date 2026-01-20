const StellarSdk = require('stellar-sdk');
const { createClient } = require('@supabase/supabase-js');

// 1. إعدادات قاعدة البيانات (يفضل وضعها في Environment Variables)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xncapmzlwuisupkjlftb.supabase.co'; 
// استخدم مفتاح الخدمة (Service Role) وليس المفتاح العام
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 

// 2. إعدادات المحفظة والشبكة
const APP_WALLET_SECRET = process.env.APP_WALLET_SECRET;
const PI_HORIZON_URL = 'https://api.testnet.minepi.com';
const NETWORK_PASSPHRASE = 'Pi Testnet';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

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

    // --- خطوة 1: التحقق من الرصيد الحقيقي ---
    // نقوم بجلب العمليات المسجلة فعلياً في الجداول
    const { data: donations } = await supabase.from('donations').select('amount').eq('pi_user_id', uid);
    const { data: withdrawals } = await supabase.from('withdrawals').select('amount').eq('pi_user_id', uid);

    const totalIn = donations?.reduce((s, r) => s + parseFloat(r.amount), 0) || 0;
    const totalOut = withdrawals?.reduce((s, r) => s + parseFloat(r.amount), 0) || 0;
    const currentBalance = totalIn - totalOut;

    if (currentBalance < withdrawAmount) {
      console.log(`[AUTH] محاولة سحب مرفوضة: رصيد ${username} غير كافٍ. المتوفر: ${currentBalance}`);
      return { statusCode: 400, body: JSON.stringify({ error: 'رصيد حسابك غير كافٍ' }) };
    }

    // --- خطوة 2: تنفيذ التحويل على البلوكشين ---
    const server = new StellarSdk.Horizon.Server(PI_HORIZON_URL); 
    const sourceKeys = StellarSdk.Keypair.fromSecret(APP_WALLET_SECRET);
    
    // تحميل بيانات الحساب لضمان الحصول على أحدث Sequence Number
    const sourceAccount = await server.loadAccount(sourceKeys.publicKey());

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: "100000", // الرسوم الثابتة لشبكة Pi
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: walletAddress,
          asset: StellarSdk.Asset.native(),
          amount: withdrawAmount.toFixed(7).toString(), 
        })
      )
      .setTimeout(60) // زيادة المهلة لتجنب أخطاء الشبكة
      .build();

    transaction.sign(sourceKeys);
    
    console.log(`[BLOCKCHAIN] إرسال ${withdrawAmount} إلى ${walletAddress}...`);
    const result = await server.submitTransaction(transaction);
    console.log(`[SUCCESS] Hash: ${result.hash}`);

    // --- خطوة 3: التسجيل النهائي في قاعدة البيانات ---
    const { error: dbError } = await supabase.from('withdrawals').insert([{
      pi_user_id: uid,
      username: username,
      amount: withdrawAmount,
      wallet_address: walletAddress,
      txid: result.hash,
      status: 'completed' // إضافة حالة العملية
    }]);

    if (dbError) throw new Error("فشل التسجيل في الداتابيز بعد التحويل: " + dbError.message);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, txid: result.hash })
    };

  } catch (err) {
    console.error("--- ERROR DEBUG ---");
    let errorMsg = err.message;

    // استخراج تفاصيل الخطأ من Stellar Extras إذا وجدت
    if (err.response?.data?.extras?.result_codes) {
        const codes = err.response.data.extras.result_codes;
        errorMsg = `Blockchain Error: ${codes.transaction} | Op: ${codes.operations?.[0]}`;
    }

    console.error(errorMsg);

    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: 'فشل السحب', details: errorMsg }) 
    };
  }
};
