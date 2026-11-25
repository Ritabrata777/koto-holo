# Koto Holo

**Share expenses. Settle in UPI.**

Everyone joins a group from one link and adds what they paid. Didn't eat the pizza? Leave yourself out of that one. At the end, Koto Holo nets out who owes what and lists the payments that square everyone: **never more than one fewer than the number of people** (6 friends, 5 payments at most). Each payment is a UPI link with the amount filled in, plus a QR code.

Sign in with Google or email through Clerk. No app to install, no ads. Open source, so you can host your own copy for free.

**Use it:** https://kotoholo.vercel.app/

---

## How the maths works

1. **Equal or exact split, paise-exact.** Choose **Exact amounts** to enter each selected person's share in rupees (zero is allowed); the shares must add up to the bill. Equal splitting remains the default. Every amount is stored as whole paise. An expense of ₹100 split 3 ways is ₹33.34 + ₹33.33 + ₹33.33: the leftover paise go to the first people in the trip's join order, so shares always add back up to the bill.
2. **Net balances.** For each person: what they paid − their share of everything + payments they've sent − payments they've received. The balances always add up to exactly ₹0 (the app shows this under Balances).
3. **Greedy settle-up.** First, anyone who owes exactly what someone else is owed pays them directly. Then the biggest debtor pays the biggest creditor until one of them is square, and repeat. Every payment squares at least one person and the last one squares two, so **n people never need more than n − 1 payments**.

This is usually close to the fewest payments possible, but it is **not guaranteed to be the minimum** (finding the true minimum is a much harder problem). The app never claims it is.

"Mark as paid" records the full suggested payment. **Record part payment** lets you enter the amount actually paid, up to the displayed outstanding amount. Remaining cards recalculate after either action. Undo is one tap in the payment history. Recording a payment does not transfer money.

The maths lives in [`assets/js/settle.js`](assets/js/settle.js) (no dependencies) and is tested in [`tests/settle.test.mjs`](tests/settle.test.mjs): thousands of random trips, including 300 trips of 6 people with 23 expenses, checking that balances add to zero, every transfer is positive whole paise, nobody pays themselves, there are at most n − 1 transfers, and paying them all leaves everyone at ₹0.

## Accounts and permissions

Sign in with Google or email, save a profile name and UPI ID, and download your generated payment QR. Your groups are stored against your account and appear on every signed-in device.

Members can add expenses and edit their own entries. Group owners can manage all expenses. Only a payment's sender, receiver or group owner can record or undo it. A member can change only their own payment details. These rules are enforced in the database, including on older API endpoints.

Group tables and profiles have row-level security and no direct browser grants. Authenticated RPCs check membership and identity; a copied member ID or a name is not proof of identity. Invite links let signed-in users join, but reveal only the group name and member count before joining.

Clerk stores account emails and manages login sessions. The app stores names, UPI IDs, memberships, expenses and recorded payments. Account sessions are persisted in the browser by Clerk. Sign-out clears the displayed group data.

**Existing installations:** follow [Account setup and migration](docs/accounts-setup.md) before deploying. Old groups retain their balances but need their owner securely linked to an account; names and browser history are never used to grant ownership.

## Host your own copy (free, about 10 minutes)

You need a GitHub account and a free [Supabase](https://supabase.com) account.

1. **Fork this repo** (or download it).
2. **Create a Supabase project** (free plan is fine). Any region; pick the one closest to your friends.
3. **Create the tables and functions.** In the Supabase dashboard open **SQL Editor**, paste the whole of [`schema.sql`](schema.sql) and press **Run**. It only creates objects whose names start with `hs_`, and it's safe to run again. It can share a project with other apps.
4. **Point the app at your project.** Copy the **Project URL** and **publishable key** from your Supabase dashboard into [`config.js`](config.js). An existing legacy `anon` key also works. Keep privileged keys server-side. The static site reads `config.js` directly. If you keep a local `.env.local`, copy any settings you change there into `config.js` before serving or publishing the app.
5. **Enable sign-in.** Follow [Account setup](docs/accounts-setup.md) to configure Clerk and its native Supabase integration.
6. **Publish it.**
   - **GitHub Pages:** repo **Settings → Pages → Build and deployment → Deploy from a branch**, branch `main`, folder `/ (root)`. Your app appears at `https://<you>.github.io/hisaab/` a minute later.
   - **Netlify or Vercel:** install dependencies, use `npm run build` and publish `dist`. Vercel also has a checked-in configuration.

Then validate the implementation:

```bash
npm ci
npm test                 # money maths and database permission tests
npm run build            # refresh the bundled Clerk SDK and build dist
npm run serve            # http://127.0.0.1:5174/
npm run check:accounts-ui # separate terminal, requires installed Edge
npm run check:live        # read-only anonymous-access checks after migration 003
```

## Free-tier notes

Limits as of late 2026; check [supabase.com/pricing](https://supabase.com/pricing) for current numbers.

- **Database size:** the free plan's 500 MB is plenty. A trip with 6 people and 25 expenses is a few kilobytes, so even a whole college's trips won't come close.
- **Pausing:** free projects pause after about a week with no activity. A paused project shows "The server is waking up" in the app. To wake it, open the project in the Supabase dashboard and press **Restore project**; it takes a couple of minutes.
- **Realtime:** the free plan allows a few hundred simultaneous connections. If you go over, the live ping stops but polling keeps every phone in sync.
- **Abuse:** verified signed-in users can create groups; the public API key alone cannot. Each trip is capped at 30 people, 500 expenses and 500 payments, and every text field has a length limit. If someone spams your project, you can delete trips from the SQL Editor.
- **Hosting:** GitHub Pages, Netlify and Vercel all host a static site like this for free.

## Paying through UPI

Each settle-up card has a **Pay via UPI** button that opens a `upi://pay?pa=…&pn=…&am=…&cu=INR&tn=…` link: the payee's UPI ID, their name, the amount and the trip name are filled in. The button only appears when the person being paid has added a UPI ID (only that member can add or fix it).

- Each card shows the recipient's UPI ID and a **Copy UPI ID** button. If a linked payment fails without a debit, open your UPI app directly, paste the ID and enter the displayed amount. Confirm the bank-verified recipient name before paying.
- A "UPI risk policy" rejection is issued by the UPI app or bank. Koto Holo cannot override it or determine the exact trigger. The generated QR contains the same payment details as the link and is not a guaranteed fix. If manual payment is also rejected, contact support in your UPI app or your bank. See [BHIM's transaction troubleshooting](https://www.bhimupi.org.in/faq-s.html).
- If a payment is pending or money was debited, check its status in your UPI app before retrying. Expand **Payment failed or blocked?** on a card for this guidance.
- Links inside Instagram's or other apps' built-in browsers may not open UPI apps. Open the trip in Chrome or Safari instead.
- Koto Holo never touches money. Marking a card as paid is just a note for the group, so only mark it once the payment has gone through.

## Project layout

```
index.html               the app shell
config.js                your Supabase URL + public API key
schema.sql               tables, RLS, functions (all hs_*)
assets/js/settle.js      the money maths (pure, tested)
assets/js/app.js         screens and routing
assets/js/api.js         calls the hs_* functions over PostgREST
assets/js/live.js        polling + Realtime Broadcast ping
assets/js/barcode.js     a real Code 128 barcode of the trip name
assets/css/hisaab.css    the receipt
tests/settle.test.mjs    unit tests (node --test)
scripts/                 live check, demo seed
```

## Credits

- Type: [IBM Plex Mono](https://github.com/IBM/plex) (SIL Open Font License, see `assets/fonts/OFL-IBM-Plex.txt`), subset to the characters the app uses.
- Icons: path data from [Lucide](https://lucide.dev) (ISC licence); the train and receipt icons are drawn for this app.
- QR codes: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) by Kazuhiko Arase (MIT).

MIT licensed, see [LICENSE](LICENSE).

## Updating an existing installation for exact splits

For installations predating accounts, run [`migrations/001_exact_splits.sql`](migrations/001_exact_splits.sql) in your Supabase SQL Editor. It adds nullable exact shares and validated v2 expense functions, and updates the trip response. Existing expenses remain equal splits. The migration is transactional and safe to rerun. New installations can use the updated `schema.sql` instead.

This release supports unequal **exact amounts**; percentage and weighted-share entry are not included.

For the Clerk account release, run migration 003 after migration 001; migration 002 is the superseded Supabase-login implementation. Follow [the account setup guide](docs/accounts-setup.md); do not rerun 001 after accounts are installed.
