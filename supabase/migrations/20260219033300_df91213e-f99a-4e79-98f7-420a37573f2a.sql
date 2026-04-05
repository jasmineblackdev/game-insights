-- Hospital CRM: contacts, visit logs, and follow-up reminders

-- Hospitals table
CREATE TABLE public.hospitals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address text DEFAULT '',
  city text DEFAULT '',
  state text DEFAULT '',
  system text DEFAULT '',         -- e.g. "Novant Health", "Atrium Health"
  total_beds integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.hospitals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view hospitals"
  ON public.hospitals FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can manage hospitals"
  ON public.hospitals FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- Hospital contacts (discharge planners, case managers, social workers)
CREATE TABLE public.hospital_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id uuid REFERENCES public.hospitals(id) ON DELETE CASCADE,
  hospital_name text NOT NULL DEFAULT '',
  name text NOT NULL,
  title text NOT NULL DEFAULT '',           -- Case Manager, Discharge Planner, Social Worker
  unit_floor text DEFAULT '',
  phone text DEFAULT '',
  email text DEFAULT '',
  preferred_contact text DEFAULT 'phone',   -- phone | email | text
  -- Relationship health metrics
  referrals_sent integer NOT NULL DEFAULT 0,
  referrals_won integer NOT NULL DEFAULT 0,
  last_contact_date date,
  last_contact_type text DEFAULT '',        -- visit | call | email | text
  relationship_score integer DEFAULT 0,    -- 0-100 computed or manually set
  -- Attribution
  assigned_to uuid,                         -- liaison user id
  notes text DEFAULT '',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.hospital_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view hospital contacts"
  ON public.hospital_contacts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can manage hospital contacts"
  ON public.hospital_contacts FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- Visit and interaction log per contact
CREATE TABLE public.hospital_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES public.hospital_contacts(id) ON DELETE CASCADE,
  hospital_name text NOT NULL DEFAULT '',
  contact_name text NOT NULL DEFAULT '',
  visit_type text NOT NULL DEFAULT 'visit', -- visit | call | email | text | follow-up
  visit_date date NOT NULL DEFAULT CURRENT_DATE,
  notes text DEFAULT '',
  referral_discussed text DEFAULT '',       -- patient name or referral ID discussed
  outcome text DEFAULT '',                  -- e.g. "Committed new referral", "Follow up needed"
  logged_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.hospital_visits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view hospital visits"
  ON public.hospital_visits FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can manage hospital visits"
  ON public.hospital_visits FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- Follow-up reminders / touch schedule
CREATE TABLE public.hospital_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES public.hospital_contacts(id) ON DELETE CASCADE,
  contact_name text NOT NULL DEFAULT '',
  hospital_name text NOT NULL DEFAULT '',
  due_date date NOT NULL,
  follow_up_type text NOT NULL DEFAULT 'visit', -- visit | call | email
  note text DEFAULT '',
  is_completed boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  assigned_to uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.hospital_followups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view followups"
  ON public.hospital_followups FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can manage followups"
  ON public.hospital_followups FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- updated_at triggers
CREATE OR REPLACE FUNCTION public.update_updated_at_crm()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
CREATE TRIGGER update_hospitals_updated_at
  BEFORE UPDATE ON public.hospitals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_crm();
CREATE TRIGGER update_hospital_contacts_updated_at
  BEFORE UPDATE ON public.hospital_contacts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_crm();
CREATE TRIGGER update_hospital_followups_updated_at
  BEFORE UPDATE ON public.hospital_followups
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_crm();
-- Seed hospitals
INSERT INTO public.hospitals (id, name, system, city, state, total_beds) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'Novant Health Presbyterian Medical Center', 'Novant Health', 'Charlotte', 'NC', 831),
  ('a1000000-0000-0000-0000-000000000002', 'Novant Health Huntersville Medical Center', 'Novant Health', 'Huntersville', 'NC', 100),
  ('a1000000-0000-0000-0000-000000000003', 'Atrium Health Carolinas Medical Center', 'Atrium Health', 'Charlotte', 'NC', 874);
-- Seed contacts with relationship data
INSERT INTO public.hospital_contacts
  (id, hospital_id, hospital_name, name, title, unit_floor, phone, email, preferred_contact,
   referrals_sent, referrals_won, last_contact_date, last_contact_type, relationship_score, notes)
VALUES
  ('b1000000-0000-0000-0000-000000000001',
   'a1000000-0000-0000-0000-000000000001', 'Novant Health Presbyterian Medical Center',
   'Karen Williams', 'Case Manager', '3rd Floor — Orthopedics',
   '(704) 555-0201', 'k.williams@novanthealth.org', 'text',
   18, 14, CURRENT_DATE - 1, 'visit', 88,
   'Great relationship. Prefers text over email. Sends high-quality SNF referrals.'),
  ('b1000000-0000-0000-0000-000000000002',
   'a1000000-0000-0000-0000-000000000001', 'Novant Health Presbyterian Medical Center',
   'Dr. Michael Santos', 'Discharge Planner', '5th Floor — Neurology',
   '(704) 555-0215', 'm.santos@novanthealth.org', 'phone',
   12, 9, CURRENT_DATE - 2, 'call', 75,
   'Responds quickly to calls. Prefers morning meetings.'),
  ('b1000000-0000-0000-0000-000000000003',
   'a1000000-0000-0000-0000-000000000001', 'Novant Health Presbyterian Medical Center',
   'Patricia Moore', 'Social Worker', '2nd Floor — General Medicine',
   '(704) 555-0228', 'p.moore@novanthealth.org', 'email',
   7, 4, CURRENT_DATE - 8, 'call', 52,
   'Follow up on two pending referrals from her unit.'),
  ('b1000000-0000-0000-0000-000000000004',
   'a1000000-0000-0000-0000-000000000001', 'Novant Health Presbyterian Medical Center',
   'James Liu', 'Case Manager', '4th Floor — Cardiology',
   '(704) 555-0234', 'j.liu@novanthealth.org', 'phone',
   5, 2, CURRENT_DATE - 21, 'visit', 30,
   'Newer contact. Relationship building in progress.'),
  ('b1000000-0000-0000-0000-000000000005',
   'a1000000-0000-0000-0000-000000000002', 'Novant Health Huntersville Medical Center',
   'Angela Torres', 'Discharge Planner', '2nd Floor — Med-Surg',
   '(704) 555-0245', 'a.torres@novanthealth.org', 'text',
   9, 7, CURRENT_DATE - 4, 'visit', 82,
   'Strong relationship. High conversion rate.'),
  ('b1000000-0000-0000-0000-000000000006',
   'a1000000-0000-0000-0000-000000000003', 'Atrium Health Carolinas Medical Center',
   'Robert Kim', 'Case Manager', '6th Floor — Cardiac ICU',
   '(704) 555-0267', 'r.kim@atriumhealth.org', 'phone',
   3, 1, CURRENT_DATE - 35, 'call', 18,
   'Cold relationship. Need to schedule in-person visit soon.');
-- Seed visit logs
INSERT INTO public.hospital_visits
  (contact_id, hospital_name, contact_name, visit_type, visit_date, notes, outcome)
VALUES
  ('b1000000-0000-0000-0000-000000000001', 'Novant Health Presbyterian Medical Center',
   'Karen Williams', 'visit', CURRENT_DATE - 1,
   'Discussed Margaret Thompson discharge timeline and capacity at Ballantyne Commons.',
   'Committed new referral — Eleanor Davis'),
  ('b1000000-0000-0000-0000-000000000002', 'Novant Health Presbyterian Medical Center',
   'Dr. Michael Santos', 'call', CURRENT_DATE - 2,
   'Called re: James Morrison transport logistics and bed availability.',
   'Transport confirmed for Feb 21'),
  ('b1000000-0000-0000-0000-000000000003', 'Novant Health Presbyterian Medical Center',
   'Patricia Moore', 'call', CURRENT_DATE - 8,
   'Brief check-in, she had two patients nearing discharge.',
   'Follow up needed in 2 days'),
  ('b1000000-0000-0000-0000-000000000005', 'Novant Health Huntersville Medical Center',
   'Angela Torres', 'visit', CURRENT_DATE - 4,
   'In-person visit, left facility brochures and reviewed bed availability.',
   'Two potential referrals next week');
-- Seed follow-up reminders
INSERT INTO public.hospital_followups
  (contact_id, contact_name, hospital_name, due_date, follow_up_type, note)
VALUES
  ('b1000000-0000-0000-0000-000000000003', 'Patricia Moore', 'Novant Health Presbyterian Medical Center',
   CURRENT_DATE + 1, 'call', 'Follow up on 2 pending referrals from General Medicine'),
  ('b1000000-0000-0000-0000-000000000004', 'James Liu', 'Novant Health Presbyterian Medical Center',
   CURRENT_DATE, 'visit', 'Re-engage — no contact in 21 days, relationship score dropping'),
  ('b1000000-0000-0000-0000-000000000006', 'Robert Kim', 'Atrium Health Carolinas Medical Center',
   CURRENT_DATE - 2, 'visit', 'OVERDUE — no visit in 35 days, schedule in-person ASAP'),
  ('b1000000-0000-0000-0000-000000000001', 'Karen Williams', 'Novant Health Presbyterian Medical Center',
   CURRENT_DATE + 3, 'visit', 'Scheduled monthly check-in visit');
