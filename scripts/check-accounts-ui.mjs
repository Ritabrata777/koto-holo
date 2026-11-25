import { chromium } from 'playwright';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { SUPABASE_URL } from '../config.js';

// This check intercepts all Auth/RPC calls. It never changes the hosted database
// or sends email. Start `npm run serve` before running it.
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
 create schema extensions;
 create function extensions.gen_random_bytes(n int) returns bytea language sql as $$ select substring(decode(replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''),'hex') from 1 for n) $$;`);
await db.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
const users=[];
for(let i=0;i<3;i++) users.push({id:`user_Test${i}`,email:`person${i}@test.invalid`});
let queue=Promise.resolve();
function rpc(user,name,args={}) {
 const run=queue.then(async()=>{
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user.id,role:'authenticated'})]);
  await db.exec('set role authenticated');
  try {const keys=Object.keys(args);return (await db.query(`select public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) result`,Object.values(args))).rows[0].result;}
  finally {await db.exec('reset role');}
 });
 queue=run.catch(()=>{});return run;
}
function sessionFor(user) {
 const claims={sub:user.id,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600};
 const jwt=Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.test-signature';
 return {access_token:jwt,refresh_token:'test-refresh',expires_at:claims.exp,expires_in:3600,token_type:'bearer',user:{...user,aud:'authenticated',role:'authenticated',user_metadata:{},app_metadata:{provider:'email'}}};
}
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'msedge',headless:true});
const errors=[];
const key='test.clerk.user';
async function contextFor(user=null) {
 const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
 if(user) await context.addInitScript(({key,user})=>localStorage.setItem(key,JSON.stringify(user)),{key,user});
 await context.route('**/npm/@clerk/ui@1/dist/ui.browser.js',route=>route.fulfill({contentType:'text/javascript',body:'window.__internal_ClerkUICtor = class {}'}));
 await context.route('**/assets/vendor/clerk.js',route=>route.fulfill({contentType:'text/javascript',body:`
 export class Clerk {
   constructor(key) { this.listeners=[];this.user=null;this.session=null; }
   async load() { this.setUser(JSON.parse(localStorage.getItem('test.clerk.user') || 'null')); }
   setUser(user, staleGetters=false) {
     const nextUser=user ? {id:user.id,fullName:'',primaryEmailAddress:{emailAddress:user.email}} : null;
     const nextSession=user ? {status:'active',user:nextUser,getToken:async()=> {
       const claims={sub:user.id,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600};
       return btoa('{}')+'.'+btoa(JSON.stringify(claims))+'.test';
     }} : null;
     if (!staleGetters) {this.session=nextSession;this.user=nextUser;}
     for(const fn of this.listeners) fn({session:nextSession,user:nextUser});
   }
   addListener(fn) {this.listeners.push(fn);fn({session:this.session,user:this.user});return ()=>{};}
   async openSignIn(options) {
     if(options.forceRedirectUrl !== location.origin+location.pathname+'?signed-in=1'+(location.hash.startsWith('#/') ? location.hash : '#/')) throw new Error('Invite destination lost');
     const button=document.createElement('button');button.textContent='Mock Clerk login';button.dataset.testLogin='';
     button.onclick=()=>{const user=${JSON.stringify(users[0])};localStorage.setItem('test.clerk.user',JSON.stringify(user));this.setUser(user,true);button.remove();};
     document.body.append(button);
   }
   async signOut() {localStorage.removeItem('test.clerk.user');this.setUser(null);}
   openUserProfile() {}
 }` }));
 await context.route(SUPABASE_URL+'/**',async route=>{
  const request=route.request();const path=new URL(request.url()).pathname;
  try {
   if(path.includes('/rpc/')) {
    const jwt=request.headers().authorization?.split(' ')[1];
    const sub=JSON.parse(Buffer.from(jwt.split('.')[1],'base64url').toString()).sub;
    const actor=users.find(u=>u.id===sub);assert.ok(actor);
    return await route.fulfill({json:await rpc(actor,path.split('/').at(-1),request.postDataJSON())});
   }
   await route.abort();
  } catch(error) {await route.fulfill({status:403,json:{message:error.message}});}
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));return {context,page};
}
try {
 await assert.rejects(rpc(users[0], 'hs_my_groups'), /payment_profile_required/);
 await assert.rejects(rpc(users[0], 'hs_save_payment_profile', {p_name:'Owner',p_upi:'owner@upi',p_upi_qr:'invalid'}), /bad_qr/);
 const first=await contextFor();const page=first.page;
 await page.goto('http://127.0.0.1:5174/');
 await page.evaluate(() => window.testSameDocument = true);
 await page.locator('[data-clerk-signin]').click();
 await page.locator('[data-test-login]').click();
 await page.locator('[data-profile-form]').waitFor();
 assert.equal(await page.evaluate(() => window.testSameDocument), true);
 await page.locator('[data-profile-form] [name=name]').fill('Owner');
 await page.locator('[data-profile-form] [name=upi]').fill('owner@upi');
 await page.locator('[data-profile-form] button[type=submit]').click();
 await page.getByText('Upload the payment QR for this UPI ID.').waitFor();
 const png = await page.evaluate(async () => {
   const { default: qrcode } = await import('/assets/vendor/qrcode.mjs');
   const qr = qrcode(0, 'M');
   qr.addData('upi://pay?pa=owner@upi&pn=Owner');
   qr.make();
   const bitmap = await createImageBitmap(await (await fetch(qr.createDataURL(6, 24))).blob());
   const canvas = document.createElement('canvas');
   canvas.width = bitmap.width; canvas.height = bitmap.height;
   canvas.getContext('2d').drawImage(bitmap, 0, 0);
   return canvas.toDataURL('image/png').split(',')[1];
 });
 await page.locator('[data-profile-form] [name=upi]').fill('different@upi');
 await page.locator('[data-profile-form] [name=qr]').setInputFiles({name:'upi.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
 await page.locator('[data-profile-form] button[type=submit]').click();
 await page.getByText('The QR points to a different UPI ID.',{exact:false}).waitFor();
 await page.locator('[data-profile-form] [name=upi]').fill('owner@upi');
 await page.locator('[data-profile-form] button[type=submit]').click();
 await page.locator('#create').waitFor();
 assert.equal(await page.locator('#create [name=name]').inputValue(),'Owner');
 await page.locator('#create [name=trip]').fill('Account test');
 await page.locator('#create sakuga-button[type=submit]').click();
 await page.waitForURL(/#\/t\//);
 const token=page.url().split('/t/')[1];
 const group=await rpc(users[0],'hs_get_trip',{p_token:token});
 await page.goto('http://127.0.0.1:5174/#/profile');
 await page.getByRole('link',{name:'Download QR'}).waitFor();
 const downloadPromise=page.waitForEvent('download');
 await page.getByRole('link',{name:'Download QR'}).click();
 assert.equal((await downloadPromise).suggestedFilename(),'koto-holo-upi-qr.png');
 await assert.rejects(rpc(users[0], 'hs_save_payment_profile', {p_name:'Owner',p_upi:'new@upi',p_upi_qr:null}), /bad_qr/);
 await page.locator('[data-profile-form] [name=name]').fill('Updated owner');
 await page.locator('[data-profile-form] button[type=submit]').click();
 await page.getByText('Profile saved.',{exact:true}).waitFor();
 assert.equal((await rpc(users[0], 'hs_get_profile')).name, 'Updated owner');
 await page.screenshot({path:process.env.TEMP+'/kotoholo-profile.png',fullPage:true});
 // The same account sees its group on a completely new device.
 const second=await contextFor(users[0]);
 await second.page.goto('http://127.0.0.1:5174/?signed-in=1#/');
 await second.page.getByRole('link',{name:/Account test/}).waitFor();
 assert.equal(new URL(second.page.url()).search, '');
 // A forged old local member ID cannot become the owner.
 await rpc(users[1],'hs_save_payment_profile',{p_name:'Member',p_upi:'owner@upi',p_upi_qr:png});
 const member=await contextFor(users[1]);
 await member.context.addInitScript(({token,me})=>localStorage.setItem('hisaab.trips.v1',JSON.stringify({[token]:{me}})),{token,me:group.trip.me});
 await member.page.goto(`http://127.0.0.1:5174/#/t/${token}`);
 await member.page.locator('[data-join-account]').waitFor();
 assert.equal(await member.page.locator('body').innerText().then(t=>t.includes('Owner')),false);
 await member.page.locator('[data-join-account] button').click();
 await member.page.getByRole('link',{name:'Add expense'}).waitFor();
 const data=await rpc(users[0],'hs_get_trip',{p_token:token});
 const expense=await rpc(users[0],'hs_add_expense_v2',{p_token:token,p_title:'Owner expense',p_amount_paise:10000,p_paid_by:data.trip.me,p_split:data.members.map(m=>m.id),p_shares:null});
 await member.page.goto(`http://127.0.0.1:5174/#/t/${token}/e/${expense.id}`);
 await member.page.getByText('Only the person who added this expense or the group owner can edit it.').waitFor();
 assert.equal(await member.page.locator('#exform').count(),0);
 await member.page.goto(`http://127.0.0.1:5174/#/t/${token}/settle`);
 await member.page.locator('[data-partial]').waitFor();
 await member.page.locator('[data-qr]').click();
 await member.page.locator('.card-qr .qr img').waitFor();
 await member.page.locator('[data-partial]').click();
 await member.page.locator('[data-payment-form] [name=amount]').fill('20');
 await member.page.locator('[data-payment-form] button[type=submit]').click();
 await member.page.locator('[data-undo]').waitFor();
 assert.equal((await rpc(users[1],'hs_get_trip',{p_token:token})).payments[0].amount_paise,2000);
 assert.equal(await member.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.getByRole('button',{name:'Sign out',exact:true}).click();
 await page.locator('[data-clerk-signin]').waitFor();
 assert.equal(await page.locator('body').innerText().then(t=>t.includes('owner@upi')),false);
 // Only a trusted Clerk account on the database allowlist can read analytics.
 await assert.rejects(rpc(users[1], 'hs_admin_activity'), /forbidden/);
 await db.query('insert into hs_site_admins(user_id) values($1)', [users[0].id]);
 await rpc(users[0], 'hs_record_site_activity');
 await rpc(users[0], 'hs_record_site_activity');
 await db.query("insert into hs_site_activity values ($1, (now() at time zone 'UTC')::date - 1)", [users[0].id]);
 const activity = await rpc(users[0], 'hs_admin_activity');
 assert.equal(activity.top[0].name, 'Updated owner');
 assert.equal(activity.top[0].days, 2);
 assert.equal(activity.active_today, 2);
 await second.page.goto('http://127.0.0.1:5174/admin/');
 await second.page.locator('#admin-top').getByText('Updated owner').waitFor();
 await member.page.goto('http://127.0.0.1:5174/admin/');
 await member.page.getByText('This account does not have admin access.').waitFor();
 assert.equal(await member.page.locator('#admin-report').isVisible(), false);
 assert.equal(await second.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
 assert.deepEqual(errors,[]);
 console.log('Passed: Clerk session adapter, profile/QR download, create/join, new-device groups, forged identity rejected, read-only expense, partial payment, sign-out, administrator-only activity, ranking and mobile layout.');
} finally {await browser.close();await queue;await db.close();}
