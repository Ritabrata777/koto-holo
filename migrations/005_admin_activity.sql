begin;

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
