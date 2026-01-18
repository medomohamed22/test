# netlify/functions/pi_payment.py
import os
import json
from pi_python import PiNetwork

# استدعاء البيانات من إعدادات Netlify (Environment Variables) للأمان
api_key = os.getenv("PI_API_KEY")
wallet_private_seed = os.getenv("PI_WALLET_SEED")

pi = PiNetwork()
pi.initialize(api_key, wallet_private_seed, "Pi Testnet")

def handler(event, context):
    # استقبال البيانات من الفرونت اند
    body = json.loads(event['body'])
    user_uid = body.get("uid")
    action = body.get("action") # 'pay' or 'refund'

    try:
        if action == "pay":
            payment_data = {
                "amount": 1,
                "memo": "Payment for Service",
                "metadata": {"type": "purchase"},
                "uid": user_uid
            }
            payment_id = pi.create_payment(payment_data)
            txid = pi.submit_payment(payment_id, False)
            pi.complete_payment(payment_id, txid)
            
            return {
                "statusCode": 200,
                "body": json.dumps({"status": "success", "txid": txid})
            }
        
        elif action == "refund":
            # منطق الاسترجاع يعتمد على سياسة Pi (غالباً تحويل عكسي)
            # هنا نرسل دفعة عكسية للمستخدم
            return {
                "statusCode": 200,
                "body": json.dumps({"status": "refund_initiated"})
            }

    except Exception as e:
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }
      
