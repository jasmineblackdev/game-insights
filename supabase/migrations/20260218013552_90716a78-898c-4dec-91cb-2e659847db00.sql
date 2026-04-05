-- =============================================
-- NexusCare Full Platform Schema
-- =============================================

-- App roles enum
CREATE TYPE public.app_role AS ENUM (
  'intake', 'ad', 'liaison', 'regional', 'building_admin',
  'sales_marketing', 'sales_counselor', 'executive_director', 'admin'
);
-- User roles table (separate from profiles per security guidelines)
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role app_role NOT NULL,
  UNIQUE(user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
-- Security definer function to check roles
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role
  )
$$;
-- Profiles table
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL DEFAULT '',
  email TEXT,
  role_label TEXT NOT NULL DEFAULT 'Intake Coordinator',
  building TEXT NOT NULL DEFAULT 'All',
  avatar_initials TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view all profiles" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
-- Allow admins to manage all profiles
CREATE POLICY "Admins can manage all profiles" ON public.profiles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));
-- Trigger to auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE PLPGSQL
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', ''))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
-- Buildings table
CREATE TABLE public.buildings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Assisted Living',
  address TEXT DEFAULT '',
  city TEXT DEFAULT '',
  state TEXT DEFAULT '',
  total_beds INTEGER NOT NULL DEFAULT 0,
  occupied_beds INTEGER NOT NULL DEFAULT 0,
  ad_name TEXT DEFAULT '',
  certifications TEXT[] DEFAULT '{}',
  care_types TEXT[] DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.buildings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view buildings" ON public.buildings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can manage buildings" ON public.buildings FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- Referrals table
CREATE TABLE public.referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_number TEXT NOT NULL DEFAULT '',
  patient_name TEXT NOT NULL,
  dob DATE,
  diagnosis TEXT DEFAULT '',
  care_level TEXT DEFAULT '',
  pay_method TEXT DEFAULT '',
  insurance TEXT DEFAULT '',
  admitting_hospital TEXT DEFAULT '',
  source TEXT DEFAULT 'Manual',
  status TEXT NOT NULL DEFAULT 'incoming',
  urgent BOOLEAN NOT NULL DEFAULT false,
  notes TEXT DEFAULT '',
  created_by UUID REFERENCES auth.users(id),
  building_id UUID REFERENCES public.buildings(id),
  insurance_payer_id UUID,
  estimated_monthly_rate DECIMAL(10,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view referrals" ON public.referrals FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can manage referrals" ON public.referrals FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- Prospects table
CREATE TABLE public.prospects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  age_range TEXT DEFAULT '',
  care_type TEXT DEFAULT '',
  source TEXT DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'New Inquiry',
  priority TEXT NOT NULL DEFAULT 'medium',
  counselor_name TEXT DEFAULT '',
  next_follow_up DATE,
  notes TEXT DEFAULT '',
  building_id UUID REFERENCES public.buildings(id),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.prospects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view prospects" ON public.prospects FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can manage prospects" ON public.prospects FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- Waitlist table
CREATE TABLE public.waitlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  care_type TEXT NOT NULL DEFAULT 'Assisted Living',
  building_id UUID REFERENCES public.buildings(id),
  building_name TEXT DEFAULT '',
  date_added DATE NOT NULL DEFAULT CURRENT_DATE,
  priority TEXT NOT NULL DEFAULT 'normal',
  source TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'waiting',
  notes TEXT DEFAULT '',
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view waitlist" ON public.waitlist FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can manage waitlist" ON public.waitlist FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- Email/SMS Templates table
CREATE TABLE public.automation_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  subject TEXT DEFAULT '',
  body TEXT DEFAULT '',
  type TEXT NOT NULL DEFAULT 'email',
  category TEXT NOT NULL DEFAULT 'inquiry',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.automation_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view templates" ON public.automation_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can manage templates" ON public.automation_templates FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- Marketing Campaigns table
CREATE TABLE public.campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'email',
  status TEXT NOT NULL DEFAULT 'draft',
  target_audience TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  body TEXT DEFAULT '',
  sent_count INTEGER DEFAULT 0,
  open_count INTEGER DEFAULT 0,
  click_count INTEGER DEFAULT 0,
  scheduled_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view campaigns" ON public.campaigns FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can manage campaigns" ON public.campaigns FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- Tours table
CREATE TABLE public.tours (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_name TEXT NOT NULL,
  prospect_id UUID REFERENCES public.prospects(id),
  building_id UUID REFERENCES public.buildings(id),
  building_name TEXT DEFAULT '',
  tour_date DATE NOT NULL,
  tour_time TEXT NOT NULL DEFAULT '10:00 AM',
  tour_type TEXT NOT NULL DEFAULT 'in-person',
  counselor_name TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT DEFAULT '',
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.tours ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view tours" ON public.tours FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can manage tours" ON public.tours FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- Dashboard Widget Visibility Settings (admin-controlled per role)
CREATE TABLE public.dashboard_widget_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role TEXT NOT NULL,
  widget_key TEXT NOT NULL,
  widget_label TEXT NOT NULL DEFAULT '',
  is_visible BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(role, widget_key)
);
ALTER TABLE public.dashboard_widget_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view widget settings" ON public.dashboard_widget_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can manage widget settings" ON public.dashboard_widget_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- Seed default widget settings per role
INSERT INTO public.dashboard_widget_settings (role, widget_key, widget_label, is_visible, sort_order) VALUES
  -- Intake
  ('intake', 'stat_incoming', 'Incoming Today Stat', true, 1),
  ('intake', 'stat_pending', 'Pending Response Stat', true, 2),
  ('intake', 'stat_accepted', 'Accepted This Week Stat', true, 3),
  ('intake', 'stat_lost', 'Lost to No Bed Stat', true, 4),
  ('intake', 'review_responses', 'Review Responses Panel', true, 5),
  ('intake', 'referral_list', 'Today''s Referrals', true, 6),
  ('intake', 'building_availability', 'Building Availability', true, 7),
  ('intake', 'ai_suggestions', 'AI Suggestions', true, 8),
  -- AD
  ('ad', 'stat_occupancy', 'Occupancy Stat', true, 1),
  ('ad', 'stat_referrals', 'Active Referrals Stat', true, 2),
  ('ad', 'stat_tours', 'Tours This Week Stat', true, 3),
  ('ad', 'stat_conversion', 'Conversion Rate Stat', true, 4),
  ('ad', 'referral_list', 'My Referrals', true, 5),
  -- Liaison
  ('liaison', 'referral_list', 'Accepted Referrals', true, 1),
  ('liaison', 'hospital_contacts', 'Hospital Contacts', true, 2),
  ('liaison', 'activity_log', 'Activity Log', true, 3),
  -- Regional
  ('regional', 'stat_portfolio', 'Portfolio Overview Stats', true, 1),
  ('regional', 'building_performance', 'Building Performance', true, 2),
  ('regional', 'payer_mix', 'Payer Mix Widget', true, 3),
  ('regional', 'team_performance', 'Team Performance', true, 4),
  -- Executive Director
  ('executive_director', 'stat_occupancy', 'Occupancy Stat', true, 1),
  ('executive_director', 'stat_revenue', 'Revenue Stat', true, 2),
  ('executive_director', 'stat_referrals', 'Active Referrals Stat', true, 3),
  ('executive_director', 'stat_issues', 'Open Issues Stat', true, 4),
  ('executive_director', 'building_overview', 'Building Overview', true, 5),
  ('executive_director', 'recent_activity', 'Recent Activity', true, 6),
  ('executive_director', 'staff_performance', 'Staff Performance', true, 7),
  -- Sales Marketing
  ('sales_marketing', 'stat_leads', 'Total Leads Stat', true, 1),
  ('sales_marketing', 'stat_conversion', 'Conversion Rate Stat', true, 2),
  ('sales_marketing', 'stat_inquiries', 'Website Inquiries Stat', true, 3),
  ('sales_marketing', 'stat_email', 'Email Open Rate Stat', true, 4),
  ('sales_marketing', 'lead_sources', 'Lead Sources Chart', true, 5),
  ('sales_marketing', 'active_campaigns', 'Active Campaigns', true, 6),
  ('sales_marketing', 'counselor_performance', 'Counselor Performance', true, 7),
  -- Sales Counselor
  ('sales_counselor', 'stat_tours', 'Tours This Month Stat', true, 1),
  ('sales_counselor', 'stat_prospects', 'Active Prospects Stat', true, 2),
  ('sales_counselor', 'stat_conversion', 'Conversion Rate Stat', true, 3),
  ('sales_counselor', 'today_schedule', 'Today''s Schedule', true, 4),
  ('sales_counselor', 'hot_prospects', 'Hot Prospects', true, 5),
  -- Building Admin
  ('building_admin', 'stat_occupancy', 'Occupancy Stat', true, 1),
  ('building_admin', 'stat_staff', 'Staff on Duty Stat', true, 2),
  ('building_admin', 'stat_incidents', 'Incidents Stat', true, 3),
  ('building_admin', 'stat_maintenance', 'Maintenance Stat', true, 4),
  ('building_admin', 'clinical_alerts', 'Clinical Alerts', true, 5),
  ('building_admin', 'bed_status', 'Bed Status Board', true, 6);
-- Notifications/Alerts table
CREATE TABLE public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'info',
  is_read BOOLEAN NOT NULL DEFAULT false,
  link TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own notifications" ON public.notifications FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can manage own notifications" ON public.notifications FOR ALL TO authenticated USING (auth.uid() = user_id);
-- Trigger for updated_at timestamps
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER
LANGUAGE PLPGSQL
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER buildings_updated_at BEFORE UPDATE ON public.buildings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER referrals_updated_at BEFORE UPDATE ON public.referrals FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER prospects_updated_at BEFORE UPDATE ON public.prospects FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER waitlist_updated_at BEFORE UPDATE ON public.waitlist FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER tours_updated_at BEFORE UPDATE ON public.tours FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER campaigns_updated_at BEFORE UPDATE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER automation_templates_updated_at BEFORE UPDATE ON public.automation_templates FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
