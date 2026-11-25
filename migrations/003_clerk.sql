-- Clerk replaces Supabase Auth; keep Supabase as the database.
-- Run after exact splits (001). Works with or without the previous 002 migration.
begin;
do $$ begin
  if exists(select 1 from information_schema.columns where table_schema='public' and table_name='hs_profiles' and column_name='upi_qr') then
    raise exception 'Payment profiles are installed; use migration 004 or the full current schema.';
  end if;
end $$;
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
commit;
