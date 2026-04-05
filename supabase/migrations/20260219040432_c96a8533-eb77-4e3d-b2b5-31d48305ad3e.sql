-- Create referral follow-up sequences table
CREATE TABLE public.referral_followup_sequences (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  referral_id text NOT NULL,
  patient_name text NOT NULL DEFAULT '',
  building_id uuid REFERENCES public.buildings(id),
  building_name text NOT NULL DEFAULT '',
  day integer NOT NULL DEFAULT 0,
  task_label text NOT NULL DEFAULT '',
  task_description text NOT NULL DEFAULT '',
  task_type text NOT NULL DEFAULT 'call', -- call, email, sms, in-person
  due_date date NOT NULL DEFAULT CURRENT_DATE,
  is_completed boolean NOT NULL DEFAULT false,
  completed_at timestamp with time zone,
  completed_by text,
  completed_by_user_id uuid,
  notes text DEFAULT '',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
-- Enable RLS
ALTER TABLE public.referral_followup_sequences ENABLE ROW LEVEL SECURITY;
-- Policies (same pattern as other tables — internal tool)
CREATE POLICY "Allow select referral_followup_sequences"
  ON public.referral_followup_sequences FOR SELECT
  USING (true);
CREATE POLICY "Allow all referral_followup_sequences"
  ON public.referral_followup_sequences FOR ALL
  USING (true)
  WITH CHECK (true);
-- Updated_at trigger
CREATE TRIGGER update_referral_followup_sequences_updated_at
  BEFORE UPDATE ON public.referral_followup_sequences
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();
