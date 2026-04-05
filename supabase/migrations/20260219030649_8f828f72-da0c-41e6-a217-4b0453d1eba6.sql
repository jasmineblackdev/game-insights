-- Daily census log table for real-time bed availability tracking
CREATE TABLE public.census_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  building_id UUID NOT NULL,
  building_name TEXT NOT NULL DEFAULT '',
  census_date DATE NOT NULL DEFAULT CURRENT_DATE,
  total_beds INTEGER NOT NULL DEFAULT 0,
  occupied_beds INTEGER NOT NULL DEFAULT 0,
  available_beds INTEGER GENERATED ALWAYS AS (total_beds - occupied_beds) STORED,
  pending_admissions INTEGER NOT NULL DEFAULT 0,
  pending_discharges INTEGER NOT NULL DEFAULT 0,
  holds INTEGER NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  updated_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (building_id, census_date)
);
-- Enable RLS
ALTER TABLE public.census_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view census logs"
  ON public.census_logs FOR SELECT
  USING (true);
CREATE POLICY "Authenticated users can manage census logs"
  ON public.census_logs FOR ALL
  USING (true)
  WITH CHECK (true);
-- Auto-update updated_at
CREATE TRIGGER update_census_logs_updated_at
  BEFORE UPDATE ON public.census_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();
-- Seed today's census from existing buildings data
INSERT INTO public.census_logs (building_id, building_name, census_date, total_beds, occupied_beds, pending_admissions, pending_discharges, holds)
SELECT
  id,
  name,
  CURRENT_DATE,
  total_beds,
  occupied_beds,
  CASE WHEN name = 'Ballantyne Commons' THEN 3
       WHEN name = 'Lake Norman Village' THEN 1
       WHEN name = 'Southpark Gardens' THEN 5
       WHEN name = 'Huntersville Health' THEN 0
       WHEN name = 'Matthews Care Center' THEN 2
       ELSE 0 END AS pending_admissions,
  CASE WHEN name = 'Ballantyne Commons' THEN 2
       WHEN name = 'Lake Norman Village' THEN 1
       WHEN name = 'Southpark Gardens' THEN 3
       WHEN name = 'Huntersville Health' THEN 0
       WHEN name = 'Matthews Care Center' THEN 1
       ELSE 0 END AS pending_discharges,
  CASE WHEN name = 'Huntersville Health' THEN 2
       ELSE 0 END AS holds
FROM public.buildings
WHERE is_active = true
ON CONFLICT (building_id, census_date) DO NOTHING;
