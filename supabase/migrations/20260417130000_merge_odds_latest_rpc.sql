-- RPC for Edge Function odds-persist: atomic upsert into odds_latest (CLV / line movement).
-- Service role only — not exposed to anon PostgREST by default (no grant to anon).

create or replace function public.merge_odds_latest_row(
  p_sport text,
  p_game_id text,
  p_sportsbook_id uuid,
  p_market_type text,
  p_side_key text,
  p_stat_type text,
  p_line_value numeric,
  p_american integer,
  p_implied numeric
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.odds_latest (
    sport,
    game_id,
    sportsbook_id,
    market_type,
    side_key,
    stat_type,
    line_value,
    opening_odds,
    current_odds,
    opening_implied_probability,
    current_implied_probability,
    line_movement_delta,
    updated_at
  ) values (
    p_sport,
    p_game_id,
    p_sportsbook_id,
    p_market_type,
    p_side_key,
    case when p_stat_type is null or btrim(p_stat_type) = '' then null else p_stat_type end,
    p_line_value,
    p_american,
    p_american,
    p_implied,
    p_implied,
    0,
    now()
  )
  on conflict (sport, game_id, sportsbook_id, market_type, side_key, stat_type, line_value)
  do update set
    current_odds = excluded.current_odds,
    current_implied_probability = excluded.current_implied_probability,
    line_movement_delta =
      (excluded.current_implied_probability - public.odds_latest.opening_implied_probability) * 100,
    updated_at = now();
end;
$$;

revoke all on function public.merge_odds_latest_row(
  text, text, uuid, text, text, text, numeric, integer, numeric
) from public;

grant execute on function public.merge_odds_latest_row(
  text, text, uuid, text, text, text, numeric, integer, numeric
) to service_role;
