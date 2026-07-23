const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
module.exports = async (req,res) => {
  try {
    if(req.method === 'GET') {
      const { data, error } = await sb.from('products').select('id,seller_pi_id,seller_username,name,description,category,country,location,price_usd,images,status,views,promoted_until,promotion_tier,created_at').eq('status','approved').order('promoted_until',{ascending:false,nullsFirst:false}).order('created_at',{ascending:false});
      if(error) throw error;
      return res.json({products:data||[]});
    }
    if(req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const id = Number(b.id); if(!Number.isInteger(id)||id<1) throw new Error('Invalid id');
      const { data, error } = await sb.rpc('increment_product_views',{product_id_input:id});
      if(error) throw error;
      return res.json({views:data});
    }
    return res.status(405).json({error:'Method not allowed'});
  } catch(e) { return res.status(400).json({error:e.message}); }
};
