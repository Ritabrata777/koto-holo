# Clerk login setup

Koto Holo uses **Clerk for login** and **Supabase for profiles, memberships, expenses and payments**. The app sends the current Clerk session token to Supabase; it does not create a parallel Supabase Auth session.

## 1. Clerk application

The supplied development publishable key is configured in `config.js`. The instance domain is:

`coherent-polliwog-1358.clerk.accounts.dev`

In the Clerk Dashboard, enable Google and your preferred email sign-in method. The current test instance displays Google, Apple, email/username with a password, and a phone option. Turn off extra methods in Clerk if you want only Google and email. The application uses Clerk's built-in sign-in/sign-up dialog and account-management screen.

This is a `pk_test_` development instance. For production, create/configure the Clerk production instance, complete its domain and Google credential setup, and replace `CLERK_PUBLISHABLE_KEY` with its `pk_live_` key. Also update the trusted Clerk domain in Supabase to match. Never place a Clerk secret key in this static app.

## 2. Connect Clerk to Supabase

1. Open Clerk's [Supabase integration](https://dashboard.clerk.com/setup/supabase) and activate it for this Clerk instance. This adds `"role": "authenticated"` to session tokens.
2. In Supabase, open **Authentication → Sign In / Providers → Third-party Auth** (the dashboard may label it **Sign In / Up**).
3. Add **Clerk** and enter the instance domain above. Supabase will validate tokens issued by that instance.
4. If you were already signed in before enabling the integration, sign out and back in to get an updated token.

Do not create the older `supabase` JWT template or share Supabase's JWT signing secret with Clerk. This implementation uses the native third-party integration and ordinary `session.getToken()`.

References: [Supabase's Clerk integration](https://supabase.com/docs/guides/auth/third-party/clerk), [Clerk's integration guide](https://clerk.com/docs/guides/development/integrations/databases/supabase), [Clerk JavaScript setup](https://clerk.com/docs/js-frontend/getting-started/quickstart).

## 3. Run the database migration

For the existing Koto Holo database, create a **new SQL Editor query**, paste the entire [`003_clerk.sql`](../migrations/003_clerk.sql), and run it. It requires the earlier exact-splits schema (001), which is already installed on this project. It works whether or not you ran the earlier Supabase-login migration (002). **Do not run 002 for this version.**

After migration 003, run [004_payment_profiles.sql](../migrations/004_payment_profiles.sql) for mandatory payment profiles. Apply 004 immediately before promoting its frontend because it changes the profile save endpoint.

For a new database, run the full current [`schema.sql`](../schema.sql) instead.

Migration 003 is transactional and safe to rerun. It switches identity columns to text because Clerk IDs look like `user_...`. It revokes anonymous RPC access and enforces account permissions on both old and new expense APIs.

If 002 was used previously, old Supabase account mappings are saved in the admin-only `hs_auth_migration_backup` table. Old profiles remain stored. Existing UUID-based memberships are unlinked and old groups are locked until their rightful owners are linked to Clerk accounts. No balances, expenses or payments are deleted. Accounts are never matched automatically by email or display name.

Apply the migration and deploy the frontend together: migration 003 disables the old anonymous app. Do not rerun migrations 001 or 002 afterward; both are guarded against overwriting Clerk security.

## 4. Deploy and verify

```bash
npm ci
npm test
npm run build
vercel --prod --yes
```

Verify a real Google or email login, save a profile and UPI ID, inspect/download its QR, create a group and join from a second account. The real Clerk dialog has been checked locally, but completing Google/email authentication and live Supabase JWT acceptance still need this check after dashboard setup.

## 5. Restore an older group

The intended owner first signs in through Clerk and saves their profile. As site administrator, look up their **User ID** (`user_...`) in the Clerk Dashboard under **Users**. Verify that this is the actual person who owned the existing member row. Then, as the site administrator, run this SQL with the three placeholders replaced:

```sql
begin;
do $$
declare
  v_token text := 'REPLACE_WITH_GROUP_TOKEN';
  v_member uuid := '00000000-0000-0000-0000-000000000000'; -- existing owner member UUID
  v_user text := 'user_REPLACE_WITH_CLERK_ACCOUNT_ID';
  v_trip uuid;
  v_owner text;
begin
  if not exists(select 1 from public.hs_profiles where user_id=v_user and user_id ~ '^user_[A-Za-z0-9]+$') then
    raise exception 'Owner must sign in through Clerk and save their profile first';
  end if;
  select id,owner_id into v_trip,v_owner from public.hs_trips where token=v_token for update;
  if v_trip is null then raise exception 'Group not found'; end if;
  if v_owner is not null and v_owner<>v_user then raise exception 'Group already has another owner'; end if;
  if not exists(select 1 from public.hs_members where id=v_member and trip_id=v_trip
      and (user_id is null or user_id=v_user)) then
    raise exception 'Member missing or already linked to another account';
  end if;
  update public.hs_members set user_id=v_user,
    upi=(select upi from public.hs_profiles where user_id=v_user)
    where id=v_member and trip_id=v_trip;
  update public.hs_trips set owner_id=v_user,version=version+1 where id=v_trip;
end $$;
commit;
```

The group now appears under that owner's **Your groups** on every device. In **People in this group → Link account**, the owner can link remaining legacy members using the Clerk user IDs supplied by the site administrator. Each person must first sign in and save their profile. Linked members cannot be reassigned through the app. Existing members should be linked rather than joining twice.

## Permissions

| Action | Allowed account |
| --- | --- |
| Read expenses, balances and member UPI IDs | Group members |
| Preview an invite | Signed-in account; only group name and count |
| Join from an invite | Signed-in account, as itself |
| Add an expense | Any member; creator set from the authenticated account |
| Edit or delete an expense | Its creator or group owner |
| Record or undo a payment | Sender, receiver or group owner |
| Change a member's name/UPI | That member only |
| Rename group, remove inactive members, link legacy members | Group owner |
| Change profile | Profile owner only |

Supabase validates the JWT signature and issuer. SQL reads `auth.jwt()->>'sub'` and checks memberships; `auth.uid()` is not used for Clerk IDs. Direct client table access is denied. A browser-stored member ID or matching name grants no access.

Invite links let signed-in people join, so share them only with intended members. This release does not add an owner-approval queue, custom roles, automatic payment verification, or Clerk account-deletion webhooks. Clerk controls login/account credentials; Koto Holo stores the financial records separately.

Users must enter a UPI ID and upload a matching payment QR after Clerk signup, before opening or creating groups. Existing accounts complete this once too. Users can change both from My profile. The app crops the QR to remove surrounding content and saves it as PNG. Profile UPI changes propagate to the account's existing groups; group display names remain independent to avoid name collisions.

## Automated checks

- `npm test`: maths plus isolated PostgreSQL-compatible PGlite tests for permissions, identity spoofing, Clerk IDs, legacy linking and UUID-to-Clerk migration.
- `npm run serve`, then `npm run check:accounts-ui` in another terminal: mobile-browser checks using an intercepted Clerk SDK and isolated database. No email is sent and no live groups/payments are created. Requires installed Edge by default; `BROWSER_CHANNEL` can select another installed Playwright channel.
- `npm run check:live`: read-only anonymous-access checks after migration 003.

Automated tests do not verify Clerk/Google credentials or live JWT acceptance. Test those using real sign-in after the dashboard integration is enabled.

## Clerk email delivery through Resend

1. Verify your sending domain in Resend. Revoke the API key previously shared in chat and create a replacement sending key restricted to that domain.
2. Add `RESEND_API_KEY` and `RESEND_FROM_EMAIL` as server-side Vercel environment variables. Use an address on the verified domain for the sender.
3. In Clerk, create a webhook endpoint for `email.created` at `https://kotoholo.vercel.app/api/clerk-email`. Add its signing secret to Vercel as `CLERK_WEBHOOK_SIGNING_SECRET` and redeploy with all three values.
4. Verify that the endpoint accepts signed events and that a test email arrives before switching over all templates. In Clerk, turn off **Delivered by Clerk** on the specific templates you want Resend to deliver. Switch one template first and confirm a real verification email arrives before switching any others.

The endpoint verifies the original Clerk signature and forwards the rendered message to Resend. It uses the Clerk email ID as a Resend idempotency key. Keep all secrets out of `config.js`, source control and chat.

[Clerk custom email delivery](https://clerk.com/docs/guides/development/troubleshooting/email-deliverability) ? [Resend domains](https://resend.com/docs/dashboard/domains/introduction)

## Admin activity

Open `https://kotoholo.vercel.app/admin/`. Apply [005_admin_activity.sql](../migrations/005_admin_activity.sql) in Supabase to enable the report and start collecting signed-in activity. Find the intended administrator in Clerk Dashboard → **Users** and copy their Clerk user ID. In Supabase SQL Editor, run the statement below with that ID:

```sql
insert into public.hs_site_admins (user_id)
values ('user_REPLACE_WITH_ADMIN_ID')
on conflict do nothing;
```

The report includes existing Koto Holo profiles and signed-in visitors observed after activation. It records one date per account per UTC day. The top 10 are ranked by active days in the last 30 days, with recent use breaking ties. It excludes anonymous traffic, and activity from before rollout cannot be backfilled. The report does not expose email addresses, account IDs, UPI details, or group contents. Only accounts explicitly listed in `hs_site_admins` can query it.
