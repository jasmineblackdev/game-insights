-- Helper function: returns true when no user is logged in (demo/anon mode)
CREATE OR REPLACE FUNCTION public.is_demo_mode()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NULL
$$;
-- Helper function: checks if user has ANY of the specified roles
CREATE OR REPLACE FUNCTION public.has_any_role(_user_id uuid, _roles app_role[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = ANY(_roles)
  )
$$;
-- ============================================================
-- REFERRALS: Role-based access
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can manage referrals" ON public.referrals;
DROP POLICY IF EXISTS "Authenticated users can view referrals" ON public.referrals;
-- SELECT: demo OR any authenticated user
CREATE POLICY "referrals_select" ON public.referrals FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
-- INSERT: demo OR intake, ad, liaison, admin
CREATE POLICY "referrals_insert" ON public.referrals FOR INSERT
WITH CHECK (
  is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','liaison','admin']::app_role[])
);
-- UPDATE: demo OR intake, ad, liaison, regional, admin
CREATE POLICY "referrals_update" ON public.referrals FOR UPDATE
USING (
  is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','liaison','regional','admin']::app_role[])
);
-- DELETE: demo OR admin only
CREATE POLICY "referrals_delete" ON public.referrals FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
-- ============================================================
-- AUTHORIZATIONS: Role-based access
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can manage authorizations" ON public.authorizations;
DROP POLICY IF EXISTS "Authenticated users can view authorizations" ON public.authorizations;
CREATE POLICY "authorizations_select" ON public.authorizations FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "authorizations_insert" ON public.authorizations FOR INSERT
WITH CHECK (
  is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','admin']::app_role[])
);
CREATE POLICY "authorizations_update" ON public.authorizations FOR UPDATE
USING (
  is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','admin']::app_role[])
);
CREATE POLICY "authorizations_delete" ON public.authorizations FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
-- ============================================================
-- PROSPECTS: Role-based access
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can manage prospects" ON public.prospects;
DROP POLICY IF EXISTS "Authenticated users can view prospects" ON public.prospects;
CREATE POLICY "prospects_select" ON public.prospects FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "prospects_insert" ON public.prospects FOR INSERT
WITH CHECK (
  is_demo_mode() OR has_any_role(auth.uid(), ARRAY['sales_counselor','sales_marketing','ad','admin']::app_role[])
);
CREATE POLICY "prospects_update" ON public.prospects FOR UPDATE
USING (
  is_demo_mode() OR has_any_role(auth.uid(), ARRAY['sales_counselor','sales_marketing','ad','admin']::app_role[])
);
CREATE POLICY "prospects_delete" ON public.prospects FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
-- ============================================================
-- BUILDINGS: Restrict writes
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can manage buildings" ON public.buildings;
DROP POLICY IF EXISTS "Authenticated users can view buildings" ON public.buildings;
CREATE POLICY "buildings_select" ON public.buildings FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "buildings_insert" ON public.buildings FOR INSERT
WITH CHECK (
  is_demo_mode() OR has_any_role(auth.uid(), ARRAY['regional','admin']::app_role[])
);
CREATE POLICY "buildings_update" ON public.buildings FOR UPDATE
USING (
  is_demo_mode() OR has_any_role(auth.uid(), ARRAY['ad','building_admin','regional','admin']::app_role[])
);
CREATE POLICY "buildings_delete" ON public.buildings FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
-- ============================================================
-- TOURS: Role-based access
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can manage tours" ON public.tours;
DROP POLICY IF EXISTS "Authenticated users can view tours" ON public.tours;
CREATE POLICY "tours_select" ON public.tours FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "tours_insert" ON public.tours FOR INSERT
WITH CHECK (
  is_demo_mode() OR has_any_role(auth.uid(), ARRAY['sales_counselor','sales_marketing','ad','admin']::app_role[])
);
CREATE POLICY "tours_update" ON public.tours FOR UPDATE
USING (
  is_demo_mode() OR has_any_role(auth.uid(), ARRAY['sales_counselor','sales_marketing','ad','admin']::app_role[])
);
CREATE POLICY "tours_delete" ON public.tours FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
-- ============================================================
-- CENSUS_LOGS: Role-based access
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can manage census logs" ON public.census_logs;
DROP POLICY IF EXISTS "Authenticated users can view census logs" ON public.census_logs;
CREATE POLICY "census_logs_select" ON public.census_logs FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "census_logs_insert" ON public.census_logs FOR INSERT
WITH CHECK (
  is_demo_mode() OR has_any_role(auth.uid(), ARRAY['ad','building_admin','regional','admin']::app_role[])
);
CREATE POLICY "census_logs_update" ON public.census_logs FOR UPDATE
USING (
  is_demo_mode() OR has_any_role(auth.uid(), ARRAY['ad','building_admin','regional','admin']::app_role[])
);
CREATE POLICY "census_logs_delete" ON public.census_logs FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
-- ============================================================
-- CAMPAIGNS: Marketing roles
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can manage campaigns" ON public.campaigns;
DROP POLICY IF EXISTS "Authenticated users can view campaigns" ON public.campaigns;
CREATE POLICY "campaigns_select" ON public.campaigns FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "campaigns_insert" ON public.campaigns FOR INSERT
WITH CHECK (
  is_demo_mode() OR has_any_role(auth.uid(), ARRAY['sales_marketing','admin']::app_role[])
);
CREATE POLICY "campaigns_update" ON public.campaigns FOR UPDATE
USING (
  is_demo_mode() OR has_any_role(auth.uid(), ARRAY['sales_marketing','admin']::app_role[])
);
CREATE POLICY "campaigns_delete" ON public.campaigns FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
-- ============================================================
-- WAITLIST: Role-based access
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can manage waitlist" ON public.waitlist;
DROP POLICY IF EXISTS "Authenticated users can view waitlist" ON public.waitlist;
CREATE POLICY "waitlist_select" ON public.waitlist FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "waitlist_insert" ON public.waitlist FOR INSERT
WITH CHECK (
  is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','sales_counselor','admin']::app_role[])
);
CREATE POLICY "waitlist_update" ON public.waitlist FOR UPDATE
USING (
  is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','sales_counselor','admin']::app_role[])
);
CREATE POLICY "waitlist_delete" ON public.waitlist FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
-- ============================================================
-- HOSPITAL CRM tables: Liaison & admin roles
-- ============================================================
DROP POLICY IF EXISTS "Allow all hospitals" ON public.hospitals;
DROP POLICY IF EXISTS "Allow select hospitals" ON public.hospitals;
DROP POLICY IF EXISTS "Allow all hospital_contacts" ON public.hospital_contacts;
DROP POLICY IF EXISTS "Allow select hospital_contacts" ON public.hospital_contacts;
DROP POLICY IF EXISTS "Allow all hospital_visits" ON public.hospital_visits;
DROP POLICY IF EXISTS "Allow select hospital_visits" ON public.hospital_visits;
DROP POLICY IF EXISTS "Allow all hospital_followups" ON public.hospital_followups;
DROP POLICY IF EXISTS "Allow select hospital_followups" ON public.hospital_followups;
-- hospitals
CREATE POLICY "hospitals_select" ON public.hospitals FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "hospitals_insert" ON public.hospitals FOR INSERT
WITH CHECK (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['liaison','regional','admin']::app_role[]));
CREATE POLICY "hospitals_update" ON public.hospitals FOR UPDATE
USING (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['liaison','regional','admin']::app_role[]));
CREATE POLICY "hospitals_delete" ON public.hospitals FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
-- hospital_contacts
CREATE POLICY "hospital_contacts_select" ON public.hospital_contacts FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "hospital_contacts_insert" ON public.hospital_contacts FOR INSERT
WITH CHECK (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['liaison','regional','admin']::app_role[]));
CREATE POLICY "hospital_contacts_update" ON public.hospital_contacts FOR UPDATE
USING (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['liaison','regional','admin']::app_role[]));
CREATE POLICY "hospital_contacts_delete" ON public.hospital_contacts FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
-- hospital_visits
CREATE POLICY "hospital_visits_select" ON public.hospital_visits FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "hospital_visits_insert" ON public.hospital_visits FOR INSERT
WITH CHECK (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['liaison','regional','admin']::app_role[]));
CREATE POLICY "hospital_visits_update" ON public.hospital_visits FOR UPDATE
USING (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['liaison','regional','admin']::app_role[]));
CREATE POLICY "hospital_visits_delete" ON public.hospital_visits FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
-- hospital_followups
CREATE POLICY "hospital_followups_select" ON public.hospital_followups FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "hospital_followups_insert" ON public.hospital_followups FOR INSERT
WITH CHECK (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['liaison','regional','admin']::app_role[]));
CREATE POLICY "hospital_followups_update" ON public.hospital_followups FOR UPDATE
USING (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['liaison','regional','admin']::app_role[]));
CREATE POLICY "hospital_followups_delete" ON public.hospital_followups FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
-- ============================================================
-- AUTOMATION_TEMPLATES: Admin & marketing
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can manage templates" ON public.automation_templates;
DROP POLICY IF EXISTS "Authenticated users can view templates" ON public.automation_templates;
CREATE POLICY "automation_templates_select" ON public.automation_templates FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "automation_templates_insert" ON public.automation_templates FOR INSERT
WITH CHECK (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['sales_marketing','admin']::app_role[]));
CREATE POLICY "automation_templates_update" ON public.automation_templates FOR UPDATE
USING (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['sales_marketing','admin']::app_role[]));
CREATE POLICY "automation_templates_delete" ON public.automation_templates FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
-- ============================================================
-- BUILDING_STATUSES: AD & admin roles
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can manage building statuses" ON public.building_statuses;
DROP POLICY IF EXISTS "Authenticated users can view building statuses" ON public.building_statuses;
CREATE POLICY "building_statuses_select" ON public.building_statuses FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "building_statuses_insert" ON public.building_statuses FOR INSERT
WITH CHECK (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['ad','building_admin','regional','admin']::app_role[]));
CREATE POLICY "building_statuses_update" ON public.building_statuses FOR UPDATE
USING (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['ad','building_admin','regional','admin']::app_role[]));
CREATE POLICY "building_statuses_delete" ON public.building_statuses FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
-- ============================================================
-- AUTHORIZATION sub-tables
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can manage auth docs" ON public.authorization_documents;
DROP POLICY IF EXISTS "Authenticated users can view auth docs" ON public.authorization_documents;
DROP POLICY IF EXISTS "Authenticated users can manage auth tasks" ON public.authorization_tasks;
DROP POLICY IF EXISTS "Authenticated users can view auth tasks" ON public.authorization_tasks;
CREATE POLICY "auth_docs_select" ON public.authorization_documents FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "auth_docs_insert" ON public.authorization_documents FOR INSERT
WITH CHECK (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','admin']::app_role[]));
CREATE POLICY "auth_docs_update" ON public.authorization_documents FOR UPDATE
USING (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','admin']::app_role[]));
CREATE POLICY "auth_docs_delete" ON public.authorization_documents FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
CREATE POLICY "auth_tasks_select" ON public.authorization_tasks FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "auth_tasks_insert" ON public.authorization_tasks FOR INSERT
WITH CHECK (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','admin']::app_role[]));
CREATE POLICY "auth_tasks_update" ON public.authorization_tasks FOR UPDATE
USING (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','admin']::app_role[]));
CREATE POLICY "auth_tasks_delete" ON public.authorization_tasks FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
-- ============================================================
-- REFERRAL_DOCUMENTS
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can manage referral documents" ON public.referral_documents;
CREATE POLICY "referral_docs_select" ON public.referral_documents FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "referral_docs_insert" ON public.referral_documents FOR INSERT
WITH CHECK (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','liaison','admin']::app_role[]));
CREATE POLICY "referral_docs_update" ON public.referral_documents FOR UPDATE
USING (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','liaison','admin']::app_role[]));
CREATE POLICY "referral_docs_delete" ON public.referral_documents FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
-- ============================================================
-- REFERRAL_FOLLOWUP_SEQUENCES
-- ============================================================
DROP POLICY IF EXISTS "Allow all referral_followup_sequences" ON public.referral_followup_sequences;
DROP POLICY IF EXISTS "Allow select referral_followup_sequences" ON public.referral_followup_sequences;
CREATE POLICY "followup_sequences_select" ON public.referral_followup_sequences FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "followup_sequences_insert" ON public.referral_followup_sequences FOR INSERT
WITH CHECK (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','liaison','admin']::app_role[]));
CREATE POLICY "followup_sequences_update" ON public.referral_followup_sequences FOR UPDATE
USING (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['intake','ad','liaison','admin']::app_role[]));
CREATE POLICY "followup_sequences_delete" ON public.referral_followup_sequences FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
-- ============================================================
-- HOLD_REVENUE_IMPACT
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can manage hold revenue impact" ON public.hold_revenue_impact;
DROP POLICY IF EXISTS "Authenticated users can view hold revenue impact" ON public.hold_revenue_impact;
CREATE POLICY "hold_revenue_select" ON public.hold_revenue_impact FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "hold_revenue_insert" ON public.hold_revenue_impact FOR INSERT
WITH CHECK (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['ad','regional','admin']::app_role[]));
CREATE POLICY "hold_revenue_update" ON public.hold_revenue_impact FOR UPDATE
USING (is_demo_mode() OR has_any_role(auth.uid(), ARRAY['ad','regional','admin']::app_role[]));
CREATE POLICY "hold_revenue_delete" ON public.hold_revenue_impact FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
-- ============================================================
-- DASHBOARD_WIDGET_SETTINGS: Admin only for writes
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can manage widget settings" ON public.dashboard_widget_settings;
DROP POLICY IF EXISTS "Authenticated users can view widget settings" ON public.dashboard_widget_settings;
CREATE POLICY "widget_settings_select" ON public.dashboard_widget_settings FOR SELECT
USING (is_demo_mode() OR auth.uid() IS NOT NULL);
CREATE POLICY "widget_settings_insert" ON public.dashboard_widget_settings FOR INSERT
WITH CHECK (is_demo_mode() OR has_role(auth.uid(), 'admin'));
CREATE POLICY "widget_settings_update" ON public.dashboard_widget_settings FOR UPDATE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
CREATE POLICY "widget_settings_delete" ON public.dashboard_widget_settings FOR DELETE
USING (is_demo_mode() OR has_role(auth.uid(), 'admin'));
