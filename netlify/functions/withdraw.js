const StellarSdk = require('stellar-sdk');
const { createClient } = require('@supabase/supabase-js');

// 1. إعدادات البيئة (تأكد من إضافتها في لوحة تحكم الاستضافة)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xncapmzlwuisupkjlftb.supabase.co'; 
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // مفتاح Service Role
const APP_WALLET_SECRET = process.env.APP_WALLET_SECRET; // المفتاح السري الذي يبدأ بـ S
const PI_HORIZON_URL = 'https://api.testnet.minepi.com';
const NETWORK_PASSPHRASE = 'Pi Testnet';

// تهيئة عميل Supabase بمفتاح الخدمة لتجاوز الـ RLS
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

exports.handler = async (event) => {
  // السماح فقط بطلبات POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { uid, username, amount, walletAddress } = JSON.parse(event.body);
    const withdrawAmount = parseFloat(amount);

    // التحقق الأولي من البيانات
    if (!uid || !amount || !walletAddress) {
      return { statusCode: 400, body: JSON.stringify({ error: 'بيانات ناقصة: تأكد من إرسال المعرف والكمية والعنوان' }) };
    }

    // --- خطوة 1: التحقق من الرصيد في الداتابيز (Security Check) ---
    const { data: donations } = await supabase.from('donations').select('amount').eq('pi_user_id', uid);
    const { data: withdrawals } = await supabase.from('withdrawals').select('amount').eq('pi_user_id', uid);

    const totalIn = donations?.reduce((s, r) => s + parseFloat(r.amount), 0) || 0;
    const totalOut = withdrawals?.reduce((s, r) => s + parseFloat(r.amount), 0) || 0;
    const currentBalance = totalIn - totalOut;

    if (currentBalance < withdrawAmount) {
      return { 
        statusCode: 400, 
        body: JSON.stringify({ error: `رصيد غير كافٍ. رصيدك الحالي: ${currentBalance.toFixed(2)} π` }) 
      };
    }

    // --- خطوة 2: تهيئة مفاتيح المحفظة والاتصال بالبلوكشين ---
    if (!APP_WALLET_SECRET) {
      throw new Error("فشل السيرفر: APP_WALLET_SECRET غير معرف في الإعدادات.");
    }

    const server = new StellarSdk.Horizon.Server(PI_HORIZON_URL);
    const sourceKeys = StellarSdk.Keypair.fromSecret(APP_WALLET_SECRET);
    
    // تحميل بيانات الحساب لجلب الـ Sequence Number الحالي
    let sourceAccount;
    try {
        sourceAccount = await server.loadAccount(sourceKeys.publicKey());
    } catch (e) {
        throw new Error("فشل تحميل بيانات محفظة النظام. تأكد أنها مفعلة وبها رصيد.");
    }

    // بناء المعاملة
    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: "100000", // رسوم ثابتة لشبكة باي (0.01 Pi)
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: walletAddress,
          asset: StellarSdk.Asset.native(),
          amount: withdrawAmount.toFixed(7).toString(), // الدقة المطلوبة في Stellar
        })
      )
      .setTimeout(60) // مهلة دقيقة للاستجابة
      .build();

    // توقيع المعاملة
    transaction.sign(sourceKeys);

    // إرسال المعاملة
    console.log(`[PROCESS] إرسال ${withdrawAmount} إلى ${walletAddress}...`);
    const result = await server.submitTransaction(transaction);
    console.log(`[SUCCESS] Tx Hash: ${result.hash}`);

    // --- خطوة 3: التسجيل في Supabase بعد نجاح التحويل ---
    const { error: dbError } = await supabase.from('withdrawals').insert([{
      pi_user_id: uid,
      username: username || 'unknown',
      amount: withdrawAmount,
      wallet_address: walletAddress,
      txid: result.hash,
      status: 'completed'
    }]);

    if (dbError) {
        // تنبيه: هنا تم التحويل فعلياً لكن فشل التسجيل، يجب مراجعة الـ Logs
        console.error("[DB ERROR] تم التحويل لكن فشل التسجيل:", dbError.message);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        success: true, 
        txid: result.hash,
        message: 'تمت عملية السحب بنجاح' 
      })
    };

  } catch (err) {
    console.error("--- CATCH ERROR ---");
    let detailedError = err.message;

    // استخراج أخطاء البلوكشين التفصيلية (مثل نقص الرصيد في محفظة السيرفر)
    if (err.response?.data?.extras?.result_codes) {
        const codes = err.response.data.extras.result_codes;
        const opCode = codes.operations ? codes.operations[0] : '';
        
        if (opCode === 'op_underfunded') {
            detailedError = "محفظة النظام (المصدر) لا تحتوي على رصيد كافٍ.";
        } else if (codes.transaction === 'tx_bad_seq') {
            detailedError = "خطأ في تسلسل المعاملات، يرجى المحاولة مرة أخرى.";
        } else {
            detailedError = `Blockchain Error: ${codes.transaction} (${opCode})`;
        }
    }

    console.error(detailedError);
    return { 
      statusCode: 500, 
      body: JSON.stringify({ error: 'فشل السحب من جهة السيرفر', details: detailedError }) 
    };
  }
};
