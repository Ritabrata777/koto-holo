import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('account migration enforces membership and permissions for old and new RPCs', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated;
      create schema auth;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create schema extensions;
      create function extensions.gen_random_bytes(n int) returns bytea language sql as $$
        select substring(decode(replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),'hex') from 1 for n)
      $$;`);
    const schema = await readFile(new URL('../schema.sql',import.meta.url),'utf8');
    const baseline = schema.slice(0, schema.lastIndexOf('alter table public.hs_profiles add column if not exists upi_qr')) + '\ncommit;';
    await db.exec(baseline);
    await db.exec(await readFile(new URL('../migrations/003_clerk.sql',import.meta.url),'utf8'));
    const users = ['user_Owner','user_Member','user_Third','user_Stranger'];
    async function as(user, name, args={}) {
      await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify(user ? {sub:user,role:'authenticated'} : {})]);
      await db.exec(`set role ${user ? 'authenticated' : 'anon'}`);
      try {
        const keys=Object.keys(args);
        return (await db.query(`select public.${name}(${keys.map((key,i)=>`${key} => $${i+1}`).join(',')}) result`,Object.values(args))).rows[0].result;
      } finally { await db.exec('reset role'); }
    }
    const owner=users[0], member=users[1], third=users[2], stranger=users[3];
    await assert.rejects(as(null,'hs_create_trip',{p_name:'No',p_member_name:'Anon'}),/permission denied/);
    await as(owner,'hs_save_profile',{p_name:'Owner',p_upi:'owner@upi'});
    assert.equal((await as(owner,'hs_get_profile')).upi,'owner@upi');
    assert.equal(await as(member,'hs_get_profile'),null);
    await as(member,'hs_save_profile',{p_name:'Member'});
    const group=await as(owner,'hs_create_trip',{p_name:'Trip',p_member_name:'Owner',p_member_upi:'owner@upi'});
    const token={p_token:group.token};
    await assert.rejects(as(null,'hs_get_trip',token),/permission denied/);
    await assert.rejects(as(stranger,'hs_get_trip',token),/not_a_member/);
    assert.deepEqual(Object.keys(await as(stranger,'hs_invite_info',token)).sort(),['people','trip']);
    const joined=await as(member,'hs_join_trip',{...token,p_name:'Member'});
    const thirdJoined=await as(third,'hs_join_trip',{...token,p_name:'Third'});
    assert.equal((await as(member,'hs_join_trip',{...token,p_name:'Again'})).member_id,joined.member_id);
    assert.equal((await as(member,'hs_my_groups'))[0].me,joined.member_id);
    assert.equal((await as(owner,'hs_get_trip',token)).trip.is_owner,true);
    assert.equal((await as(member,'hs_get_trip',token)).trip.is_owner,false);
    await assert.rejects(as(member,'hs_update_member',{...token,p_member:group.member_id,p_name:'Hijack',p_upi:'bad@upi'}),/forbidden/);
    await assert.rejects(as(member,'hs_rename_trip',{...token,p_name:'Hijack'}),/forbidden/);
    await assert.rejects(as(owner,'hs_remove_member',{...token,p_member:group.member_id}),/forbidden/);
    const expense={...token,p_title:'Dinner',p_amount_paise:10000,p_paid_by:group.member_id,p_split:[group.member_id,joined.member_id]};
    await assert.rejects(as(member,'hs_add_expense',{...expense,p_actor:group.member_id}),/forbidden/);
    const added=await as(member,'hs_add_expense_v2',{...expense,p_shares:{[group.member_id]:2000,[joined.member_id]:8000}});
    let data=await as(owner,'hs_get_trip',token);
    assert.equal(data.expenses[0].created_by,joined.member_id);
    const update={...expense,p_expense:added.id};
    await assert.rejects(as(third,'hs_update_expense',update),/forbidden/);
    await assert.rejects(as(third,'hs_update_expense_v2',{...update,p_shares:null}),/forbidden/);
    await assert.rejects(as(third,'hs_delete_expense',{...token,p_expense:added.id}),/forbidden/);
    await assert.rejects(as(stranger,'hs_add_expense',expense),/not_a_member/);
    await as(member,'hs_update_expense_v2',{...update,p_shares:{[group.member_id]:2000,[joined.member_id]:8000}});
    const payment={...token,p_from:joined.member_id,p_to:group.member_id,p_amount_paise:2000};
    await assert.rejects(as(third,'hs_record_payment',payment),/forbidden/);
    const paid=await as(member,'hs_record_payment',payment);
    await assert.rejects(as(third,'hs_delete_payment',{...token,p_payment:paid.id}),/forbidden/);
    await as(owner,'hs_delete_payment',{...token,p_payment:paid.id});
    await as(owner,'hs_save_profile',{p_name:'Owner profile',p_upi:'newowner@upi'});
    data=await as(member,'hs_get_trip',token);
    assert.equal(data.members.find(m=>m.id===group.member_id).upi,'newowner@upi');
    await as(owner,'hs_delete_expense',{...token,p_expense:added.id});
    await assert.rejects(as(member,'hs__trip',token),/permission denied/);
    await assert.rejects(as(member,'hs__check_shares',{p_shares:null,p_split:[],p_amount:1}),/permission denied/);
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select * from hs_profiles'),/permission denied/);
    await assert.rejects(db.query('update hs_members set user_id=gen_random_uuid()'),/permission denied/);
    await db.exec('reset role');
    // Old groups cannot be claimed using an invite or browser-stored member id.
    const legacy=(await db.query("insert into hs_trips(token,name) values('legacy-token-12345678901234567890','Legacy') returning id")).rows[0].id;
    const legacyMember=(await db.query("insert into hs_members(trip_id,name,position) values($1,'Old owner',1) returning id",[legacy])).rows[0].id;
    const legacyOther=(await db.query("insert into hs_members(trip_id,name,position) values($1,'Old member',2) returning id",[legacy])).rows[0].id;
    const legacyToken={p_token:'legacy-token-12345678901234567890'};
    await assert.rejects(as(owner,'hs_join_trip',{...legacyToken,p_name:'Takeover'}),/legacy_group_locked/);
    await assert.rejects(as(owner,'hs_get_trip',legacyToken),/legacy_group_locked/);
    await db.query('update hs_trips set owner_id=$1 where id=$2',[owner,legacy]);
    await db.query('update hs_members set user_id=$1 where id=$2',[owner,legacyMember]);
    await as(owner,'hs_link_member',{...legacyToken,p_member:legacyOther,p_account:member});
    assert.equal((await as(member,'hs_get_trip',legacyToken)).trip.me,legacyOther);
    await as(stranger,'hs_save_profile',{p_name:'Stranger'});
    await assert.rejects(as(owner,'hs_link_member',{...legacyToken,p_member:legacyOther,p_account:stranger}),/forbidden/);
    // Rerunning the older migration must not reopen anonymous access.
    await assert.rejects(db.exec(await readFile(new URL('../migrations/001_exact_splits.sql',import.meta.url),'utf8')),/Accounts are already installed/);
    await db.exec('rollback');
    await assert.rejects(as(null,'hs_get_trip',token),/permission denied/);
    await assert.rejects(as('00000000-0000-0000-0000-000000000001','hs_get_profile'),/sign_in_required/);
  } finally { await db.close(); }
});

test('Clerk migration upgrades prior UUID accounts without guessing account ownership', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;`);
    const schema=await readFile(new URL('../schema.sql',import.meta.url),'utf8');
    await db.exec(schema.slice(0,schema.indexOf('-- Clerk account security is installed last.'))+'\ncommit;');
    await db.exec(await readFile(new URL('../migrations/002_accounts.sql',import.meta.url),'utf8'));
    const old=(await db.query("insert into auth.users values(gen_random_uuid(),'old@test.invalid',now()) returning id")).rows[0].id;
    const group=(await db.query("insert into hs_trips(token,name,owner_id) values('old-identity-group-123456789012','Old group',$1) returning id",[old])).rows[0].id;
    await db.query("insert into hs_members(trip_id,name,position,user_id) values($1,'Old owner',1,$2)",[group,old]);
    await db.query("insert into hs_profiles(user_id,name,upi) values($1,'Old owner','old@upi')",[old]);
    const migration=await readFile(new URL('../migrations/003_clerk.sql',import.meta.url),'utf8');
    await db.exec(migration);
    await db.exec(migration);
    assert.equal((await db.query('select owner_id from hs_trips where id=$1',[group])).rows[0].owner_id,null);
    assert.equal((await db.query('select user_id from hs_members where trip_id=$1',[group])).rows[0].user_id,null);
    assert.equal((await db.query('select count(*)::int as n from hs_auth_migration_backup')).rows[0].n,2);
    assert.equal((await db.query('select upi from hs_profiles where user_id=$1',[old])).rows[0].upi,'old@upi');
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select * from hs_auth_migration_backup'),/permission denied/);
    await db.exec('reset role');
    await assert.rejects(db.exec(await readFile(new URL('../migrations/002_accounts.sql',import.meta.url),'utf8')),/Clerk accounts are already installed/);
    await db.exec('rollback');
  } finally {await db.close();}
});
