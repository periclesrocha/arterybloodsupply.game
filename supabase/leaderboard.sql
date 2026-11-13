-- Global leaderboard for the arterial tree game.
--
-- Run this once in your Supabase project: Dashboard > SQL Editor > New query >
-- paste this file > Run. It is safe to run again.
--
-- Players have no accounts. The page reads and writes with the project's
-- publishable key, so everything below is about what that key may do:
--   * read every score (public leaderboard)
--   * add a score, within sane limits, at most once every 15 s per nickname
--   * never change or delete a score
--
-- Score = time + 10 s per mistake + 20 s per hint. Lower is better.
-- To change the penalties later, change MISTAKE_PENALTY_MS / HINT_PENALTY_MS in
-- app.js and the score_ms formula below, then run these three lines and this
-- whole file again (existing scores are recomputed with the new formula):
--   drop view if exists public.leaderboard;
--   alter table public.scores drop column score_ms;
--   alter table public.scores add column score_ms integer generated always as (time_ms + mistakes * 10000 + hints * 20000) stored;

create table if not exists public.scores (
  id           bigint generated always as identity primary key,
  nickname     text        not null,
  nickname_key text        generated always as (lower(btrim(nickname))) stored,
  mode         text        not null,
  slide_order  boolean     not null default false,
  time_ms      integer     not null,
  mistakes     integer     not null default 0,
  hints        integer     not null default 0,
  score_ms     integer     generated always as (time_ms + mistakes * 10000 + hints * 20000) stored,
  created_at   timestamptz not null default now(),

  constraint scores_nickname_len  check (char_length(btrim(nickname)) between 1 and 24),
  constraint scores_mode          check (mode in ('practice', 'test')),
  -- 63 terms can't honestly be placed in under 30 seconds; nobody needs more than a day
  constraint scores_time_range    check (time_ms between 30000 and 86400000),
  constraint scores_mistakes      check (mistakes between 0 and 5000),
  constraint scores_hints         check (hints between 0 and 63)
);

create index if not exists scores_board_idx    on public.scores (mode, slide_order, score_ms);
create index if not exists scores_nickname_idx on public.scores (nickname_key, created_at desc);

-- Row level security: read anything, insert with a per-nickname cooldown, nothing else
alter table public.scores enable row level security;

drop policy if exists "Anyone can read scores" on public.scores;
create policy "Anyone can read scores"
  on public.scores for select
  to anon, authenticated
  using (true);

drop policy if exists "Anyone can add a score" on public.scores;
create policy "Anyone can add a score"
  on public.scores for insert
  to anon, authenticated
  with check (
    not exists (
      select 1 from public.scores s
      where s.nickname_key = lower(btrim(scores.nickname))
        and s.created_at > now() - interval '15 seconds'
    )
  );

-- Best run per nickname, per board (mode x slide order), with the number of runs
create or replace view public.leaderboard
  with (security_invoker = true) as
select distinct on (mode, slide_order, nickname_key)
  nickname_key,
  nickname,
  mode,
  slide_order,
  score_ms,
  time_ms,
  mistakes,
  hints,
  created_at,
  count(*) over (partition by mode, slide_order, nickname_key) as runs
from public.scores
order by mode, slide_order, nickname_key, score_ms asc, created_at asc;

-- Explicit grants: Supabase no longer exposes new tables to the API automatically.
-- Only the columns a player sends can be written; id, created_at and the score are set here.
revoke all on table public.scores from anon, authenticated;
grant select on table public.scores to anon, authenticated;
grant insert (nickname, mode, slide_order, time_ms, mistakes, hints) on table public.scores to anon, authenticated;
grant select on table public.leaderboard to anon, authenticated;
