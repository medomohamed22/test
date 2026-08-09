# DealWay — Pi in-app notifications

This build keeps the existing DealWay notification center and Web Push, and adds Pi Browser in-app notifications.

## What changed

- Pi authentication now requests: `username`, `payments`, `in_app_notifications`.
- Server sends Pi notifications through `POST /v2/in_app_notifications/notify`.
- A Pi notification is sent when:
  - a user receives a chat message (including messages about one of their listings),
  - a seller receives a new purchase offer,
  - either party receives an offer-status update.
- Notification failures never block messages/offers. Existing database notifications and Web Push remain enabled.

## Required environment variables

```env
PI_API_KEY=your_pi_app_api_key
PI_SANDBOX=false
PI_IN_APP_NOTIFICATIONS=true
```

Keep `PI_API_KEY` only on the server. Never expose it in browser JavaScript.

The project already stores each authenticated user's Pi app-specific `pi_uid` in `profiles`. That UID is used as `third_party_app_user_uid` for Pi notifications.

## Testing

1. Deploy the app with the environment variables above.
2. Open DealWay inside Pi Browser.
3. Sign out and sign in again so Pi can show the updated permission consent dialog.
4. Confirm **In app notifications**.
5. Use a second Pi account to send a message or submit an offer on the first account's listing.
6. The recipient should get the existing DealWay notification plus the Pi in-app notification.

If Pi has not enabled the notification capability for the app/API key, the server logs `[pi in-app notification] ...`; chat and offers still work normally.
