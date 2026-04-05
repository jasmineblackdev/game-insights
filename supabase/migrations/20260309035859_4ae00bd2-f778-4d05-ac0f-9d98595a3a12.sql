-- Grant anon role access to invite_codes and trial_sessions
GRANT SELECT ON public.invite_codes TO anon;
GRANT SELECT, INSERT, UPDATE ON public.trial_sessions TO anon;
GRANT UPDATE ON public.invite_codes TO anon;
-- Add RLS policy allowing anon to increment invite code usage
CREATE POLICY "Anon can increment invite code usage"
  ON public.invite_codes
  FOR UPDATE
  TO anon
  USING (is_active = true)
  WITH CHECK (is_active = true);
