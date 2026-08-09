# Pi in-app notification diagnostics

This version uses the same URL shape as the current official Pi Demo App:

`POST https://api.minepi.com/v2/in_app_notifications/notify`

## Required Vercel environment variables

- `PI_API_KEY` = the Platform API key for the SAME Pi app/domain that users authenticate into.
- `PI_IN_APP_NOTIFICATIONS=true`
- `PI_SANDBOX=false` for Mainnet/production (or true only when actually testing Sandbox).
- Optional: `PI_API_BASE=https://api.minepi.com` (normally omit it).

Do not put `/v2` in `PI_API_BASE` anymore; the helper normalizes either form, but the clean value is the API root.

## Test without sending a chat

Open Settings while signed in and press **اختبار إشعار Pi**.

The browser calls `POST /api/notifications/pi-test`. If Pi rejects the request, the UI shows the HTTP status and Vercel logs contain a structured entry:

`[pi in-app notification] failed { status, response, ... }`

Common causes:

- `401/403`: wrong API key, key belongs to a different app, or the app is not enabled for the notifications capability.
- `400/422`: Pi rejected the notification payload or target UID.
- missing Pi UID: recipient authenticated before the Pi UID was stored; sign out and sign in again.

A permission dialog showing `In app notifications` confirms the user granted the scope, but server delivery still requires Pi Platform to accept the app's API-key request.
