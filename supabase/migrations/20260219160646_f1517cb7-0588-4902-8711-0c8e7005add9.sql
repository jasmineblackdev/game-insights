-- Create support tickets table
CREATE TABLE public.support_tickets (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ticket_number text NOT NULL DEFAULT 'TKT-' || to_char(now(), 'YYYYMMDD') || '-' || substr(gen_random_uuid()::text, 1, 6),
  title text NOT NULL,
  description text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  priority text NOT NULL DEFAULT 'medium',
  status text NOT NULL DEFAULT 'open',
  submitted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  submitted_by_name text NOT NULL DEFAULT '',
  submitted_by_email text NOT NULL DEFAULT '',
  assigned_to text,
  resolution_notes text,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
-- Enable RLS
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
-- Users can view their own tickets
CREATE POLICY "Users can view own tickets"
  ON public.support_tickets
  FOR SELECT
  USING (auth.uid() = submitted_by OR has_role(auth.uid(), 'admin'::app_role));
-- Users can insert their own tickets
CREATE POLICY "Users can submit tickets"
  ON public.support_tickets
  FOR INSERT
  WITH CHECK (auth.uid() = submitted_by);
-- Admins can update any ticket
CREATE POLICY "Admins can update tickets"
  ON public.support_tickets
  FOR UPDATE
  USING (has_role(auth.uid(), 'admin'::app_role));
-- Trigger to auto-update updated_at
CREATE TRIGGER update_support_tickets_updated_at
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();
-- Add comments for clarity
COMMENT ON TABLE public.support_tickets IS 'Support tickets submitted by clients for engineering/support team';
COMMENT ON COLUMN public.support_tickets.category IS 'bug, feature_request, general, billing, performance';
COMMENT ON COLUMN public.support_tickets.priority IS 'low, medium, high, critical';
COMMENT ON COLUMN public.support_tickets.status IS 'open, in_progress, resolved, closed';
