-- ============================================================
-- Multi-tenant RLS: scope buildings, referrals, prospects,
-- and waitlist to organization_id
--
-- The organization_id column was added to these tables in
-- migration 20260309035112 but RLS policies were never updated
-- to use it. This migration fixes that gap.
-- ============================================================

-- ============================================================
-- Trigger function: auto-set organization_id on INSERT
-- so the frontend never needs to pass it explicitly
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_organization_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := get_user_org_id(auth.uid());
  END IF;
  RETURN NEW;
END;
$$;
-- Attach trigger to all org-scoped tables
CREATE TRIGGER set_building_org_id
  BEFORE INSERT ON public.buildings
  FOR EACH ROW EXECUTE FUNCTION set_organization_id();
CREATE TRIGGER set_referral_org_id
  BEFORE INSERT ON public.referrals
  FOR EACH ROW EXECUTE FUNCTION set_organization_id();
CREATE TRIGGER set_prospect_org_id
  BEFORE INSERT ON public.prospects
  FOR EACH ROW EXECUTE FUNCTION set_organization_id();
CREATE TRIGGER set_waitlist_org_id
  BEFORE INSERT ON public.waitlist
  FOR EACH ROW EXECUTE FUNCTION set_organization_id();
-- ============================================================
-- BUILDINGS: scope to organization
-- ============================================================
DROP POLICY IF EXISTS "buildings_select" ON public.buildings;
DROP POLICY IF EXISTS "buildings_insert" ON public.buildings;
DROP POLICY IF EXISTS "buildings_update" ON public.buildings;
DROP POLICY IF EXISTS "buildings_delete" ON public.buildings;
-- SELECT: demo mode OR member of the building's org
CREATE POLICY "buildings_select" ON public.buildings FOR SELECT
USING (
  is_demo_mode() OR (
    organization_id IS NOT NULL AND
    user_belongs_to_org(auth.uid(), organization_id)
  )
);
-- INSERT: regional/admin only, org set automatically by trigger
CREATE POLICY "buildings_insert" ON public.buildings FOR INSERT
WITH CHECK (
  is_demo_mode() OR
  has_any_role(auth.uid(), ARRAY['regional','admin']::app_role[])
);
-- UPDATE: ad/building_admin/regional/admin, same org
CREATE POLICY "buildings_update" ON public.buildings FOR UPDATE
USING (
  is_demo_mode() OR (
    organization_id IS NOT NULL AND
    user_belongs_to_org(auth.uid(), organization_id) AND
    has_any_role(auth.uid(), ARRAY['ad','building_admin','regional','admin']::app_role[])
  )
);
-- DELETE: admin only, same org
CREATE POLICY "buildings_delete" ON public.buildings FOR DELETE
USING (
  is_demo_mode() OR (
    organization_id IS NOT NULL AND
    user_belongs_to_org(auth.uid(), organization_id) AND
    has_role(auth.uid(), 'admin'::app_role)
  )
);
-- ============================================================
-- REFERRALS: scope to organization
-- ============================================================
DROP POLICY IF EXISTS "referrals_select" ON public.referrals;
DROP POLICY IF EXISTS "referrals_insert" ON public.referrals;
DROP POLICY IF EXISTS "referrals_update" ON public.referrals;
DROP POLICY IF EXISTS "referrals_delete" ON public.referrals;
CREATE POLICY "referrals_select" ON public.referrals FOR SELECT
USING (
  is_demo_mode() OR (
    organization_id IS NOT NULL AND
    user_belongs_to_org(auth.uid(), organization_id)
  )
);
CREATE POLICY "referrals_insert" ON public.referrals FOR INSERT
WITH CHECK (
  is_demo_mode() OR
  has_any_role(auth.uid(), ARRAY['intake','ad','liaison','admin']::app_role[])
);
CREATE POLICY "referrals_update" ON public.referrals FOR UPDATE
USING (
  is_demo_mode() OR (
    organization_id IS NOT NULL AND
    user_belongs_to_org(auth.uid(), organization_id) AND
    has_any_role(auth.uid(), ARRAY['intake','ad','liaison','regional','admin']::app_role[])
  )
);
CREATE POLICY "referrals_delete" ON public.referrals FOR DELETE
USING (
  is_demo_mode() OR (
    organization_id IS NOT NULL AND
    user_belongs_to_org(auth.uid(), organization_id) AND
    has_role(auth.uid(), 'admin'::app_role)
  )
);
-- ============================================================
-- PROSPECTS: scope to organization
-- ============================================================
DROP POLICY IF EXISTS "prospects_select" ON public.prospects;
DROP POLICY IF EXISTS "prospects_insert" ON public.prospects;
DROP POLICY IF EXISTS "prospects_update" ON public.prospects;
DROP POLICY IF EXISTS "prospects_delete" ON public.prospects;
CREATE POLICY "prospects_select" ON public.prospects FOR SELECT
USING (
  is_demo_mode() OR (
    organization_id IS NOT NULL AND
    user_belongs_to_org(auth.uid(), organization_id)
  )
);
CREATE POLICY "prospects_insert" ON public.prospects FOR INSERT
WITH CHECK (
  is_demo_mode() OR
  has_any_role(auth.uid(), ARRAY['sales_counselor','sales_marketing','ad','admin']::app_role[])
);
CREATE POLICY "prospects_update" ON public.prospects FOR UPDATE
USING (
  is_demo_mode() OR (
    organization_id IS NOT NULL AND
    user_belongs_to_org(auth.uid(), organization_id) AND
    has_any_role(auth.uid(), ARRAY['sales_counselor','sales_marketing','ad','admin']::app_role[])
  )
);
CREATE POLICY "prospects_delete" ON public.prospects FOR DELETE
USING (
  is_demo_mode() OR (
    organization_id IS NOT NULL AND
    user_belongs_to_org(auth.uid(), organization_id) AND
    has_role(auth.uid(), 'admin'::app_role)
  )
);
-- ============================================================
-- WAITLIST: scope to organization
-- ============================================================
DROP POLICY IF EXISTS "waitlist_select" ON public.waitlist;
DROP POLICY IF EXISTS "waitlist_insert" ON public.waitlist;
DROP POLICY IF EXISTS "waitlist_update" ON public.waitlist;
DROP POLICY IF EXISTS "waitlist_delete" ON public.waitlist;
CREATE POLICY "waitlist_select" ON public.waitlist FOR SELECT
USING (
  is_demo_mode() OR (
    organization_id IS NOT NULL AND
    user_belongs_to_org(auth.uid(), organization_id)
  )
);
CREATE POLICY "waitlist_insert" ON public.waitlist FOR INSERT
WITH CHECK (
  is_demo_mode() OR
  has_any_role(auth.uid(), ARRAY['intake','ad','sales_counselor','admin']::app_role[])
);
CREATE POLICY "waitlist_update" ON public.waitlist FOR UPDATE
USING (
  is_demo_mode() OR (
    organization_id IS NOT NULL AND
    user_belongs_to_org(auth.uid(), organization_id) AND
    has_any_role(auth.uid(), ARRAY['intake','ad','sales_counselor','admin']::app_role[])
  )
);
CREATE POLICY "waitlist_delete" ON public.waitlist FOR DELETE
USING (
  is_demo_mode() OR (
    organization_id IS NOT NULL AND
    user_belongs_to_org(auth.uid(), organization_id) AND
    has_role(auth.uid(), 'admin'::app_role)
  )
);
-- ============================================================
-- Note: Existing rows with organization_id = NULL (test/seed
-- data) will no longer be visible to authenticated users after
-- this migration. This is intentional — they were not scoped
-- to any organization and should not be accessible.
-- ============================================================;
