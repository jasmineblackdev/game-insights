-- Script upserts require UPDATE, not only INSERT.
drop policy if exists "service update mlb_pitcher_recent_form" on public.mlb_pitcher_recent_form;
create policy "service update mlb_pitcher_recent_form"
  on public.mlb_pitcher_recent_form
  for update
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
