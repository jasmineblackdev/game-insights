ALTER TABLE public.trial_sessions ALTER COLUMN expires_at SET DEFAULT (now() + interval '90 days');
