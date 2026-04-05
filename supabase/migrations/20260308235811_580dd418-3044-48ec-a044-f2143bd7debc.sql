-- Seed hospitals from NexusCare-Liaison
INSERT INTO public.hospitals (name, address, city, state, system, total_beds)
VALUES 
  ('Novant Health Presbyterian Medical Center', '200 Hawthorne Ln', 'Charlotte', 'NC', 'Novant Health', 697),
  ('Novant Health Huntersville Medical Center', '10030 Gilead Rd', 'Huntersville', 'NC', 'Novant Health', 91),
  ('Atrium Health Pineville', '10628 Park Rd', 'Charlotte', 'NC', 'Atrium Health', 235),
  ('Carolinas Medical Center', '1000 Blythe Blvd', 'Charlotte', 'NC', 'Atrium Health', 874)
ON CONFLICT DO NOTHING;
-- Seed hospital contacts from NexusCare-Liaison
INSERT INTO public.hospital_contacts (name, title, hospital_name, unit_floor, phone, email, relationship_score, referrals_sent, referrals_won, last_contact_date, last_contact_type, preferred_contact, notes)
VALUES
  ('Karen Williams', 'Case Manager', 'Novant Health Presbyterian Medical Center', '3rd Floor — Orthopedics', '(704) 555-0112', 'kwilliams@novant.org', 88, 18, 14, CURRENT_DATE - 1, 'visit', 'phone', 'Prefers morning visits. Key decision-maker for ortho referrals.'),
  ('Angela Torres', 'Discharge Planner', 'Novant Health Presbyterian Medical Center', '2nd Floor — Med-Surg', '(704) 555-0198', 'atorres@novant.org', 82, 9, 7, CURRENT_DATE - 4, 'visit', 'phone', 'Works closely with Dr. Santos. Great rapport.'),
  ('Dr. Michael Santos', 'Discharge Planner', 'Novant Health Presbyterian Medical Center', '5th Floor — Neurology', '(704) 555-0234', 'msantos@novant.org', 75, 12, 9, CURRENT_DATE - 7, 'call', 'phone', 'Interested in our memory care capabilities.'),
  ('James Liu', 'Social Worker', 'Novant Health Presbyterian Medical Center', '4th Floor — General Medicine', '(704) 555-0167', 'jliu@novant.org', 42, 5, 2, CURRENT_DATE - 21, 'visit', 'phone', ''),
  ('Patricia Moore', 'Case Manager', 'Novant Health Huntersville Medical Center', '2nd Floor — General Medicine', '(704) 555-0289', 'pmoore@huntersville.org', 55, 8, 5, CURRENT_DATE - 7, 'call', 'phone', 'Covers weekday shifts only.')
ON CONFLICT DO NOTHING;
-- Seed referrals from NexusCare-Liaison
INSERT INTO public.referrals (patient_name, diagnosis, care_level, admitting_hospital, pay_method, insurance, status, urgent, source, notes)
VALUES
  ('Margaret Thompson', 'Hip Fracture Recovery', 'Skilled Nursing', 'Novant Health Presbyterian', 'Medicare A', 'Medicare', 'accepted', false, 'Hospital Liaison', 'Family prefers morning transfer. Daughter will meet at facility.'),
  ('James Morrison', 'Stroke Recovery', 'Skilled Nursing', 'Novant Health Presbyterian', 'Medicare A', 'Medicare', 'accepted', false, 'Hospital Liaison', ''),
  ('Margaret R. Wilson', 'Post-surgical recovery', 'Skilled Nursing', 'Atrium Health Pineville', 'Medicare A', 'Medicare', 'incoming', true, 'Hospital Liaison', ''),
  ('Robert T. Johnson', 'Alzheimer''s progression', 'Memory Care', 'Novant Health Presbyterian', 'Private Pay', 'Private Pay', 'accepted', false, 'Hospital Liaison', 'Son has POA, requesting private room.'),
  ('Dorothy E. Parker', 'Pneumonia Recovery', 'Assisted Living', 'Carolinas Medical Center', 'Private Pay', 'Private Pay', 'incoming', false, 'Hospital Liaison', ''),
  ('Eleanor Davis', 'Pneumonia Recovery', 'Assisted Living', 'Novant Health Presbyterian', 'LTC Insurance', 'LTC Insurance', 'accepted', false, 'Hospital Liaison', ''),
  ('William Carter', 'Fall w/ TBI', 'Memory Care', 'Novant Health Presbyterian', 'Medicaid', 'Medicaid', 'admitted', false, 'Hospital Liaison', '')
ON CONFLICT DO NOTHING;
-- Seed hospital visits from NexusCare-Liaison  
INSERT INTO public.hospital_visits (hospital_name, contact_name, visit_date, visit_type, notes)
VALUES
  ('Novant Health Presbyterian Medical Center', 'Karen Williams', CURRENT_DATE, 'visit', 'Discussed Margaret Thompson referral. Karen confirmed discharge timeline.'),
  ('Novant Health Presbyterian Medical Center', 'Angela Torres', CURRENT_DATE - 1, 'visit', 'Followed up on Eleanor Davis transfer. Angela arranging transport.'),
  ('Novant Health Huntersville Medical Center', 'Patricia Moore', CURRENT_DATE - 4, 'visit', 'Introductory visit. Discussed our memory care capabilities.'),
  ('Novant Health Presbyterian Medical Center', 'Dr. Michael Santos', CURRENT_DATE - 5, 'visit', 'Called to discuss neuro patient pipeline. 2 potential referrals next week.')
ON CONFLICT DO NOTHING;
