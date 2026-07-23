'use strict';
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: true,
    sessionRoute: true,
    databaseEnv: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    piEnv: Boolean(process.env.PI_API_KEY),
  });
};
