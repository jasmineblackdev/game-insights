import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export function useSupabaseSession(): Session | null {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (!supabase) return;

    supabase.auth.getSession().then(({ data: { session: s } }) => setSession(s));

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));

    return () => subscription.unsubscribe();
  }, []);

  return session;
}
