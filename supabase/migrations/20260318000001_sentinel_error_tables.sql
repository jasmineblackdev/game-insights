-- ============================================================
-- Sentinel Error Monitoring Tables
-- ============================================================

-- Error issues: one row per unique fingerprinted error
create table if not exists error_issues (
  id                   uuid        default gen_random_uuid() primary key,
  fingerprint          text        unique not null,
  title                text        not null,
  message              text        not null,
  category             text        not null  check (category in ('frontend','backend','api','performance','recurring')),
  severity             text        not null  default 'warning' check (severity in ('critical','warning','info')),
  status               text        not null  default 'open'    check (status in ('open','resolved','ignored')),
  environment          text        not null  default 'production',
  event_count          integer     not null  default 1,
  affected_users_count integer     not null  default 0,
  route                text,
  endpoint             text,
  release_version      text,
  file_path            text,
  line_number          integer,
  tags                 text[]      default '{}',
  assignee             text,
  org_id               uuid,
  first_seen           timestamptz not null  default now(),
  last_seen            timestamptz not null  default now(),
  created_at           timestamptz not null  default now()
);
create index if not exists error_issues_last_seen     on error_issues (last_seen desc);
create index if not exists error_issues_status        on error_issues (status);
create index if not exists error_issues_severity      on error_issues (severity);
create index if not exists error_issues_category      on error_issues (category);
create index if not exists error_issues_environment   on error_issues (environment);
create index if not exists error_issues_org_id        on error_issues (org_id);
-- Error events: individual occurrences linked to an issue
create table if not exists error_events (
  id              uuid        default gen_random_uuid() primary key,
  issue_id        uuid        not null references error_issues(id) on delete cascade,
  timestamp       timestamptz not null default now(),
  user_id         text,
  session_id      text,
  message         text        not null,
  stack_trace     text,
  stack_frames    jsonb       not null default '[]',
  request_method  text,
  request_url     text,
  status_code     integer,
  duration_ms     float,
  breadcrumbs     jsonb       not null default '[]',
  context         jsonb       not null default '{}',
  environment     text        not null default 'production'
);
create index if not exists error_events_issue_id  on error_events (issue_id);
create index if not exists error_events_timestamp on error_events (timestamp desc);
-- Error alerts: fired when thresholds are crossed
create table if not exists error_alerts (
  id           uuid        default gen_random_uuid() primary key,
  issue_id     uuid        not null references error_issues(id) on delete cascade,
  triggered_at timestamptz not null default now(),
  severity     text        not null,
  message      text        not null
);
create index if not exists error_alerts_issue_id on error_alerts (issue_id);
-- ── Row Level Security ──────────────────────────────────────────────────

alter table error_issues  enable row level security;
alter table error_events  enable row level security;
alter table error_alerts  enable row level security;
-- Authenticated users can read all error data (internal monitoring)
create policy "Authenticated users can read error_issues"
  on error_issues for select
  to authenticated
  using (true);
create policy "Authenticated users can read error_events"
  on error_events for select
  to authenticated
  using (true);
create policy "Authenticated users can read error_alerts"
  on error_alerts for select
  to authenticated
  using (true);
-- Authenticated users can update issue status / assignee
create policy "Authenticated users can update error_issues"
  on error_issues for update
  to authenticated
  using (true)
  with check (true);
-- Service role (edge functions) can do everything — bypasses RLS;
