-- 1. Organizations table (multi-tenancy anchor)
CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  logo_url text DEFAULT '',
  billing_email text DEFAULT '',
  stripe_customer_id text DEFAULT '',
  stripe_subscription_id text DEFAULT '',
  subscription_status text NOT NULL DEFAULT 'trialing',
  pricing_tier text NOT NULL DEFAULT 'bronze',
  max_buildings integer NOT NULL DEFAULT 1,
  trial_ends_at timestamptz DEFAULT (now() + interval '14 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
-- 2. Organization members junction table
CREATE TABLE public.organization_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL DEFAULT 'intake',
  invited_by uuid REFERENCES auth.users(id),
  invited_at timestamptz DEFAULT now(),
  accepted_at timestamptz,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id, user_id)
);
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
-- 3. Add organization_id to key tables
ALTER TABLE public.buildings ADD COLUMN organization_id uuid REFERENCES public.organizations(id);
ALTER TABLE public.referrals ADD COLUMN organization_id uuid REFERENCES public.organizations(id);
ALTER TABLE public.prospects ADD COLUMN organization_id uuid REFERENCES public.organizations(id);
ALTER TABLE public.waitlist ADD COLUMN organization_id uuid REFERENCES public.organizations(id);
ALTER TABLE public.profiles ADD COLUMN organization_id uuid REFERENCES public.organizations(id);
-- 4. Helper: get user's org id
CREATE OR REPLACE FUNCTION public.get_user_org_id(_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT organization_id FROM public.organization_members
  WHERE user_id = _user_id AND status = 'active'
  LIMIT 1
$$;
-- 5. Helper: check user belongs to org
CREATE OR REPLACE FUNCTION public.user_belongs_to_org(_user_id uuid, _org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE user_id = _user_id AND organization_id = _org_id AND status = 'active'
  )
$$;
-- 6. RLS for organizations
CREATE POLICY "org_select" ON public.organizations FOR SELECT
  USING (is_demo_mode() OR user_belongs_to_org(auth.uid(), id));
CREATE POLICY "org_update" ON public.organizations FOR UPDATE
  USING (is_demo_mode() OR (
    user_belongs_to_org(auth.uid(), id) AND has_any_role(auth.uid(), ARRAY['admin','regional']::app_role[])
  ));
CREATE POLICY "org_insert" ON public.organizations FOR INSERT
  WITH CHECK (is_demo_mode() OR auth.uid() IS NOT NULL);
-- 7. RLS for organization_members
CREATE POLICY "org_members_select" ON public.organization_members FOR SELECT
  USING (is_demo_mode() OR user_belongs_to_org(auth.uid(), organization_id));
CREATE POLICY "org_members_insert" ON public.organization_members FOR INSERT
  WITH CHECK (is_demo_mode() OR (
    user_belongs_to_org(auth.uid(), organization_id)
    AND has_any_role(auth.uid(), ARRAY['admin','regional']::app_role[])
  ));
CREATE POLICY "org_members_update" ON public.organization_members FOR UPDATE
  USING (is_demo_mode() OR (
    user_belongs_to_org(auth.uid(), organization_id)
    AND has_any_role(auth.uid(), ARRAY['admin','regional']::app_role[])
  ));
CREATE POLICY "org_members_delete" ON public.organization_members FOR DELETE
  USING (is_demo_mode() OR (
    user_belongs_to_org(auth.uid(), organization_id)
    AND has_role(auth.uid(), 'admin'::app_role)
  ));
-- 8. Auto-create org on signup trigger
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_org_id uuid;
  org_name text;
BEGIN
  -- Create profile
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', ''))
  ON CONFLICT (id) DO NOTHING;

  -- Auto-create organization for new user
  org_name := COALESCE(NEW.raw_user_meta_data->>'company_name', split_part(NEW.email, '@', 2));
  
  INSERT INTO public.organizations (name, slug, billing_email)
  VALUES (org_name, replace(gen_random_uuid()::text, '-', ''), NEW.email)
  RETURNING id INTO new_org_id;

  -- Add user as admin of their org
  INSERT INTO public.organization_members (organization_id, user_id, role, status, accepted_at)
  VALUES (new_org_id, NEW.id, 'admin', 'active', now());

  -- Link profile to org
  UPDATE public.profiles SET organization_id = new_org_id WHERE id = NEW.id;

  -- Add admin role
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'admin')
  ON CONFLICT (user_id, role) DO NOTHING;

  RETURN NEW;
END;
$$;
-- 9. Updated_at trigger for organizations
CREATE TRIGGER update_organizations_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
