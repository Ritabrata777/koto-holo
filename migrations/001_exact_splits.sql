begin;
do $$ begin
  if exists(select 1 from information_schema.columns where table_schema='public' and table_name='hs_trips' and column_name='owner_id') then
    raise exception 'Accounts are already installed. Do not rerun migration 001; use the current schema or migration 002.';
  end if;
end $$;
alter table public.hs_expenses add column if not exists shares jsonb;
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

notify pgrst, 'reload schema';
commit;
