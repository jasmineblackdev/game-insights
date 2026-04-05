-- Fix RLS policies for hospital CRM tables to allow anon key access
-- (consistent with other tables in this project that use USING(true) without role restriction)

DROP POLICY IF EXISTS "Authenticated users can view hospitals" ON public.hospitals;
DROP POLICY IF EXISTS "Authenticated users can manage hospitals" ON public.hospitals;
DROP POLICY IF EXISTS "Authenticated users can view hospital contacts" ON public.hospital_contacts;
DROP POLICY IF EXISTS "Authenticated users can manage hospital contacts" ON public.hospital_contacts;
DROP POLICY IF EXISTS "Authenticated users can view hospital visits" ON public.hospital_visits;
DROP POLICY IF EXISTS "Authenticated users can manage hospital visits" ON public.hospital_visits;
DROP POLICY IF EXISTS "Authenticated users can view followups" ON public.hospital_followups;
DROP POLICY IF EXISTS "Authenticated users can manage followups" ON public.hospital_followups;
-- Recreate without TO authenticated (matches pattern of other tables in this project)
CREATE POLICY "Allow select hospitals" ON public.hospitals FOR SELECT USING (true);
CREATE POLICY "Allow all hospitals" ON public.hospitals FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow select hospital_contacts" ON public.hospital_contacts FOR SELECT USING (true);
CREATE POLICY "Allow all hospital_contacts" ON public.hospital_contacts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow select hospital_visits" ON public.hospital_visits FOR SELECT USING (true);
CREATE POLICY "Allow all hospital_visits" ON public.hospital_visits FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow select hospital_followups" ON public.hospital_followups FOR SELECT USING (true);
CREATE POLICY "Allow all hospital_followups" ON public.hospital_followups FOR ALL USING (true) WITH CHECK (true);
