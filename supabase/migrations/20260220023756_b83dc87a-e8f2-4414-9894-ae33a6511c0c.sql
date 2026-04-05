-- Building Status table (separate from referral status, per architecture requirement)
CREATE TABLE public.building_statuses (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  building_id uuid NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open',  -- open, admissions_hold, state_tag_hold, staffing_hold, isolation_hold
  reason text DEFAULT '',
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  ended_at timestamp with time zone,
  started_by text DEFAULT '',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.building_statuses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view building statuses"
ON public.building_statuses FOR SELECT USING (true);
CREATE POLICY "Authenticated users can manage building statuses"
ON public.building_statuses FOR ALL USING (true) WITH CHECK (true);
-- Hold revenue impact logs
CREATE TABLE public.hold_revenue_impact (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  building_id uuid NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  building_name text NOT NULL DEFAULT '',
  hold_status_id uuid REFERENCES public.building_statuses(id) ON DELETE SET NULL,
  referral_id text NOT NULL DEFAULT '',
  patient_name text NOT NULL DEFAULT '',
  estimated_daily_rate numeric DEFAULT 250,
  estimated_los_days integer DEFAULT 30,
  estimated_lost_revenue numeric GENERATED ALWAYS AS (estimated_daily_rate * estimated_los_days) STORED,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
ALTER TABLE public.hold_revenue_impact ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view hold revenue impact"
ON public.hold_revenue_impact FOR SELECT USING (true);
CREATE POLICY "Authenticated users can manage hold revenue impact"
ON public.hold_revenue_impact FOR ALL USING (true) WITH CHECK (true);
-- Trigger for updated_at
CREATE TRIGGER update_building_statuses_updated_at
BEFORE UPDATE ON public.building_statuses
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
