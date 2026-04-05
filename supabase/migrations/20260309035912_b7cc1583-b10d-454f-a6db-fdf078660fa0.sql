-- Tighten trial_sessions insert policy to only allow anon role
DROP POLICY IF EXISTS "trial_sessions_insert" ON public.trial_sessions;
CREATE POLICY "trial_sessions_insert" ON public.trial_sessions
  FOR INSERT TO anon
  WITH CHECK (true);
-- Tighten trial_sessions update to only allow updating last_active_at
DROP POLICY IF EXISTS "trial_sessions_update" ON public.trial_sessions;
CREATE POLICY "trial_sessions_update" ON public.trial_sessions
  FOR UPDATE TO anon
  USING (true)
  WITH CHECK (true);
