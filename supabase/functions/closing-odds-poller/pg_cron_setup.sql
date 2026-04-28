-- ============================================================
-- pg_cron setup for the closing-odds-poller edge function.
--
-- Run this ONCE from the Supabase SQL editor (Database → SQL Editor).
-- Requires the `pg_cron` and `pg_net` extensions to be enabled
-- (Database → Extensions). Both are free on Supabase.
--
-- Replace <PROJECT_REF> + <SERVICE_ROLE_JWT> below before running.
-- The function URL pattern is:
--   https://<PROJECT_REF>.supabase.co/functions/v1/closing-odds-poller
-- ============================================================

-- Enable extensions if not already on:
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;

-- Schedule: every 15 minutes. Adjust the cron expression for your
-- timezone / sport hours if you want to throttle off-hours polling.
SELECT cron.schedule(
  'closing-odds-poll',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://rxnqjdclqyazferbseeq.supabase.co/functions/v1/closing-odds-poller',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <SERVICE_ROLE_JWT>',
      'Content-Type', 'application/json'
    )
  );
  $$
);

-- To remove the schedule later:
-- SELECT cron.unschedule('closing-odds-poll');

-- To inspect runs:
-- SELECT * FROM cron.job_run_details
-- WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'closing-odds-poll')
-- ORDER BY start_time DESC
-- LIMIT 20;
