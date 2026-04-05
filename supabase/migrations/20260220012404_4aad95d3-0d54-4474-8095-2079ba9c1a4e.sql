-- Activity logs table for HIPAA-compliant audit trail
CREATE TABLE public.activity_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  user_email text DEFAULT '',
  user_name text DEFAULT '',
  action text NOT NULL,
  resource_type text NOT NULL DEFAULT '',
  resource_id text DEFAULT '',
  details jsonb DEFAULT '{}',
  ip_address text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
-- Only admins can view all logs; users can view their own
CREATE POLICY "Users can view own activity logs" ON public.activity_logs
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Admins can view all activity logs" ON public.activity_logs
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));
-- Anyone authenticated can insert logs (logging their own actions)
CREATE POLICY "Authenticated users can insert logs" ON public.activity_logs
  FOR INSERT WITH CHECK (auth.uid() = user_id);
-- Create index for performance
CREATE INDEX idx_activity_logs_user_id ON public.activity_logs(user_id);
CREATE INDEX idx_activity_logs_created_at ON public.activity_logs(created_at DESC);
CREATE INDEX idx_activity_logs_action ON public.activity_logs(action);
-- Add RLS policy to user_roles for authenticated reads
CREATE POLICY "Users can view own roles" ON public.user_roles
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Admins can manage all roles" ON public.user_roles
  FOR ALL USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
