import os
import json
from pi_python import PiNetwork

# الإعدادات
api_key = os.getenv("PI_API_KEY")
wallet_private_seed = os.getenv("PI_WALLET_SEED")

pi = PiNetwork()
pi.initialize(api_key, wallet_private_seed, "Pi Testnet")

def handler(event, context):
    # التحقق من نوع الطلب
    if event['httpMethod'] != 'POST':
        return {"statusCode": 405, "body": "Method Not Allowed"}

    try:
        body = json.loads(event['body'])
        user_uid = body.get("uid")
        action = body.get("action")

        if action == "pay":
            # إنشاء طلب دفع من المستخدم للتطبيق
            payment_data = {
                "amount": 1.0,
                "memo": "شراء منتج من المتجر",
                "metadata": {"order_id": "123"},
                "uid": user_uid
            }
            payment_id = pi.create_payment(payment_data)
            # ملاحظة: في الواجهة (Frontend) يجب إكمال الدفع عبر الـ SDK
            return {
                "statusCode": 200, 
                "body": json.dumps({"paymentId": payment_id})
            }

        elif action == "refund":
            # الاسترجاع: التطبيق يرسل Pi للمستخدم
            # نستخدم نفس دالة create_payment ولكن بمواصفات تحويل من السيرفر
            refund_data = {
                "amount": 1.0,
                "memo": "استرجاع مبلغ (Refund)",
                "metadata": {"type": "refund"},
                "uid": user_uid
            }
            # في الاسترجاع، السيرفر هو من يبدأ ويكمل العملية
            payment_id = pi.create_payment(refund_data)
            txid = pi.submit_payment(payment_id, False)
            pi.complete_payment(payment_id, txid)
            
            return {
                "statusCode": 200,
                "body": json.dumps({"status": "success", "txid": txid})
            }

    except Exception as e:
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }
        
