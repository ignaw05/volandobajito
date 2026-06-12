-- 001_initial_schema.sql
-- Core data model: monitored routes, price observations, rolling stats,
-- deal lifecycle and click tracking.

-- Routes of the monitored universe
create table routes (
  id            serial primary key,
  origin        text not null,            -- IATA: EZE, AEP, COR, MDZ, ROS
  destination   text not null,            -- IATA
  region        text not null,            -- 'regional' | 'caribbean' | 'usa' | 'europe' | 'other'
  active        boolean not null default true,
  -- absolute sanity threshold in USD: a price below this value is always a
  -- candidate, regardless of statistics. NULL = no absolute threshold.
  sanity_threshold_usd numeric,
  created_at    timestamptz not null default now(),
  unique (origin, destination)
);

-- Every price observation (layers 1 and 3 both write here)
create table price_history (
  id            bigserial primary key,
  route_id      int not null references routes(id),
  depart_date   date not null,
  return_date   date,                     -- null = one-way
  price_usd     numeric not null,
  airline       text,
  direct        boolean,
  source        text not null,            -- 'travelpayouts' | 'searchapi' | 'flightapi'
  observed_at   timestamptz not null default now()
);
create index idx_price_history_route_time on price_history (route_id, observed_at desc);

-- Rolling stats per route (refreshed on every detect run)
create table route_stats (
  route_id      int primary key references routes(id),
  median_usd    numeric,
  p10_usd       numeric,
  p25_usd       numeric,
  sample_count  int not null default 0,
  window_days   int not null default 90,
  updated_at    timestamptz not null default now()
);

-- Deal lifecycle
create type deal_status as enum
  ('candidate', 'verified', 'rejected', 'published', 'expired');

create table deals (
  id            uuid primary key default gen_random_uuid(),
  route_id      int not null references routes(id),
  status        deal_status not null default 'candidate',
  depart_date   date not null,
  return_date   date,
  cached_price_usd    numeric not null,   -- price that triggered detection (layer 1)
  verified_price_usd  numeric,            -- confirmed price (layer 3)
  airline       text,
  direct        boolean,
  booking_url   text,                     -- Google Flights link with the search prefilled
  -- statistical context frozen at detection time:
  median_at_detection numeric,
  discount_pct  numeric,                  -- 1 - (price / median)
  score         numeric,
  is_error_fare boolean not null default false,
  detected_at   timestamptz not null default now(),
  verified_at   timestamptz,
  published_at  timestamptz,
  expired_at    timestamptz,
  telegram_message_id bigint,             -- to edit the post once expired
  rejection_reason text
);
create index idx_deals_status on deals (status);
-- cooldown: avoids duplicates of the same route within a short window
create index idx_deals_route_detected on deals (route_id, detected_at desc);

-- Click tracking (written by the Vercel function)
create table click_events (
  id          bigserial primary key,
  deal_id     uuid not null references deals(id),
  clicked_at  timestamptz not null default now(),
  user_agent  text,
  referer     text
);
create index idx_clicks_deal on click_events (deal_id);
