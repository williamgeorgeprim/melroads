-- ============================================================
-- Guess the Road — Supabase schema (single file, run once)
-- Supabase dashboard -> SQL Editor -> New query -> paste -> Run.
-- ============================================================

-- One row per user, created on first sign-in.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz default now()
);

-- One row per completed round, across daily/endless AND every
-- multiplayer lobby round (lobby rounds are also mirrored into
-- lobby_round_scores below, which is what drives live standings).
create table if not exists scores (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  mode text not null check (mode in ('daily', 'endless')),
  road_id integer not null,
  road_name text not null,
  score integer not null,
  played_on date not null default (now() at time zone 'Australia/Melbourne')::date,
  created_at timestamptz default now()
);

create unique index if not exists one_daily_score_per_user
  on scores (user_id, played_on) where mode = 'daily';

create index if not exists scores_endless_by_road
  on scores (road_id) where mode = 'endless';

-- ============================================================
-- Multiplayer lobbies (2-10 players, replaces the old 1v1 mode —
-- a 1v1 game is just a lobby with max_players = 2).
-- ============================================================

create table if not exists lobbies (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  share_token text not null unique,
  host_id uuid references profiles(id) not null,
  max_players integer not null default 4 check (max_players between 2 and 10),
  total_rounds integer not null default 5 check (total_rounds between 1 and 100),
  is_public boolean not null default false,
  status text not null default 'waiting' check (status in ('waiting', 'active', 'complete')),
  current_round integer not null default 0,
  road_ids integer[] not null default '{}',
  road_names text[] not null default '{}',
  rematch_lobby_id uuid references lobbies(id),
  created_at timestamptz default now()
);

create table if not exists lobby_players (
  id bigserial primary key,
  lobby_id uuid references lobbies(id) on delete cascade not null,
  user_id uuid references profiles(id) not null,
  is_host boolean not null default false,
  status text not null default 'joined' check (status in ('joined', 'left', 'kicked')),
  joined_at timestamptz default now(),
  unique (lobby_id, user_id)
);

create table if not exists lobby_round_scores (
  id bigserial primary key,
  lobby_id uuid references lobbies(id) on delete cascade not null,
  user_id uuid references profiles(id) not null,
  round_number integer not null,
  score integer not null,
  created_at timestamptz default now(),
  unique (lobby_id, user_id, round_number)
);

-- Enforce max_players at insert time (joinLobby looks for the word
-- "full" in the error message to show a friendly error).
create or replace function check_lobby_not_full() returns trigger as $$
declare joined_count integer; cap integer;
begin
  select max_players into cap from lobbies where id = new.lobby_id;
  select count(*) into joined_count from lobby_players where lobby_id = new.lobby_id and status = 'joined';
  if joined_count >= cap then
    raise exception 'Lobby is full';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists lobby_capacity_check on lobby_players;
create trigger lobby_capacity_check
  before insert on lobby_players
  for each row execute function check_lobby_not_full();

-- Records a round score and, once every still-joined player has
-- submitted for that round, advances current_round (or flips the
-- lobby to 'complete' after the last round). Returns the lobby row.
create or replace function submit_round_score(p_lobby_id uuid, p_round integer, p_score integer)
returns lobbies as $$
declare
  v_lobby lobbies;
  v_joined_count integer;
  v_submitted_count integer;
begin
  insert into lobby_round_scores (lobby_id, user_id, round_number, score)
  values (p_lobby_id, auth.uid(), p_round, p_score)
  on conflict (lobby_id, user_id, round_number) do update set score = excluded.score;

  select * into v_lobby from lobbies where id = p_lobby_id for update;

  select count(*) into v_joined_count from lobby_players where lobby_id = p_lobby_id and status = 'joined';
  select count(*) into v_submitted_count from lobby_round_scores where lobby_id = p_lobby_id and round_number = p_round;

  if v_submitted_count >= v_joined_count and v_lobby.current_round = p_round then
    if p_round >= v_lobby.total_rounds then
      update lobbies set status = 'complete' where id = p_lobby_id returning * into v_lobby;
    else
      update lobbies set current_round = p_round + 1 where id = p_lobby_id returning * into v_lobby;
    end if;
  end if;

  return v_lobby;
end;
$$ language plpgsql security definer;

-- ============================================================
-- All-time totals — every point a player has ever scored, across
-- Daily, Endless, and every multiplayer lobby round combined.
-- ============================================================

create or replace view player_totals as
select
  p.id as user_id,
  p.display_name,
  coalesce(sum(t.score), 0) as total,
  count(t.score) as games_played
from profiles p
left join (
  select user_id, score from scores
  union all
  select user_id, score from lobby_round_scores
) t on t.user_id = p.id
group by p.id, p.display_name;

grant select on player_totals to anon, authenticated;

-- Open public lobbies anyone can browse and join without a code —
-- powers the "Open games" list on the home page.
create or replace view public_open_lobbies as
select
  l.id, l.code, l.max_players, l.total_rounds, l.created_at,
  p.display_name as host_name,
  (select count(*) from lobby_players lp where lp.lobby_id = l.id and lp.status = 'joined') as player_count
from lobbies l
join profiles p on p.id = l.host_id
where l.is_public = true and l.status = 'waiting';

grant select on public_open_lobbies to anon, authenticated;

-- ============================================================
-- Row Level Security
-- ============================================================

alter table profiles enable row level security;
alter table scores enable row level security;
alter table lobbies enable row level security;
alter table lobby_players enable row level security;
alter table lobby_round_scores enable row level security;

create policy "profiles viewable by everyone" on profiles for select using (true);
create policy "users insert their own profile" on profiles for insert with check (auth.uid() = id);
create policy "users update their own profile" on profiles for update using (auth.uid() = id);

create policy "scores viewable by everyone" on scores for select using (true);
create policy "users insert their own scores" on scores for insert with check (auth.uid() = user_id);

create policy "lobbies viewable by everyone" on lobbies for select using (true);
create policy "signed-in users create lobbies" on lobbies for insert with check (auth.uid() = host_id);
create policy "host updates their lobby" on lobbies for update using (auth.uid() = host_id);

create policy "lobby players viewable by everyone" on lobby_players for select using (true);
create policy "signed-in users join lobbies, hosts add rematch players" on lobby_players for insert
  with check (auth.uid() = user_id or auth.uid() in (select host_id from lobbies where id = lobby_id));
create policy "self or host updates a lobby player row" on lobby_players for update
  using (auth.uid() = user_id or auth.uid() in (select host_id from lobbies where id = lobby_id));

create policy "round scores viewable by everyone" on lobby_round_scores for select using (true);
create policy "users insert their own round scores" on lobby_round_scores for insert with check (auth.uid() = user_id);

-- ============================================================
-- After running this: Database -> Replication -> supabase_realtime
-- -> toggle ON for: lobbies, lobby_players, lobby_round_scores
-- ============================================================
