-- Create storage bucket for referral documents
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'referral-documents',
  'referral-documents',
  false,
  20971520,
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
);
-- RLS: allow authenticated users to upload
CREATE POLICY "Authenticated users can upload referral documents"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'referral-documents');
-- RLS: allow authenticated users to view referral documents
CREATE POLICY "Authenticated users can view referral documents"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'referral-documents');
-- RLS: allow authenticated users to delete referral documents
CREATE POLICY "Authenticated users can delete referral documents"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'referral-documents');
-- Table to track uploaded document metadata per referral
CREATE TABLE public.referral_documents (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  referral_id TEXT NOT NULL,
  document_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER,
  uploaded_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
ALTER TABLE public.referral_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can manage referral documents"
ON public.referral_documents FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);
