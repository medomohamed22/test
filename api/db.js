import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) console.warn('Supabase env vars are missing.');

export const db = createClient(url || 'http://localhost', key || 'missing', {
  auth: { persistSession: false, autoRefreshToken: false }
});

export async function one(query) {
  const { data, error } = await query.single();
  if (error) throw error;
  return data;
}

export async function many(query) {
  const { data, error, count } = await query;
  if (error) throw error;
  return { data: data || [], count };
}
