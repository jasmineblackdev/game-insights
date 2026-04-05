CREATE TABLE public.invite_codes (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true,
  max_uses INTEGER NOT NULL DEFAULT 5,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id)
);
ALTER TABLE public.invite_codes ENABLE ROW LEVEL SECURITY;
-- Anyone can validate a code (needed for trial login)
CREATE POLICY "Anyone can validate invite codes" ON public.invite_codes
  FOR SELECT USING (true);
-- Only admins can manage invite codes
CREATE POLICY "Admins can manage invite codes" ON public.invite_codes
  FOR ALL USING (public.has_role(auth.uid(), 'admin'));
-- Track trial sessions
CREATE TABLE public.trial_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  invite_code_id UUID REFERENCES public.invite_codes(id) ON DELETE SET NULL,
  code_used TEXT NOT NULL,
  company_name TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  session_token TEXT NOT NULL UNIQUE,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  last_active_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (now() + interval '24 hours')
);
ALTER TABLE public.trial_sessions ENABLE ROW LEVEL SECURITY;
-- Public access for trial session validation (no auth required)
CREATE POLICY "Anyone can read trial sessions" ON public.trial_sessions
  FOR SELECT USING (true);
CREATE POLICY "Anyone can create trial sessions" ON public.trial_sessions
  FOR INSERT WITH CHECK (true);
CREATE POLICY "Anyone can update trial sessions" ON public.trial_sessions
  FOR UPDATE USING (true);
-- Insert a default demo invite code
INSERT INTO public.invite_codes (code, label, max_uses, expires_at)
VALUES ('NEXUS-DEMO-2026', 'Default demo code', 100, '2027-12-31T23:59:59Z');
