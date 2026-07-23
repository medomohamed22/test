'use strict';
// Compatibility helper. The Pi access token remains in memory only.
let securePiAccessToken = null;
async function securePiLogin() {
  if (!window.Pi) throw new Error('Open this app inside Pi Browser');
  await Promise.resolve(window.Pi.init({ version: '2.0', sandbox: false }));
  const auth = await window.Pi.authenticate(['username', 'payments'], payment => {
    console.warn('Incomplete Pi payment:', payment?.identifier || payment);
  });
  securePiAccessToken = auth.accessToken;
  return auth;
}
function secureAuthHeaders() {
  return securePiAccessToken ? { Authorization: `Bearer ${securePiAccessToken}` } : {};
}
