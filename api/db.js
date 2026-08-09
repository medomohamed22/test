import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

export function assertDatabaseConfigured() {
  if (!url) throw new Error('SUPABASE_URL is not configured on Vercel');
  if (!key) throw new Error('SUPABASE_SECRET_KEY / SUPABASE_SERVICE_ROLE_KEY is not configured on Vercel');
}

// This privileged client is server-only. Never expose its key in index.html.
export const db = createClient(url || 'http://127.0.0.1:54321', key || 'missing-key', {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
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
