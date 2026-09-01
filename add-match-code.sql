-- ============================================================
-- Adds the short join-code used by the new 1v1 lobby screen.
-- Run once in Supabase's SQL editor.
-- ============================================================

alter table matches add column if not exists code text;

-- Backfill any existing matches with a random code so the
-- unique index below doesn't choke on nulls/duplicates.
update matches set code = upper(substr(md5(random()::text || id::text), 1, 6))
  where code is null;

alter table matches alter column code set not null;

create unique index if not exists matches_code_unique on matches (code);
