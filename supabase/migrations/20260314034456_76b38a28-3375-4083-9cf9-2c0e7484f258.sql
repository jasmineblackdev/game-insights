-- Resident events table: drives the Family Portal timeline
-- Events are created automatically when staff complete workflow steps in NexusCare
CREATE TABLE public.resident_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resident_name text NOT NULL,
  referral_id uuid REFERENCES public.referrals(id) ON DELETE SET NULL,
  building_id uuid REFERENCES public.buildings(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  event_label text NOT NULL DEFAULT '',
  event_description text DEFAULT '',
  metadata jsonb DEFAULT '{}',
  created_by uuid,
  created_by_name text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Index for fast portal queries
CREATE INDEX idx_resident_events_referral ON public.resident_events(referral_id);
CREATE INDEX idx_resident_events_type ON public.resident_events(event_type);
-- RLS
ALTER TABLE public.resident_events ENABLE ROW LEVEL SECURITY;
-- Staff can read all events
CREATE POLICY "resident_events_select" ON public.resident_events
  FOR SELECT TO public
  USING (is_demo_mode() OR auth.uid() IS NOT NULL);
-- Staff with intake/ad/admin roles can create events
CREATE POLICY "resident_events_insert" ON public.resident_events
  FOR INSERT TO public
  WITH CHECK (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','building_admin','admin']::app_role[]));
-- Staff can update events
CREATE POLICY "resident_events_update" ON public.resident_events
  FOR UPDATE TO public
  USING (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','building_admin','admin']::app_role[]));
-- Only admins can delete
CREATE POLICY "resident_events_delete" ON public.resident_events
  FOR DELETE TO public
  USING (is_demo_mode() OR has_role(auth.uid(), 'admin'::app_role));
-- Enable realtime for instant portal updates
ALTER PUBLICATION supabase_realtime ADD TABLE public.resident_events;
