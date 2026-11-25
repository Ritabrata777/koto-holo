begin;
-- ============================================================================
-- Expense Tracker: trip expense splitter. Supabase / Postgres schema.
--
-- Safe to run more than once (idempotent). Every object it creates is prefixed
-- hs_ so it can share a project with other apps.
--
-- Security model
--   * Verified Clerk accounts are required. Invites use a secret token
--     (24 random bytes, base64url) that lives in the invite link.
--   * Row-level security is ON for every hs_ table and there are NO policies,
--     and anon/authenticated have no table privileges at all. The browser
--     cannot read or write a table directly.
--   * The browser calls the hs_* functions below. They are SECURITY DEFINER,
--     pin search_path to '', and every one of them requires the trip token.
--     The account migration below enforces membership and per-action permissions.
--   * Internal helpers (hs__*) are not executable by anon/authenticated.
--
-- Money is stored as integer paise (bigint). Rupees are only a display format.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.hs_trips (
  id          uuid primary key default gen_random_uuid(),
  token       text not null unique check (char_length(token) between 24 and 64),
  name        text not null check (char_length(name) between 1 and 60),
  version     bigint not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.hs_members (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.hs_trips (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 24),
  upi         text check (upi is null or upi ~ '^[a-z0-9._-]{2,64}@[a-z][a-z0-9.-]{1,48}$'),
  position    integer not null check (position > 0),
  created_at  timestamptz not null default now()
);
create unique index if not exists hs_members_trip_name_key on public.hs_members (trip_id, lower(name));
create index if not exists hs_members_trip_idx on public.hs_members (trip_id, position);

create table if not exists public.hs_expenses (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.hs_trips (id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 60),
  amount_paise  bigint not null check (amount_paise > 0 and amount_paise <= 100000000), -- up to Rs 10 lakh
  paid_by       uuid not null references public.hs_members (id) deferrable initially deferred,
  created_by    uuid references public.hs_members (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
-- Null means equal shares; an object stores exact paise by member ID.
alter table public.hs_expenses add column if not exists shares jsonb;
create index if not exists hs_expenses_trip_idx on public.hs_expenses (trip_id, created_at);
create index if not exists hs_expenses_paid_by_idx on public.hs_expenses (paid_by);
create index if not exists hs_expenses_created_by_idx on public.hs_expenses (created_by);

-- Who an expense is split between (equal split, paise-exact on the client).
create table if not exists public.hs_expense_shares (
  expense_id  uuid not null references public.hs_expenses (id) on delete cascade,
  member_id   uuid not null references public.hs_members (id) deferrable initially deferred,
  primary key (expense_id, member_id)
);
create index if not exists hs_expense_shares_member_idx on public.hs_expense_shares (member_id);

-- Settle-up payments someone marked as paid.
create table if not exists public.hs_payments (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.hs_trips (id) on delete cascade,
  from_member   uuid not null references public.hs_members (id) deferrable initially deferred,
  to_member     uuid not null references public.hs_members (id) deferrable initially deferred,
  amount_paise  bigint not null check (amount_paise > 0 and amount_paise <= 1000000000),
  created_at    timestamptz not null default now(),
  check (from_member <> to_member)
);
create index if not exists hs_payments_trip_idx on public.hs_payments (trip_id, created_at);
create index if not exists hs_payments_from_idx on public.hs_payments (from_member);
create index if not exists hs_payments_to_idx on public.hs_payments (to_member);

-- Member references are checked at commit (deferred), so deleting a trip cascades
-- cleanly, while deleting a member who still has money on the trip still fails.
-- Upgrades databases created by earlier versions of this file (RESTRICT / immediate).
do $$
declare
  c record;
begin
  for c in
    select con.conname, cls.relname, att.attname
    from pg_constraint con
    join pg_class cls on cls.oid = con.conrelid
    join pg_namespace ns on ns.oid = cls.relnamespace
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where ns.nspname = 'public'
      and con.contype = 'f'
      and con.confrelid = 'public.hs_members'::regclass
      and (con.confdeltype = 'r' or not con.condeferred)
      and (cls.relname, att.attname) in (('hs_expenses', 'paid_by'), ('hs_expense_shares', 'member_id'),
                                         ('hs_payments', 'from_member'), ('hs_payments', 'to_member'))
  loop
    execute format('alter table public.%I drop constraint %I', c.relname, c.conname);
    execute format('alter table public.%I add constraint %I foreign key (%I) references public.hs_members (id) deferrable initially deferred',
                   c.relname, c.conname, c.attname);
  end loop;
  -- created_by is only a note of who added an expense: it clears when that person is removed.
  if exists (select 1 from pg_constraint
             where conname = 'hs_expenses_created_by_fkey' and conrelid = 'public.hs_expenses'::regclass
               and confdeltype <> 'n') then
    alter table public.hs_expenses drop constraint hs_expenses_created_by_fkey;
    alter table public.hs_expenses add constraint hs_expenses_created_by_fkey
      foreign key (created_by) references public.hs_members (id) on delete set null;
  end if;
end $$;

-- Lock the tables: RLS on, no policies, no grants to the API roles.
alter table public.hs_trips          enable row level security;
alter table public.hs_members        enable row level security;
alter table public.hs_expenses       enable row level security;
alter table public.hs_expense_shares enable row level security;
alter table public.hs_payments       enable row level security;

revoke all on table public.hs_trips, public.hs_members, public.hs_expenses,
                    public.hs_expense_shares, public.hs_payments
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable from the browser)
-- ---------------------------------------------------------------------------

-- Resolve a token to a trip id, or fail with HTTP 404.
create or replace function public.hs__trip(p_token text)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if p_token is null or char_length(p_token) not between 24 and 64 then
    raise exception 'trip_not_found' using errcode = 'PT404';
  end if;
  select t.id into v_id from public.hs_trips t where t.token = p_token;
  if v_id is null then
    raise exception 'trip_not_found' using errcode = 'PT404';
  end if;
  return v_id;
end $$;

-- Bump the trip's version so polling clients know to refetch.
create or replace function public.hs__touch(p_trip uuid)
returns bigint
language sql volatile security definer set search_path = ''
as $$
  update public.hs_trips set version = version + 1, updated_at = now()
  where id = p_trip
  returning version;
$$;

create or replace function public.hs__clean_name(p_name text, p_max int)
returns text
language plpgsql immutable set search_path = ''
as $$
declare v text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  if char_length(v) = 0 then
    raise exception 'name_required' using errcode = 'PT400';
  end if;
  if char_length(v) > p_max then
    raise exception 'name_too_long' using errcode = 'PT400';
  end if;
  return v;
end $$;

create or replace function public.hs__clean_upi(p_upi text)
returns text
language plpgsql immutable set search_path = ''
as $$
declare v text := lower(btrim(coalesce(p_upi, '')));
begin
  if v = '' then return null; end if;
  if v !~ '^[a-z0-9._-]{2,64}@[a-z][a-z0-9.-]{1,48}$' then
    raise exception 'bad_upi' using errcode = 'PT400';
  end if;
  return v;
end $$;

create or replace function public.hs__member_in_trip(p_trip uuid, p_member uuid)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_member is null or not exists (
    select 1 from public.hs_members m where m.id = p_member and m.trip_id = p_trip
  ) then
    raise exception 'member_not_found' using errcode = 'PT404';
  end if;
end $$;

-- Validate an expense's fields; returns the de-duplicated split list.
create or replace function public.hs__check_expense(
  p_trip uuid, p_title text, p_amount_paise bigint, p_paid_by uuid, p_split uuid[]
)
returns uuid[]
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_split uuid[];
  v_found int;
begin
  if p_amount_paise is null or p_amount_paise <= 0 or p_amount_paise > 100000000 then
    raise exception 'bad_amount' using errcode = 'PT400';
  end if;
  perform public.hs__member_in_trip(p_trip, p_paid_by);
  select coalesce(array_agg(distinct s), '{}') into v_split
  from unnest(coalesce(p_split, '{}'::uuid[])) as s where s is not null;
  if cardinality(v_split) = 0 then
    raise exception 'split_required' using errcode = 'PT400';
  end if;
  select count(*) into v_found from public.hs_members m
  where m.trip_id = p_trip and m.id = any (v_split);
  if v_found <> cardinality(v_split) then
    raise exception 'member_not_found' using errcode = 'PT404';
  end if;
  return v_split;
end $$;

-- ---------------------------------------------------------------------------
-- API (callable by anon through PostgREST: POST /rest/v1/rpc/<name>)
-- ---------------------------------------------------------------------------

-- Create a trip and its first member. Returns the secret token.
create or replace function public.hs_create_trip(p_name text, p_member_name text, p_member_upi text default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_token  text := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');
  v_name   text := public.hs__clean_name(p_name, 60);
  v_member text := public.hs__clean_name(p_member_name, 24);
  v_upi    text := public.hs__clean_upi(p_member_upi);
  v_trip   uuid;
  v_mid    uuid;
begin
  insert into public.hs_trips (token, name) values (v_token, v_name) returning id into v_trip;
  insert into public.hs_members (trip_id, name, upi, position)
  values (v_trip, v_member, v_upi, 1) returning id into v_mid;
  return jsonb_build_object('token', v_token, 'trip_id', v_trip, 'member_id', v_mid);
end $$;

-- Everything the app shows for one trip.
create or replace function public.hs_get_trip(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_trip uuid := public.hs__trip(p_token);
begin
  return (
    select jsonb_build_object(
      'trip', jsonb_build_object('id', t.id, 'name', t.name, 'version', t.version,
                                 'created_at', t.created_at, 'updated_at', t.updated_at),
      'members', coalesce((
        select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'upi', m.upi,
                                            'position', m.position) order by m.position)
        from public.hs_members m where m.trip_id = t.id), '[]'::jsonb),
      'expenses', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', e.id, 'title', e.title, 'amount_paise', e.amount_paise,
                 'paid_by', e.paid_by, 'created_by', e.created_by, 'shares', e.shares,
                 'split', coalesce((select jsonb_agg(s.member_id) from public.hs_expense_shares s
                                    where s.expense_id = e.id), '[]'::jsonb),
                 'created_at', e.created_at, 'updated_at', e.updated_at)
               order by e.created_at desc, e.id)
        from public.hs_expenses e where e.trip_id = t.id), '[]'::jsonb),
      'payments', coalesce((
        select jsonb_agg(jsonb_build_object('id', p.id, 'from', p.from_member, 'to', p.to_member,
                                            'amount_paise', p.amount_paise, 'created_at', p.created_at)
               order by p.created_at desc, p.id)
        from public.hs_payments p where p.trip_id = t.id), '[]'::jsonb)
    )
    from public.hs_trips t where t.id = v_trip
  );
end $$;

-- Cheap polling: has anything changed?
create or replace function public.hs_trip_version(p_token text)
returns bigint
language plpgsql stable security definer set search_path = ''
as $$
declare v_trip uuid := public.hs__trip(p_token);
begin
  return (select t.version from public.hs_trips t where t.id = v_trip);
end $$;

create or replace function public.hs_rename_trip(p_token text, p_name text)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare v_trip uuid := public.hs__trip(p_token);
begin
  update public.hs_trips set name = public.hs__clean_name(p_name, 60) where id = v_trip;
  return public.hs__touch(v_trip);
end $$;

-- Join a trip from its link. Names are unique per trip (case-insensitive).
create or replace function public.hs_join_trip(p_token text, p_name text, p_upi text default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_trip uuid := public.hs__trip(p_token);
  v_name text := public.hs__clean_name(p_name, 24);
  v_upi  text := public.hs__clean_upi(p_upi);
  v_pos  int;
  v_mid  uuid;
begin
  perform 1 from public.hs_trips where id = v_trip for update;  -- serialise joins per trip
  if (select count(*) from public.hs_members where trip_id = v_trip) >= 30 then
    raise exception 'trip_full' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.hs_members where trip_id = v_trip and lower(name) = lower(v_name)) then
    raise exception 'name_taken' using errcode = 'PT409';
  end if;
  select coalesce(max(position), 0) + 1 into v_pos from public.hs_members where trip_id = v_trip;
  insert into public.hs_members (trip_id, name, upi, position)
  values (v_trip, v_name, v_upi, v_pos) returning id into v_mid;
  return jsonb_build_object('member_id', v_mid, 'version', public.hs__touch(v_trip));
end $$;

create or replace function public.hs_update_member(p_token text, p_member uuid, p_name text, p_upi text default null)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_trip uuid := public.hs__trip(p_token);
  v_name text := public.hs__clean_name(p_name, 24);
begin
  perform public.hs__member_in_trip(v_trip, p_member);
  if exists (select 1 from public.hs_members
             where trip_id = v_trip and id <> p_member and lower(name) = lower(v_name)) then
    raise exception 'name_taken' using errcode = 'PT409';
  end if;
  update public.hs_members set name = v_name, upi = public.hs__clean_upi(p_upi) where id = p_member;
  return public.hs__touch(v_trip);
end $$;

-- Remove someone who joined by mistake. Only allowed while they have no money on the trip.
create or replace function public.hs_remove_member(p_token text, p_member uuid)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare v_trip uuid := public.hs__trip(p_token);
begin
  perform public.hs__member_in_trip(v_trip, p_member);
  if exists (select 1 from public.hs_expenses where paid_by = p_member)
     or exists (select 1 from public.hs_expense_shares where member_id = p_member)
     or exists (select 1 from public.hs_payments where from_member = p_member or to_member = p_member) then
    raise exception 'member_has_activity' using errcode = 'PT409';
  end if;
  update public.hs_expenses set created_by = null where created_by = p_member;
  delete from public.hs_members where id = p_member;
  return public.hs__touch(v_trip);
end $$;

create or replace function public.hs_add_expense(
  p_token text, p_title text, p_amount_paise bigint, p_paid_by uuid, p_split uuid[], p_actor uuid default null
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_trip  uuid := public.hs__trip(p_token);
  v_title text := public.hs__clean_name(p_title, 60);
  v_split uuid[];
  v_id    uuid;
begin
  v_split := public.hs__check_expense(v_trip, v_title, p_amount_paise, p_paid_by, p_split);
  if p_actor is not null then perform public.hs__member_in_trip(v_trip, p_actor); end if;
  if (select count(*) from public.hs_expenses where trip_id = v_trip) >= 500 then
    raise exception 'trip_full' using errcode = 'PT409';
  end if;
  insert into public.hs_expenses (trip_id, title, amount_paise, paid_by, created_by)
  values (v_trip, v_title, p_amount_paise, p_paid_by, p_actor) returning id into v_id;
  insert into public.hs_expense_shares (expense_id, member_id) select v_id, unnest(v_split);
  return jsonb_build_object('id', v_id, 'version', public.hs__touch(v_trip));
end $$;

create or replace function public.hs_update_expense(
  p_token text, p_expense uuid, p_title text, p_amount_paise bigint, p_paid_by uuid, p_split uuid[]
)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_trip  uuid := public.hs__trip(p_token);
  v_title text := public.hs__clean_name(p_title, 60);
  v_split uuid[];
begin
  if not exists (select 1 from public.hs_expenses where id = p_expense and trip_id = v_trip) then
    raise exception 'expense_not_found' using errcode = 'PT404';
  end if;
  v_split := public.hs__check_expense(v_trip, v_title, p_amount_paise, p_paid_by, p_split);
  update public.hs_expenses
     set title = v_title, amount_paise = p_amount_paise, paid_by = p_paid_by, shares = null, updated_at = now()
   where id = p_expense;
  delete from public.hs_expense_shares where expense_id = p_expense;
  insert into public.hs_expense_shares (expense_id, member_id) select p_expense, unnest(v_split);
  return public.hs__touch(v_trip);
end $$;

create or replace function public.hs_delete_expense(p_token text, p_expense uuid)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare v_trip uuid := public.hs__trip(p_token);
begin
  delete from public.hs_expenses where id = p_expense and trip_id = v_trip;
  if not found then
    raise exception 'expense_not_found' using errcode = 'PT404';
  end if;
  return public.hs__touch(v_trip);
end $$;

-- "Mark as paid" on a settle-up card.
create or replace function public.hs_record_payment(p_token text, p_from uuid, p_to uuid, p_amount_paise bigint)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_trip uuid := public.hs__trip(p_token);
  v_id   uuid;
begin
  perform public.hs__member_in_trip(v_trip, p_from);
  perform public.hs__member_in_trip(v_trip, p_to);
  if p_from = p_to then
    raise exception 'same_member' using errcode = 'PT400';
  end if;
  if p_amount_paise is null or p_amount_paise <= 0 or p_amount_paise > 1000000000 then
    raise exception 'bad_amount' using errcode = 'PT400';
  end if;
  if (select count(*) from public.hs_payments where trip_id = v_trip) >= 500 then
    raise exception 'trip_full' using errcode = 'PT409';
  end if;
  insert into public.hs_payments (trip_id, from_member, to_member, amount_paise)
  values (v_trip, p_from, p_to, p_amount_paise) returning id into v_id;
  return jsonb_build_object('id', v_id, 'version', public.hs__touch(v_trip));
end $$;

create or replace function public.hs_delete_payment(p_token text, p_payment uuid)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare v_trip uuid := public.hs__trip(p_token);
begin
  delete from public.hs_payments where id = p_payment and trip_id = v_trip;
  if not found then
    raise exception 'payment_not_found' using errcode = 'PT404';
  end if;
  return public.hs__touch(v_trip);
end $$;

-- ---------------------------------------------------------------------------
-- Function privileges: helpers private, API open to the anon key.
-- ---------------------------------------------------------------------------

revoke all on function public.hs__trip(text)                                     from public, anon, authenticated;
revoke all on function public.hs__touch(uuid)                                    from public, anon, authenticated;
revoke all on function public.hs__clean_name(text, int)                          from public, anon, authenticated;
revoke all on function public.hs__clean_upi(text)                                from public, anon, authenticated;
revoke all on function public.hs__member_in_trip(uuid, uuid)                     from public, anon, authenticated;
revoke all on function public.hs__check_expense(uuid, text, bigint, uuid, uuid[]) from public, anon, authenticated;

revoke all on function public.hs_create_trip(text, text, text)                         from public;
revoke all on function public.hs_get_trip(text)                                        from public;
revoke all on function public.hs_trip_version(text)                                    from public;
revoke all on function public.hs_rename_trip(text, text)                               from public;
revoke all on function public.hs_join_trip(text, text, text)                           from public;
revoke all on function public.hs_update_member(text, uuid, text, text)                 from public;
revoke all on function public.hs_remove_member(text, uuid)                             from public;
revoke all on function public.hs_add_expense(text, text, bigint, uuid, uuid[], uuid)   from public;
revoke all on function public.hs_update_expense(text, uuid, text, bigint, uuid, uuid[]) from public;
revoke all on function public.hs_delete_expense(text, uuid)                            from public;
revoke all on function public.hs_record_payment(text, uuid, uuid, bigint)              from public;
revoke all on function public.hs_delete_payment(text, uuid)                            from public;

grant execute on function public.hs_create_trip(text, text, text)                         to anon, authenticated;
grant execute on function public.hs_get_trip(text)                                        to anon, authenticated;
grant execute on function public.hs_trip_version(text)                                    to anon, authenticated;
grant execute on function public.hs_rename_trip(text, text)                               to anon, authenticated;
grant execute on function public.hs_join_trip(text, text, text)                           to anon, authenticated;
grant execute on function public.hs_update_member(text, uuid, text, text)                 to anon, authenticated;
grant execute on function public.hs_remove_member(text, uuid)                             to anon, authenticated;
grant execute on function public.hs_add_expense(text, text, bigint, uuid, uuid[], uuid)   to anon, authenticated;
grant execute on function public.hs_update_expense(text, uuid, text, bigint, uuid, uuid[]) to anon, authenticated;
grant execute on function public.hs_delete_expense(text, uuid)                            to anon, authenticated;
grant execute on function public.hs_record_payment(text, uuid, uuid, bigint)              to anon, authenticated;
grant execute on function public.hs_delete_payment(text, uuid)                            to anon, authenticated;


-- Validate exact splits before any write. Zero shares are allowed.
create or replace function public.hs__check_shares(p_shares jsonb, p_split uuid[], p_amount bigint)
returns void language plpgsql set search_path = '' as $$
declare v_total numeric := 0; v_key text; v_value jsonb;
begin
  if p_shares is null then return; end if;
  if jsonb_typeof(p_shares) <> 'object' then
    raise exception 'bad_shares' using errcode = 'PT400';
  end if;
  if (select count(*) from jsonb_object_keys(p_shares)) <> (select count(distinct x) from unnest(p_split) x) then
    raise exception 'bad_shares' using errcode = 'PT400';
  end if;
  for v_key, v_value in select * from jsonb_each(p_shares) loop
    if not exists (select 1 from unnest(p_split) member_id where member_id::text = v_key) or jsonb_typeof(v_value) <> 'number'
       or v_value::text !~ '^[0-9]+$' then
      raise exception 'bad_shares' using errcode = 'PT400';
    end if;
    if v_value::text::numeric > p_amount then
      raise exception 'bad_shares' using errcode = 'PT400';
    end if;
    v_total := v_total + v_value::text::numeric;
  end loop;
  if v_total <> p_amount then raise exception 'bad_shares' using errcode = 'PT400'; end if;
end $$;
revoke all on function public.hs__check_shares(jsonb, uuid[], bigint) from public, anon, authenticated;

create or replace function public.hs_add_expense_v2(
  p_token text, p_title text, p_amount_paise bigint, p_paid_by uuid, p_split uuid[],
  p_actor uuid default null, p_shares jsonb default null
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform public.hs__check_shares(p_shares, p_split, p_amount_paise);
  v_result := public.hs_add_expense(p_token, p_title, p_amount_paise, p_paid_by, p_split, p_actor);
  update public.hs_expenses set shares = p_shares where id = (v_result->>'id')::uuid;
  return v_result;
end $$;

create or replace function public.hs_update_expense_v2(
  p_token text, p_expense uuid, p_title text, p_amount_paise bigint, p_paid_by uuid,
  p_split uuid[], p_shares jsonb default null
) returns bigint language plpgsql volatile security definer set search_path = '' as $$
declare v_version bigint;
begin
  perform public.hs__check_shares(p_shares, p_split, p_amount_paise);
  v_version := public.hs_update_expense(p_token, p_expense, p_title, p_amount_paise, p_paid_by, p_split);
  update public.hs_expenses set shares = p_shares where id = p_expense;
  return v_version;
end $$;
revoke all on function public.hs_add_expense_v2(text, text, bigint, uuid, uuid[], uuid, jsonb) from public;
revoke all on function public.hs_update_expense_v2(text, uuid, text, bigint, uuid, uuid[], jsonb) from public;
grant execute on function public.hs_add_expense_v2(text, text, bigint, uuid, uuid[], uuid, jsonb) to anon, authenticated;
grant execute on function public.hs_update_expense_v2(text, uuid, text, bigint, uuid, uuid[], jsonb) to anon, authenticated;

-- Tell PostgREST to pick up the new functions right away.
notify pgrst, 'reload schema';


-- Clerk account security is installed last.
-- Clerk replaces Supabase Auth; keep Supabase as the database.
-- Run after exact splits (001). Works with or without the previous 002 migration.
alter table public.hs_trips add column if not exists owner_id text;
alter table public.hs_members add column if not exists user_id text;
create table if not exists public.hs_profiles (
  user_id text primary key,
  name text not null check(char_length(name) between 1 and 24),
  upi text,
  updated_at timestamptz not null default now()
);
-- Preserve old account mappings for administrator-assisted relinking.
create table if not exists public.hs_auth_migration_backup (
  kind text not null, record_id text not null, old_user_id text not null,
  saved_at timestamptz not null default now(), primary key(kind,record_id)
);
alter table public.hs_auth_migration_backup enable row level security;
revoke all on public.hs_auth_migration_backup from public,anon,authenticated;
insert into public.hs_auth_migration_backup(kind,record_id,old_user_id)
  select 'owner',id::text,owner_id::text from public.hs_trips where owner_id is not null and owner_id::text !~ '^user_'
  on conflict do nothing;
insert into public.hs_auth_migration_backup(kind,record_id,old_user_id)
  select 'member',id::text,user_id::text from public.hs_members where user_id is not null and user_id::text !~ '^user_'
  on conflict do nothing;
-- Remove only obsolete foreign keys on identity columns. Clerk does not populate auth.users.
do $$ declare c record; begin
  for c in select conrelid::regclass as tbl,conname from pg_constraint
    where contype='f' and conrelid in ('public.hs_trips'::regclass,'public.hs_members'::regclass,'public.hs_profiles'::regclass)
      and confrelid='auth.users'::regclass
  loop execute format('alter table %s drop constraint %I',c.tbl,c.conname); end loop;
end $$;
alter table public.hs_trips alter column owner_id type text using owner_id::text;
alter table public.hs_members alter column user_id type text using user_id::text;
alter table public.hs_profiles alter column user_id type text using user_id::text;
-- Never link accounts by matching names/emails between identity providers.
update public.hs_trips set owner_id=null,version=version+1 where owner_id is not null and owner_id !~ '^user_';
update public.hs_members set user_id=null where user_id is not null and user_id !~ '^user_';
create unique index if not exists hs_members_trip_user on public.hs_members(trip_id,user_id) where user_id is not null;
create index if not exists hs_members_user on public.hs_members(user_id);
alter table public.hs_profiles enable row level security;
revoke all on public.hs_profiles from public,anon,authenticated;
drop function if exists public.hs__user();
drop function if exists public.hs_link_member(text,uuid,text);

-- Supabase validates the Clerk JWT before executing these functions.
-- Clerk IDs are strings, so public.hs__user() (UUID) must not be used.
create or replace function public.hs__user() returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_user text := auth.jwt()->>'sub';
begin
  if v_user is null or v_user !~ '^user_[A-Za-z0-9]+$' then
    raise exception 'sign_in_required' using errcode = 'PT401';
  end if;
  return v_user;
end $$;

create or replace function public.hs__owner(p_trip uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.hs_trips where id=p_trip and owner_id=public.hs__user());
$$;
create or replace function public.hs__me(p_trip uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.hs_members where trip_id=p_trip and user_id=public.hs__user();
$$;


create or replace function public.hs__trip(p_token text)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare v_id uuid;
begin
  perform public.hs__user();
  if p_token is null or char_length(p_token) not between 24 and 64 then
    raise exception 'trip_not_found' using errcode = 'PT404';
  end if;
  select t.id into v_id from public.hs_trips t where t.token = p_token;
  if v_id is null then
    raise exception 'trip_not_found' using errcode = 'PT404';
  end if;
  if (select owner_id from public.hs_trips where id=v_id) is null then
    raise exception 'legacy_group_locked' using errcode = 'PT403';
  end if;
  if public.hs__me(v_id) is null then raise exception 'not_a_member' using errcode = 'PT403'; end if;
  return v_id;
end $$;


create or replace function public.hs_get_profile() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_user text := public.hs__user();
begin
  return (select jsonb_build_object('name', name, 'upi', upi) from public.hs_profiles where user_id=v_user);
end $$;
create or replace function public.hs_save_profile(p_name text, p_upi text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_user text := public.hs__user(); v_name text := public.hs__clean_name(p_name,24);
  v_upi text := public.hs__clean_upi(p_upi); v_trip uuid;
begin
  insert into public.hs_profiles(user_id,name,upi) values(v_user,v_name,v_upi)
    on conflict(user_id) do update set name=excluded.name,upi=excluded.upi,updated_at=now();
  update public.hs_members set upi=v_upi where user_id=v_user;
  for v_trip in select trip_id from public.hs_members where user_id=v_user loop
    perform public.hs__touch(v_trip);
  end loop;
  return public.hs_get_profile();
end $$;
create or replace function public.hs_my_groups() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_user text := public.hs__user();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('token',t.token,'name',t.name,'me',m.id,
      'people',(select count(*) from public.hs_members where trip_id=t.id), 'opened',extract(epoch from t.updated_at)*1000)
      order by t.updated_at desc)
    from public.hs_members m join public.hs_trips t on t.id=m.trip_id
    where m.user_id=v_user and t.owner_id is not null),'[]'::jsonb);
end $$;
-- An invite only reveals a group name and count, never its financial data or UPI IDs.
create or replace function public.hs_invite_info(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_trip public.hs_trips; v_user text := public.hs__user();
begin
  select * into v_trip from public.hs_trips where token=p_token;
  if not found then raise exception 'trip_not_found' using errcode = 'PT404'; end if;
  if v_trip.owner_id is null then raise exception 'legacy_group_locked' using errcode = 'PT403'; end if;
  return jsonb_build_object('trip',jsonb_build_object('name',v_trip.name),
    'people',(select count(*) from public.hs_members where trip_id=v_trip.id));
end $$;


create or replace function public.hs_create_trip(p_name text, p_member_name text, p_member_upi text default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_token  text := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');
  v_name   text := public.hs__clean_name(p_name, 60);
  v_member text := public.hs__clean_name(p_member_name, 24);
  v_upi    text := public.hs__clean_upi(p_member_upi);
  v_trip   uuid;
  v_mid    uuid;
begin
  perform public.hs__user();
  insert into public.hs_trips (token, name, owner_id) values (v_token, v_name, public.hs__user()) returning id into v_trip;
  insert into public.hs_members (trip_id, name, upi, position, user_id)
  values (v_trip, v_member, v_upi, 1, public.hs__user()) returning id into v_mid;
  return jsonb_build_object('token', v_token, 'trip_id', v_trip, 'member_id', v_mid);
end $$;

create or replace function public.hs_join_trip(p_token text, p_name text, p_upi text default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_trip uuid;
  v_name text := public.hs__clean_name(p_name, 24);
  v_upi  text := public.hs__clean_upi(p_upi);
  v_pos  int;
  v_mid  uuid;
begin
  perform public.hs_invite_info(p_token);
  select id into v_trip from public.hs_trips where token=p_token;
  perform 1 from public.hs_trips where id = v_trip for update;  -- serialise joins per trip
  select id into v_mid from public.hs_members where trip_id=v_trip and user_id=public.hs__user();
  if v_mid is not null then return jsonb_build_object('member_id',v_mid,'version',(select version from public.hs_trips where id=v_trip)); end if;
  if (select count(*) from public.hs_members where trip_id = v_trip) >= 30 then
    raise exception 'trip_full' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.hs_members where trip_id = v_trip and lower(name) = lower(v_name)) then
    raise exception 'name_taken' using errcode = 'PT409';
  end if;
  select coalesce(max(position), 0) + 1 into v_pos from public.hs_members where trip_id = v_trip;
  insert into public.hs_members (trip_id, name, upi, position, user_id)
  values (v_trip, v_name, v_upi, v_pos, public.hs__user()) returning id into v_mid;
  return jsonb_build_object('member_id', v_mid, 'version', public.hs__touch(v_trip));
end $$;

create or replace function public.hs_get_trip(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_trip uuid := public.hs__trip(p_token);
begin
  return (
    select jsonb_build_object(
      'trip', jsonb_build_object('id', t.id, 'name', t.name, 'version', t.version,
                                 'created_at', t.created_at, 'updated_at', t.updated_at, 'is_owner', public.hs__owner(t.id), 'me', public.hs__me(t.id)),
      'members', coalesce((
        select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'upi', m.upi,
                                            'position', m.position, 'linked', m.user_id is not null) order by m.position)
        from public.hs_members m where m.trip_id = t.id), '[]'::jsonb),
      'expenses', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id', e.id, 'title', e.title, 'amount_paise', e.amount_paise,
                 'paid_by', e.paid_by, 'created_by', e.created_by, 'shares', e.shares,
                 'split', coalesce((select jsonb_agg(s.member_id) from public.hs_expense_shares s
                                    where s.expense_id = e.id), '[]'::jsonb),
                 'created_at', e.created_at, 'updated_at', e.updated_at)
               order by e.created_at desc, e.id)
        from public.hs_expenses e where e.trip_id = t.id), '[]'::jsonb),
      'payments', coalesce((
        select jsonb_agg(jsonb_build_object('id', p.id, 'from', p.from_member, 'to', p.to_member,
                                            'amount_paise', p.amount_paise, 'created_at', p.created_at)
               order by p.created_at desc, p.id)
        from public.hs_payments p where p.trip_id = t.id), '[]'::jsonb)
    )
    from public.hs_trips t where t.id = v_trip
  );
end $$;

create or replace function public.hs_rename_trip(p_token text, p_name text)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare v_trip uuid := public.hs__trip(p_token);
begin
  if not public.hs__owner(v_trip) then raise exception 'forbidden' using errcode = 'PT403'; end if;
  update public.hs_trips set name = public.hs__clean_name(p_name, 60) where id = v_trip;
  return public.hs__touch(v_trip);
end $$;

create or replace function public.hs_remove_member(p_token text, p_member uuid)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare v_trip uuid := public.hs__trip(p_token);
begin
  if not public.hs__owner(v_trip) then raise exception 'forbidden' using errcode = 'PT403'; end if;
  if p_member=public.hs__me(v_trip) then raise exception 'forbidden' using errcode = 'PT403'; end if;
  perform public.hs__member_in_trip(v_trip, p_member);
  if exists (select 1 from public.hs_expenses where paid_by = p_member)
     or exists (select 1 from public.hs_expense_shares where member_id = p_member)
     or exists (select 1 from public.hs_payments where from_member = p_member or to_member = p_member) then
    raise exception 'member_has_activity' using errcode = 'PT409';
  end if;
  update public.hs_expenses set created_by = null where created_by = p_member;
  delete from public.hs_members where id = p_member;
  return public.hs__touch(v_trip);
end $$;

create or replace function public.hs_update_member(p_token text, p_member uuid, p_name text, p_upi text default null)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_trip uuid := public.hs__trip(p_token);
  v_name text := public.hs__clean_name(p_name, 24);
begin
  if p_member is distinct from public.hs__me(v_trip) then
    raise exception 'forbidden' using errcode = 'PT403';
  end if;
  perform public.hs__member_in_trip(v_trip, p_member);
  if exists (select 1 from public.hs_members
             where trip_id = v_trip and id <> p_member and lower(name) = lower(v_name)) then
    raise exception 'name_taken' using errcode = 'PT409';
  end if;
  update public.hs_members set name = v_name, upi = public.hs__clean_upi(p_upi) where id = p_member;
  return public.hs__touch(v_trip);
end $$;

create or replace function public.hs_add_expense(
  p_token text, p_title text, p_amount_paise bigint, p_paid_by uuid, p_split uuid[], p_actor uuid default null
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_trip  uuid := public.hs__trip(p_token);
  v_title text := public.hs__clean_name(p_title, 60);
  v_split uuid[];
  v_id    uuid;
begin
  v_split := public.hs__check_expense(v_trip, v_title, p_amount_paise, p_paid_by, p_split);
  if p_actor is not null and p_actor is distinct from public.hs__me(v_trip) then
    raise exception 'forbidden' using errcode = 'PT403';
  end if;
  if (select count(*) from public.hs_expenses where trip_id = v_trip) >= 500 then
    raise exception 'trip_full' using errcode = 'PT409';
  end if;
  insert into public.hs_expenses (trip_id, title, amount_paise, paid_by, created_by)
  values (v_trip, v_title, p_amount_paise, p_paid_by, public.hs__me(v_trip)) returning id into v_id;
  insert into public.hs_expense_shares (expense_id, member_id) select v_id, unnest(v_split);
  return jsonb_build_object('id', v_id, 'version', public.hs__touch(v_trip));
end $$;

create or replace function public.hs_update_expense(
  p_token text, p_expense uuid, p_title text, p_amount_paise bigint, p_paid_by uuid, p_split uuid[]
)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_trip  uuid := public.hs__trip(p_token);
  v_title text := public.hs__clean_name(p_title, 60);
  v_split uuid[];
begin
  if not public.hs__owner(v_trip) and not exists (
    select 1 from public.hs_expenses where id=p_expense and trip_id=v_trip and created_by=public.hs__me(v_trip)
  ) then raise exception 'forbidden' using errcode = 'PT403'; end if;
  if not exists (select 1 from public.hs_expenses where id = p_expense and trip_id = v_trip) then
    raise exception 'expense_not_found' using errcode = 'PT404';
  end if;
  v_split := public.hs__check_expense(v_trip, v_title, p_amount_paise, p_paid_by, p_split);
  update public.hs_expenses
     set title = v_title, amount_paise = p_amount_paise, paid_by = p_paid_by, shares = null, updated_at = now()
   where id = p_expense;
  delete from public.hs_expense_shares where expense_id = p_expense;
  insert into public.hs_expense_shares (expense_id, member_id) select p_expense, unnest(v_split);
  return public.hs__touch(v_trip);
end $$;

create or replace function public.hs_delete_expense(p_token text, p_expense uuid)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare v_trip uuid := public.hs__trip(p_token);
begin
  if not public.hs__owner(v_trip) and not exists (
    select 1 from public.hs_expenses where id=p_expense and trip_id=v_trip and created_by=public.hs__me(v_trip)
  ) then raise exception 'forbidden' using errcode = 'PT403'; end if;
  delete from public.hs_expenses where id = p_expense and trip_id = v_trip;
  if not found then
    raise exception 'expense_not_found' using errcode = 'PT404';
  end if;
  return public.hs__touch(v_trip);
end $$;

create or replace function public.hs_record_payment(p_token text, p_from uuid, p_to uuid, p_amount_paise bigint)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_trip uuid := public.hs__trip(p_token);
  v_id   uuid;
begin
  if not public.hs__owner(v_trip) and public.hs__me(v_trip) not in (p_from,p_to) then
    raise exception 'forbidden' using errcode = 'PT403';
  end if;
  perform public.hs__member_in_trip(v_trip, p_from);
  perform public.hs__member_in_trip(v_trip, p_to);
  if p_from = p_to then
    raise exception 'same_member' using errcode = 'PT400';
  end if;
  if p_amount_paise is null or p_amount_paise <= 0 or p_amount_paise > 1000000000 then
    raise exception 'bad_amount' using errcode = 'PT400';
  end if;
  if (select count(*) from public.hs_payments where trip_id = v_trip) >= 500 then
    raise exception 'trip_full' using errcode = 'PT409';
  end if;
  insert into public.hs_payments (trip_id, from_member, to_member, amount_paise)
  values (v_trip, p_from, p_to, p_amount_paise) returning id into v_id;
  return jsonb_build_object('id', v_id, 'version', public.hs__touch(v_trip));
end $$;

create or replace function public.hs_delete_payment(p_token text, p_payment uuid)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare v_trip uuid := public.hs__trip(p_token);
begin
  if not public.hs__owner(v_trip) and not exists (
    select 1 from public.hs_payments where id=p_payment and trip_id=v_trip
      and public.hs__me(v_trip) in (from_member,to_member)
  ) then raise exception 'forbidden' using errcode = 'PT403'; end if;
  delete from public.hs_payments where id = p_payment and trip_id = v_trip;
  if not found then
    raise exception 'payment_not_found' using errcode = 'PT404';
  end if;
  return public.hs__touch(v_trip);
end $$;


-- Owners can link only unclaimed legacy member rows to an existing Clerk account ID shared by the intended member.
create or replace function public.hs_link_member(p_token text,p_member uuid,p_account text) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare v_trip uuid := public.hs__trip(p_token); v_user text;
begin
  if not public.hs__owner(v_trip) then raise exception 'forbidden' using errcode = 'PT403'; end if;
  select user_id into v_user from public.hs_profiles where user_id=btrim(p_account) and user_id ~ '^user_[A-Za-z0-9]+$';
  if v_user is null then raise exception 'account_not_found' using errcode = 'PT400'; end if;
  perform 1 from public.hs_trips where id=v_trip for update;
  if exists(select 1 from public.hs_members where trip_id=v_trip and user_id=v_user) then
    raise exception 'account_already_linked' using errcode = 'PT409';
  end if;
  update public.hs_members set user_id=v_user,
    upi=(select upi from public.hs_profiles where user_id=v_user)
    where id=p_member and trip_id=v_trip and user_id is null;
  if not found then raise exception 'forbidden' using errcode = 'PT403'; end if;
  return public.hs__touch(v_trip);
end $$;
-- Revoke historical anonymous grants and default Supabase function grants.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and left(p.proname,3)='hs_'
  loop
    execute format('revoke all on function %s from public, anon, authenticated',f.sig);
    if f.proname in ('hs_get_profile','hs_save_profile','hs_my_groups','hs_invite_info','hs_link_member',
      'hs_create_trip','hs_get_trip','hs_trip_version','hs_rename_trip','hs_join_trip','hs_update_member','hs_remove_member',
      'hs_add_expense','hs_update_expense','hs_add_expense_v2','hs_update_expense_v2','hs_delete_expense','hs_record_payment','hs_delete_payment') then
      execute format('grant execute on function %s to authenticated',f.sig);
    end if;
  end loop;
end $$;
notify pgrst, 'reload schema';

alter table public.hs_profiles add column if not exists upi_qr text;

create or replace function public.hs__ready() returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_user text := public.hs__user();
begin
  if not exists (select 1 from public.hs_profiles where user_id=v_user and upi is not null and upi_qr is not null) then
    raise exception 'payment_profile_required' using errcode = 'PT403';
  end if;
  return v_user;
end $$;
revoke all on function public.hs__ready() from public,anon,authenticated;


create or replace function public.hs__trip(p_token text)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare v_id uuid;
begin
  perform public.hs__ready();
  if p_token is null or char_length(p_token) not between 24 and 64 then
    raise exception 'trip_not_found' using errcode = 'PT404';
  end if;
  select t.id into v_id from public.hs_trips t where t.token = p_token;
  if v_id is null then
    raise exception 'trip_not_found' using errcode = 'PT404';
  end if;
  if (select owner_id from public.hs_trips where id=v_id) is null then
    raise exception 'legacy_group_locked' using errcode = 'PT403';
  end if;
  if public.hs__me(v_id) is null then raise exception 'not_a_member' using errcode = 'PT403'; end if;
  return v_id;
end $$;

create or replace function public.hs_create_trip(p_name text, p_member_name text, p_member_upi text default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_token  text := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');
  v_name   text := public.hs__clean_name(p_name, 60);
  v_member text := public.hs__clean_name(p_member_name, 24);
  v_upi    text;
  v_trip   uuid;
  v_mid    uuid;
begin
  select upi into v_upi from public.hs_profiles where user_id=public.hs__ready();
  insert into public.hs_trips (token, name, owner_id) values (v_token, v_name, public.hs__ready()) returning id into v_trip;
  insert into public.hs_members (trip_id, name, upi, position, user_id)
  values (v_trip, v_member, v_upi, 1, public.hs__ready()) returning id into v_mid;
  return jsonb_build_object('token', v_token, 'trip_id', v_trip, 'member_id', v_mid);
end $$;

create or replace function public.hs_invite_info(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_trip public.hs_trips; v_user text := public.hs__ready();
begin
  select * into v_trip from public.hs_trips where token=p_token;
  if not found then raise exception 'trip_not_found' using errcode = 'PT404'; end if;
  if v_trip.owner_id is null then raise exception 'legacy_group_locked' using errcode = 'PT403'; end if;
  return jsonb_build_object('trip',jsonb_build_object('name',v_trip.name),
    'people',(select count(*) from public.hs_members where trip_id=v_trip.id));
end $$;

create or replace function public.hs_my_groups() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_user text := public.hs__ready();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('token',t.token,'name',t.name,'me',m.id,
      'people',(select count(*) from public.hs_members where trip_id=t.id), 'opened',extract(epoch from t.updated_at)*1000)
      order by t.updated_at desc)
    from public.hs_members m join public.hs_trips t on t.id=m.trip_id
    where m.user_id=v_user and t.owner_id is not null),'[]'::jsonb);
end $$;

create or replace function public.hs_join_trip(p_token text, p_name text, p_upi text default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_trip uuid;
  v_name text := public.hs__clean_name(p_name, 24);
  v_upi  text;
  v_pos  int;
  v_mid  uuid;
begin
  perform public.hs_invite_info(p_token);
  select upi into v_upi from public.hs_profiles where user_id=public.hs__ready();
  select id into v_trip from public.hs_trips where token=p_token;
  perform 1 from public.hs_trips where id = v_trip for update;  -- serialise joins per trip
  select id into v_mid from public.hs_members where trip_id=v_trip and user_id=public.hs__user();
  if v_mid is not null then return jsonb_build_object('member_id',v_mid,'version',(select version from public.hs_trips where id=v_trip)); end if;
  if (select count(*) from public.hs_members where trip_id = v_trip) >= 30 then
    raise exception 'trip_full' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.hs_members where trip_id = v_trip and lower(name) = lower(v_name)) then
    raise exception 'name_taken' using errcode = 'PT409';
  end if;
  select coalesce(max(position), 0) + 1 into v_pos from public.hs_members where trip_id = v_trip;
  insert into public.hs_members (trip_id, name, upi, position, user_id)
  values (v_trip, v_name, v_upi, v_pos, public.hs__user()) returning id into v_mid;
  return jsonb_build_object('member_id', v_mid, 'version', public.hs__touch(v_trip));
end $$;

create or replace function public.hs_update_member(p_token text, p_member uuid, p_name text, p_upi text default null)
returns bigint
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_trip uuid := public.hs__trip(p_token);
  v_name text := public.hs__clean_name(p_name, 24);
begin
  if p_member is distinct from public.hs__me(v_trip) then
    raise exception 'forbidden' using errcode = 'PT403';
  end if;
  perform public.hs__member_in_trip(v_trip, p_member);
  if exists (select 1 from public.hs_members
             where trip_id = v_trip and id <> p_member and lower(name) = lower(v_name)) then
    raise exception 'name_taken' using errcode = 'PT409';
  end if;
  update public.hs_members set name = v_name, upi = (select upi from public.hs_profiles where user_id=public.hs__ready()) where id = p_member;
  return public.hs__touch(v_trip);
end $$;

create or replace function public.hs_get_profile() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_user text := public.hs__user();
begin
  return (select jsonb_build_object('name', name, 'upi', upi, 'upi_qr', upi_qr) from public.hs_profiles where user_id=v_user);
end $$;


-- Replace the old save endpoint so a complete profile cannot be cleared.
revoke all on function public.hs_save_profile(text,text) from public,anon,authenticated;

create or replace function public.hs_save_payment_profile(p_name text,p_upi text,p_upi_qr text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_user text := public.hs__user();
  v_name text := public.hs__clean_name(p_name,24);
  v_upi text := public.hs__clean_upi(p_upi);
  v_qr text := p_upi_qr;
  v_trip uuid;
begin
  if v_upi is null then raise exception 'bad_upi' using errcode = 'PT400'; end if;
  if v_qr is null then
    select upi_qr into v_qr from public.hs_profiles where user_id=v_user and upi=v_upi for update;
  end if;
  if v_qr is null or length(v_qr) > 350000 or v_qr !~ '^iVBORw0KGgo[A-Za-z0-9+/]+={0,2}$'
      or length(v_qr) % 4 <> 0 then
    raise exception 'bad_qr' using errcode = 'PT400';
  end if;
  insert into public.hs_profiles(user_id,name,upi,upi_qr) values(v_user,v_name,v_upi,v_qr)
    on conflict(user_id) do update set name=excluded.name,upi=excluded.upi,upi_qr=excluded.upi_qr,updated_at=now();
  update public.hs_members set upi=v_upi where user_id=v_user;
  for v_trip in select trip_id from public.hs_members where user_id=v_user order by trip_id loop
    perform public.hs__touch(v_trip);
  end loop;
  return public.hs_get_profile();
end $$;

create or replace function public.hs_member_payment_qr(p_token text,p_member uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_trip uuid := public.hs__trip(p_token);
begin
  return (select p.upi_qr from public.hs_members m join public.hs_profiles p on p.user_id=m.user_id
    where m.trip_id=v_trip and m.id=p_member and p.upi=m.upi);
end $$;

revoke all on function public.hs_save_payment_profile(text,text,text),public.hs_member_payment_qr(text,uuid) from public,anon,authenticated;
grant execute on function public.hs_save_payment_profile(text,text,text),public.hs_member_payment_qr(text,uuid) to authenticated;
notify pgrst, 'reload schema';


create table if not exists public.hs_site_admins (
  user_id text primary key check (user_id ~ '^user_[A-Za-z0-9]+$')
);
create table if not exists public.hs_site_activity (
  user_id text not null,
  active_on date not null,
  primary key (user_id, active_on)
);
create index if not exists hs_site_activity_date_idx on public.hs_site_activity(active_on);
alter table public.hs_site_admins enable row level security;
alter table public.hs_site_activity enable row level security;
revoke all on public.hs_site_admins, public.hs_site_activity from public, anon, authenticated;

create or replace function public.hs_record_site_activity() returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.hs_site_activity (user_id, active_on)
  values (public.hs__user(), (now() at time zone 'UTC')::date)
  on conflict do nothing;
$$;

create or replace function public.hs_admin_activity(p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user text := public.hs__user();
  v_today date := (now() at time zone 'UTC')::date;
begin
  if not exists (select 1 from public.hs_site_admins where user_id = v_user) then
    raise exception 'forbidden' using errcode = 'PT403';
  end if;
  if p_offset is null or p_offset < 0 then
    raise exception 'invalid_page' using errcode = 'PT400';
  end if;

  return (
    with usage as (
      select user_id, max(active_on) as last_active,
        count(*) filter (where active_on >= v_today - 29) as days
      from public.hs_site_activity
      group by user_id
    ), known_users as (
      select user_id, name, last_active, coalesce(days, 0) as days
      from usage full join public.hs_profiles using (user_id)
    ), page as (
      select name, last_active, days
      from known_users
      order by last_active desc nulls last, user_id
      limit 25 offset p_offset
    ), leaders as (
      select name, last_active, days
      from known_users
      where days > 0
      order by days desc, last_active desc, user_id
      limit 10
    )
    select jsonb_build_object(
      'total', (select count(*) from known_users),
      'active_today', (select count(*) from usage where last_active = v_today),
      'active_30_days', (select count(*) from usage where days > 0),
      'users', coalesce((select jsonb_agg(to_jsonb(page) order by last_active desc nulls last) from page), '[]'::jsonb),
      'top', coalesce((select jsonb_agg(to_jsonb(leaders) order by days desc, last_active desc) from leaders), '[]'::jsonb)
    )
  );
end $$;

revoke all on function public.hs_record_site_activity(), public.hs_admin_activity(integer) from public, anon, authenticated;
grant execute on function public.hs_record_site_activity(), public.hs_admin_activity(integer) to authenticated;
notify pgrst, 'reload schema';
commit;
