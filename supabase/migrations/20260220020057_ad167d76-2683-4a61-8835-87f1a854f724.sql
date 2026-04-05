-- Add new columns to authorizations for the structured workflow
ALTER TABLE public.authorizations
  ADD COLUMN IF NOT EXISTS resident_first_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS resident_last_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS insurance_id_number text DEFAULT '',
  ADD COLUMN IF NOT EXISTS anticipated_admit_date date,
  ADD COLUMN IF NOT EXISTS payer_reference_number text DEFAULT '',
  ADD COLUMN IF NOT EXISTS created_by_role text DEFAULT '';
-- Create authorization status history table for audit trail
CREATE TABLE IF NOT EXISTS public.authorization_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_id uuid NOT NULL REFERENCES public.authorizations(id) ON DELETE CASCADE,
  old_status text,
  new_status text NOT NULL,
  changed_by_name text NOT NULL DEFAULT '',
  changed_by_role text NOT NULL DEFAULT '',
  changed_by_user_id uuid,
  notes text DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Enable RLS on status history
ALTER TABLE public.authorization_status_history ENABLE ROW LEVEL SECURITY;
-- RLS policies for status history
CREATE POLICY "Authenticated users can view status history"
  ON public.authorization_status_history FOR SELECT
  USING (true);
CREATE POLICY "Authenticated users can insert status history"
  ON public.authorization_status_history FOR INSERT
  WITH CHECK (true);
