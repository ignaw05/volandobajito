-- 003_route_stats_refresh.sql
-- Server-side refresh of route_stats: percentiles must be computed in SQL
-- (percentile_cont), not in JS. Called by the detect pipeline via RPC.

create or replace function refresh_route_stats(p_window_days int default 90)
returns integer
language sql
set search_path = ''
as $$
  with windowed as (
    select
      p.route_id,
      percentile_cont(0.5)  within group (order by p.price_usd) as median_usd,
      percentile_cont(0.10) within group (order by p.price_usd) as p10_usd,
      percentile_cont(0.25) within group (order by p.price_usd) as p25_usd,
      count(*)::int as sample_count
    from public.price_history p
    where p.observed_at >= now() - make_interval(days => p_window_days)
    group by p.route_id
  ),
  upserted as (
    insert into public.route_stats
      (route_id, median_usd, p10_usd, p25_usd, sample_count, window_days, updated_at)
    select
      r.id,
      w.median_usd,
      w.p10_usd,
      w.p25_usd,
      coalesce(w.sample_count, 0),
      p_window_days,
      now()
    from public.routes r
    left join windowed w on w.route_id = r.id
    on conflict (route_id) do update set
      median_usd   = excluded.median_usd,
      p10_usd      = excluded.p10_usd,
      p25_usd      = excluded.p25_usd,
      sample_count = excluded.sample_count,
      window_days  = excluded.window_days,
      updated_at   = excluded.updated_at
    returning 1
  )
  select count(*)::int from upserted;
$$;
