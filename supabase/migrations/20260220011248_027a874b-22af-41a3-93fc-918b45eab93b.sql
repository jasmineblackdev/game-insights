-- Authorization tracking table
CREATE TABLE public.authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id uuid REFERENCES public.referrals(id) ON DELETE SET NULL,
  patient_name text NOT NULL,
  insurance_payer text NOT NULL DEFAULT '',
  policy_number text DEFAULT '',
  authorization_number text DEFAULT '',
  care_level text DEFAULT '',
  building_id uuid REFERENCES public.buildings(id) ON DELETE SET NULL,
  building_name text DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  priority text NOT NULL DEFAULT 'normal',
  submitted_date date DEFAULT CURRENT_DATE,
  approved_date date,
  effective_date date,
  expiration_date date,
  authorized_days integer,
  days_remaining integer,
  notes text DEFAULT '',
  assigned_to text DEFAULT '',
  assigned_to_user_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.authorizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view authorizations" ON public.authorizations FOR SELECT USING (true);
CREATE POLICY "Authenticated users can manage authorizations" ON public.authorizations FOR ALL USING (true) WITH CHECK (true);
-- Authorization tasks table
CREATE TABLE public.authorization_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_id uuid REFERENCES public.authorizations(id) ON DELETE CASCADE NOT NULL,
  title text NOT NULL,
  description text DEFAULT '',
  assigned_to text DEFAULT '',
  assigned_to_user_id uuid,
  status text NOT NULL DEFAULT 'pending',
  priority text NOT NULL DEFAULT 'normal',
  due_date date,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.authorization_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view auth tasks" ON public.authorization_tasks FOR SELECT USING (true);
CREATE POLICY "Authenticated users can manage auth tasks" ON public.authorization_tasks FOR ALL USING (true) WITH CHECK (true);
-- Authorization documents table
CREATE TABLE public.authorization_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_id uuid REFERENCES public.authorizations(id) ON DELETE CASCADE NOT NULL,
  file_name text NOT NULL,
  file_path text NOT NULL,
  document_type text NOT NULL DEFAULT 'other',
  file_size integer,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.authorization_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view auth docs" ON public.authorization_documents FOR SELECT USING (true);
CREATE POLICY "Authenticated users can manage auth docs" ON public.authorization_documents FOR ALL USING (true) WITH CHECK (true);
-- Triggers for updated_at
CREATE TRIGGER update_authorizations_updated_at BEFORE UPDATE ON public.authorizations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER update_authorization_tasks_updated_at BEFORE UPDATE ON public.authorization_tasks FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
