begin;
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
commit;
