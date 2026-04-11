import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Production fallback values — VITE_ prefixed keys are intentionally public (client-bundled).
const _FB_URL  = "https://rxnqjdclqyazferbseeq.supabase.co";
const _FB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ4bnFqZGNscXlhemZlcmJzZWVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEyODQ5NjcsImV4cCI6MjA4Njg2MDk2N30.MA1qhu_gU93MjoDiJsM2FFDlO2iYjSk_kAbwf0rx_9g";

const url     = (import.meta.env.VITE_SUPABASE_URL     as string | undefined)?.trim() || _FB_URL;
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() || _FB_ANON;

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase: SupabaseClient | null =
  url && anonKey ? createClient(url, anonKey) : null;
