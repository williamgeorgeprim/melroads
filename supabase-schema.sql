-- ============================================================
-- Guess the Road — Supabase schema
-- Run this once in your Supabase project's SQL editor
-- (Project -> SQL Editor -> New query -> paste -> Run).
-- ============================================================

-- One row per user, created on first sign-in.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz default now()
);

-- One row per completed round, across all modes.
create table if not exists scores (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  mode text not null check (mode in ('daily', 'endless', '1v1')),
  road_id integer not null,
  road_name text not null,
  score integer not null,
  played_on date not null default (now() at time zone 'Australia/Melbourne')::date,
  created_at timestamptz default now()
);

-- One daily attempt per user per day.
create unique index if not exists one_daily_score_per_user
  on scores (user_id, played_on)
  where mode = 'daily';

-- Speeds up the endless-average-per-road lookup.
create index if not exists scores_endless_by_road
  on scores (road_id)
  where mode = 'endless';

-- 1v1 matches. road_id = -1 means "not yet assigned" (creator assigns
-- it on first load of the game page so both players see the same road).
create table if not exists matches (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  road_id integer not null default -1,
  road_name text not null default '',
  player_a uuid references profiles(id) not null,
  player_b uuid references profiles(id),
  score_a integer,
  score_b integer,
  status text not null default 'waiting' check (status in ('waiting', 'active', 'complete')),
  created_at timestamptz default now()
);

alter table profiles enable row level security;
alter table scores enable row level security;
alter table matches enable row level security;

create policy "profiles are viewable by everyone" on profiles
  for select using (true);
create policy "users can insert their own profile" on profiles
  for insert with check (auth.uid() = id);
create policy "users can update their own profile" on profiles
  for update using (auth.uid() = id);

create policy "scores are viewable by everyone" on scores
  for select using (true);
create policy "users can insert their own scores" on scores
  for insert with check (auth.uid() = user_id);

create policy "matches viewable by everyone" on matches
  for select using (true);
create policy "signed-in users can create matches" on matches
  for insert with check (auth.uid() = player_a);
create policy "participants can update their match" on matches
  for update using (auth.uid() = player_a or auth.uid() = player_b);

-- Enable Realtime on matches so the 1v1 subscription in js/supabase-client.js works:
-- Project -> Database -> Replication -> supabase_realtime -> toggle on for "matches".
