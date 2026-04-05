-- Lost referral analysis logs — persists every decline/loss reason for analytics
CREATE TABLE public.referral_loss_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  referral_id TEXT NOT NULL,
  patient_name TEXT NOT NULL DEFAULT '',
  building_id UUID,
  building_name TEXT NOT NULL DEFAULT '',
  care_level TEXT NOT NULL DEFAULT '',
  pay_method TEXT NOT NULL DEFAULT '',
  insurance TEXT NOT NULL DEFAULT '',
  loss_type TEXT NOT NULL DEFAULT 'declined', -- 'declined' | 'lost'
  loss_category TEXT NOT NULL DEFAULT 'Other', -- 'Clinical' | 'Financial' | 'Capacity' | 'External' | 'Other'
  loss_reason TEXT NOT NULL DEFAULT 'other',
  loss_reason_label TEXT NOT NULL DEFAULT '',
  loss_note TEXT DEFAULT '',
  sla_breached BOOLEAN NOT NULL DEFAULT false,
  responded_within_minutes INTEGER,
  logged_by UUID,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.referral_loss_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can view loss logs"
  ON public.referral_loss_logs FOR SELECT
  USING (true);
CREATE POLICY "Authenticated users can insert loss logs"
  ON public.referral_loss_logs FOR INSERT
  WITH CHECK (true);
-- Seed historical loss data for the dashboard to be meaningful
INSERT INTO public.referral_loss_logs 
  (referral_id, patient_name, building_name, care_level, pay_method, insurance, loss_type, loss_category, loss_reason, loss_reason_label, responded_within_minutes, created_at)
VALUES
  -- Clinical declines
  ('REF-H001','Alice Foster','Huntersville Health','Skilled Nursing','Medicare','UnitedHealthcare','declined','Clinical','wrong-loc','Wrong level of care for our facility',18,'2026-01-15 09:00:00+00'),
  ('REF-B002','George Barnes','Ballantyne Commons','Memory Care','Private Pay','Aetna LTC','declined','Clinical','behavioral','Behavioral concerns',22,'2026-01-18 14:00:00+00'),
  ('REF-L003','Harriet Wells','Lake Norman Village','Memory Care','Medicare','Blue Cross','declined','Clinical','medical-complexity','Medical complexity beyond our capability',45,'2026-01-22 11:00:00+00'),
  ('REF-M004','Frank Morris','Matthews Care Center','Assisted Living','Medicaid','NC Medicaid','declined','Clinical','wrong-loc','Wrong level of care for our facility',12,'2026-02-03 09:30:00+00'),
  ('REF-S005','Carol Reed','Southpark Gardens','Independent Living','Private Pay','Self Pay','declined','Clinical','behavioral','Behavioral concerns',67,'2026-02-08 16:00:00+00'),
  -- Financial declines  
  ('REF-H006','James Lowe','Huntersville Health','Skilled Nursing','Medicaid','NC Medicaid','declined','Financial','insurance-denied','Insurance denied / no coverage',15,'2026-01-14 10:00:00+00'),
  ('REF-B007','Patricia Scott','Ballantyne Commons','Assisted Living','Medicaid','NC Medicaid','declined','Financial','insurance-denied','Insurance denied / no coverage',28,'2026-01-20 13:00:00+00'),
  ('REF-L008','Samuel Grant','Lake Norman Village','Memory Care','Private Pay','Self Pay','declined','Financial','cannot-afford','Patient cannot afford private pay rate',33,'2026-01-25 15:00:00+00'),
  ('REF-M009','Dorothy Clarke','Matthews Care Center','Assisted Living','Medicaid','NC Medicaid','declined','Financial','rate-too-low','Rate too low / reimbursement issue',19,'2026-02-01 08:45:00+00'),
  ('REF-S010','Henry Bishop','Southpark Gardens','Independent Living','LTC Insurance','Genworth','declined','Financial','insurance-denied','Insurance denied / no coverage',41,'2026-02-10 11:30:00+00'),
  -- Capacity declines
  ('REF-H011','Ruth Simmons','Huntersville Health','Skilled Nursing','Medicare','Humana Gold Plus','declined','Capacity','no-bed','No bed available at this time',8,'2026-01-12 08:00:00+00'),
  ('REF-H012','Carl Dixon','Huntersville Health','Skilled Nursing','Medicare','UnitedHealthcare','declined','Capacity','no-bed','No bed available at this time',6,'2026-01-19 09:00:00+00'),
  ('REF-H013','Edna Palmer','Huntersville Health','Skilled Nursing','Medicare','Aetna','declined','Capacity','no-bed-care-type','No bed available in required care type',11,'2026-01-28 10:30:00+00'),
  ('REF-H014','Louis Bryant','Huntersville Health','Skilled Nursing','Medicare','Humana','declined','Capacity','admission-hold','Temporary admission hold',9,'2026-02-05 08:00:00+00'),
  ('REF-B015','Marie Collins','Ballantyne Commons','Assisted Living','Private Pay','Self Pay','declined','Capacity','no-bed','No bed available at this time',14,'2026-02-12 14:00:00+00'),
  -- External / Lost
  ('REF-B016','Walter Pierce','Ballantyne Commons','Assisted Living','Private Pay','LTC Insurance','lost','External','chose-competitor','Chose competitor facility',55,'2026-01-10 11:00:00+00'),
  ('REF-L017','Grace Hughes','Lake Norman Village','Memory Care','Private Pay','Self Pay','lost','External','chose-competitor','Chose competitor facility',72,'2026-01-16 15:00:00+00'),
  ('REF-S018','Arthur Flynn','Southpark Gardens','Assisted Living','Medicare','BCBS','lost','External','chose-home','Chose to stay home with family',38,'2026-01-21 13:00:00+00'),
  ('REF-M019','Vera Stone','Matthews Care Center','Assisted Living','Private Pay','Self Pay','lost','External','chose-competitor','Chose competitor facility',88,'2026-01-26 16:00:00+00'),
  ('REF-B020','Clarence Webb','Ballantyne Commons','Memory Care','LTC Insurance','Genworth','lost','External','chose-competitor','Chose competitor facility',62,'2026-01-30 10:00:00+00'),
  ('REF-L021','Beatrice Ford','Lake Norman Village','Memory Care','Private Pay','Self Pay','lost','External','deceased','Patient deceased',24,'2026-02-04 09:00:00+00'),
  ('REF-S022','Harold Ward','Southpark Gardens','Independent Living','Private Pay','Self Pay','lost','External','chose-competitor','Chose competitor facility',91,'2026-02-07 14:30:00+00'),
  ('REF-M023','Mildred Cox','Matthews Care Center','Assisted Living','Medicaid','NC Medicaid','lost','External','cancelled','Referral cancelled by hospital/family',31,'2026-02-11 12:00:00+00'),
  -- More February data for trend
  ('REF-B024','Gerald Ross','Ballantyne Commons','Assisted Living','Medicare','UnitedHealthcare','declined','Clinical','wrong-loc','Wrong level of care for our facility',16,'2026-02-14 09:00:00+00'),
  ('REF-H025','Irene Bell','Huntersville Health','Skilled Nursing','Medicare','Humana','declined','Capacity','no-bed','No bed available at this time',7,'2026-02-16 08:30:00+00'),
  ('REF-L026','Eugene Murphy','Lake Norman Village','Memory Care','Private Pay','Aetna LTC','lost','External','chose-competitor','Chose competitor facility',78,'2026-02-17 15:00:00+00'),
  ('REF-S027','Agnes Rivera','Southpark Gardens','Assisted Living','Medicaid','NC Medicaid','declined','Financial','insurance-denied','Insurance denied / no coverage',22,'2026-02-18 11:00:00+00');
