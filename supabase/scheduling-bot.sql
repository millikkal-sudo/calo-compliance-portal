-- Slack scheduling bot tables. Run once in Supabase > SQL Editor.
-- Only the server (service role) uses these, so RLS is on with no policies.

create table if not exists public.dept_managers (
  market        text not null,                 -- 'UAE' or 'Qatar'
  department    text not null,                 -- must match the portal's department name (case doesn't matter)
  slack_user_id text not null,                 -- Slack member ID, e.g. U04ABC123
  manager_name  text,
  tier          int  not null default 1 check (tier in (1, 2)),  -- 1 = asked first, 2 = backup after 48h
  primary key (market, department, slack_user_id)
);

create table if not exists public.schedule_requests (
  id             uuid primary key default gen_random_uuid(),
  certificate_id uuid not null references public.certificates(id) on delete cascade,
  market         text not null,
  stage          text not null check (stage in ('14','7')),
  expiry_date    date not null,
  status         text not null default 'sent' check (status in ('sent','booked','declined','escalated')),
  slack_channel  text,
  slack_ts       text,
  booked_date    date,
  responded_by   text,
  note           text,
  dm_messages    jsonb not null default '[]',
  level          int  not null default 1,          -- 1 = first managers asked, 2 = backup manager asked
  level_at       timestamptz not null default now(),      -- every DM sent for this request, so the others update when one person answers
  sent_at        timestamptz not null default now(),
  responded_at   timestamptz,
  unique (certificate_id, stage, expiry_date)
);
create index if not exists schedule_requests_open on public.schedule_requests (market, stage, status, sent_at);

create table if not exists public.slack_threads (
  market  text not null,
  month   text not null,                        -- 'YYYY-MM'
  channel text not null,
  ts      text not null,
  primary key (market, month)
);

alter table public.dept_managers     enable row level security;
alter table public.schedule_requests enable row level security;
alter table public.slack_threads     enable row level security;

-- Department -> managers. Tier 1 (two people) are asked first; tier 2 (one person) gets it if
-- tier 1 doesn't answer in 48 hours; after another 48 hours it goes to HR.
-- Slack member ID: click the person's name > View full profile > ... > Copy member ID
insert into public.dept_managers (market, department, slack_user_id, manager_name, tier) values
  ('UAE', 'Kitchen',   'UXXXXXXXXX1', 'Kitchen lead 1',   1),
  ('UAE', 'Kitchen',   'UXXXXXXXXX2', 'Kitchen lead 2',   1),
  ('UAE', 'Kitchen',   'UXXXXXXXXX3', 'Kitchen backup',   2),
  ('UAE', 'Dispatch',  'UXXXXXXXXX4', 'Dispatch lead 1',  1),
  ('UAE', 'Dispatch',  'UXXXXXXXXX5', 'Dispatch lead 2',  1),
  ('UAE', 'Dispatch',  'UXXXXXXXXX6', 'Dispatch backup',  2)
on conflict (market, department, slack_user_id) do update
  set manager_name = excluded.manager_name, tier = excluded.tier;
