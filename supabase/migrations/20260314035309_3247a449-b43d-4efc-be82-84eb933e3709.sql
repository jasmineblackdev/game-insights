-- Admissions table: structured admission record with milestone tracking
CREATE TABLE public.admissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id uuid REFERENCES public.referrals(id) ON DELETE SET NULL,
  building_id uuid REFERENCES public.buildings(id) ON DELETE SET NULL,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  
  -- Resident info
  resident_name text NOT NULL,
  resident_dob date,
  stay_type text NOT NULL DEFAULT 'Short-Term Rehab',
  
  -- Admission status (broad)
  admission_status text NOT NULL DEFAULT 'Accepted',
  admission_date date,
  expected_arrival_date date,
  actual_arrival_date date,
  
  -- Room
  room_number text DEFAULT '',
  unit text DEFAULT '',
  
  -- Milestone statuses
  paperwork_status text NOT NULL DEFAULT 'Not Started',
  evaluation_status text NOT NULL DEFAULT 'Not Needed',
  evaluation_needed boolean NOT NULL DEFAULT true,
  evaluation_scheduled_date date,
  evaluation_completed_date date,
  evaluation_notes_summary text DEFAULT '',
  
  -- Discharge planning
  discharge_status text NOT NULL DEFAULT 'Not Started',
  estimated_length_of_stay text DEFAULT '',
  estimated_discharge_start date,
  estimated_discharge_end date,
  confirmed_discharge_date date,
  
  -- Family portal
  family_portal_enabled boolean NOT NULL DEFAULT false,
  family_visibility_level text NOT NULL DEFAULT 'standard',
  
  -- Assignment
  assigned_owner_id uuid,
  assigned_owner_name text DEFAULT '',
  
  -- Tracking
  last_status_updated_by uuid,
  last_status_updated_at timestamptz DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Indexes
CREATE INDEX idx_admissions_referral ON public.admissions(referral_id);
CREATE INDEX idx_admissions_building ON public.admissions(building_id);
CREATE INDEX idx_admissions_status ON public.admissions(admission_status);
CREATE INDEX idx_admissions_org ON public.admissions(organization_id);
-- RLS
ALTER TABLE public.admissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admissions_select" ON public.admissions
  FOR SELECT TO public
  USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "admissions_insert" ON public.admissions
  FOR INSERT TO public
  WITH CHECK (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','building_admin','admin']::app_role[]));
CREATE POLICY "admissions_update" ON public.admissions
  FOR UPDATE TO public
  USING (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','building_admin','admin']::app_role[]));
CREATE POLICY "admissions_delete" ON public.admissions
  FOR DELETE TO public
  USING (is_demo_mode() OR has_role(auth.uid(), 'admin'::app_role));
-- Family contacts table
CREATE TABLE public.family_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admission_id uuid REFERENCES public.admissions(id) ON DELETE CASCADE NOT NULL,
  name text NOT NULL,
  relationship text NOT NULL DEFAULT '',
  email text DEFAULT '',
  phone text DEFAULT '',
  portal_access_status text NOT NULL DEFAULT 'Not Invited',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_family_contacts_admission ON public.family_contacts(admission_id);
ALTER TABLE public.family_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "family_contacts_select" ON public.family_contacts
  FOR SELECT TO public
  USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "family_contacts_insert" ON public.family_contacts
  FOR INSERT TO public
  WITH CHECK (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','building_admin','admin']::app_role[]));
CREATE POLICY "family_contacts_update" ON public.family_contacts
  FOR UPDATE TO public
  USING (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','building_admin','admin']::app_role[]));
CREATE POLICY "family_contacts_delete" ON public.family_contacts
  FOR DELETE TO public
  USING (is_demo_mode() OR has_role(auth.uid(), 'admin'::app_role));
-- Enable realtime for admissions
ALTER PUBLICATION supabase_realtime ADD TABLE public.admissions;
-- Auto-update updated_at
CREATE TRIGGER update_admissions_updated_at
  BEFORE UPDATE ON public.admissions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER update_family_contacts_updated_at
  BEFORE UPDATE ON public.family_contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
