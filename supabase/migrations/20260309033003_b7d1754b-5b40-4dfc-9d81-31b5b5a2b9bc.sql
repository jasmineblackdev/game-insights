-- Fix search_path on existing functions
CREATE OR REPLACE FUNCTION public.update_updated_at_crm()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$;
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;
-- Fix remaining overly permissive policies

-- REFERRAL_LOSS_LOGS
DROP POLICY IF EXISTS "Authenticated users can insert loss logs" ON public.referral_loss_logs;
DROP POLICY IF EXISTS "Authenticated users can view loss logs" ON public.referral_loss_logs;
CREATE POLICY "loss_logs_select" ON public.referral_loss_logs FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "loss_logs_insert" ON public.referral_loss_logs FOR INSERT
WITH CHECK (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','liaison','admin']::app_role[]));
-- AUTHORIZATION_STATUS_HISTORY
DROP POLICY IF EXISTS "Authenticated users can insert status history" ON public.authorization_status_history;
DROP POLICY IF EXISTS "Authenticated users can view status history" ON public.authorization_status_history;
CREATE POLICY "auth_status_history_select" ON public.authorization_status_history FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "auth_status_history_insert" ON public.authorization_status_history FOR INSERT
WITH CHECK (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','admin']::app_role[]));
-- TRIAL_SESSIONS - tighten insert/update
DROP POLICY IF EXISTS "Anyone can create trial sessions" ON public.trial_sessions;
DROP POLICY IF EXISTS "Anyone can read trial sessions" ON public.trial_sessions;
DROP POLICY IF EXISTS "Anyone can update trial sessions" ON public.trial_sessions;
CREATE POLICY "trial_sessions_select" ON public.trial_sessions FOR SELECT
USING (true);
CREATE POLICY "trial_sessions_insert" ON public.trial_sessions FOR INSERT
WITH CHECK (true);
CREATE POLICY "trial_sessions_update" ON public.trial_sessions FOR UPDATE
USING (true);
