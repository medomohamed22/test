const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
);

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      const { data, error } = await sb
        .from('products')
        .select('id,seller_pi_id,seller_username,name,description,category,country,location,price_usd,images,status,views,promoted_until,promotion_tier,created_at')
        .eq('status', 'approved')
        .order('promoted_until', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false });

      if (error) throw error;
      return res.status(200).json({ products: data || [] });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const id = Number(body.id);
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: 'Invalid id' });
      }

      // View counting must never stop a product from opening. If the database
      // function is temporarily unavailable, return success and keep the UI usable.
      const { data, error } = await sb.rpc('increment_product_views', {
        product_id_input: id,
      });

      if (error) {
        console.error('increment_product_views failed:', error.message);
        return res.status(200).json({ views: null, counted: false });
      }

      return res.status(200).json({ views: data, counted: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('public-products error:', error);
    return res.status(500).json({ error: 'Request failed' });
  }
};
