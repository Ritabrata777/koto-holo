import { readPaymentQr, paymentQrSource } from './payment-qr.js';
// Koto Holo: the app. Hash routes, one receipt per screen.
//   #/                      start a trip, your groups
//   #/t/<token>             the group (or the join form if this device isn't on it)
//   #/t/<token>/add         add an expense
//   #/t/<token>/e/<id>      edit an expense
//   #/t/<token>/settle      settle up
// The token lives in the URL fragment, so it is never sent to the web host.
import { auth, initializeAuth } from './auth.js';
import { api, rpc, messageFor, ApiError } from './api.js';
import { watchTrip } from './live.js';
import {
  settleTrip,
  orderedSplit,
  splitEqually,
  expenseShares,
  upiAmount,
  rupees,
  parseRupees,
  upiLink,
  cleanUpi,
} from './settle.js';
import { icon, iconFor } from './icons.js';
import { barcodeSVG } from './barcode.js';
import qrcode from '../vendor/qrcode.mjs';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const app = $('#app');
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// Account state: memberships are fetched from the database.
// ---------------------------------------------------------------------------
let currentUser = null;
let accountProfile = null;
let profileLoaded = false;
let accountGroups = {};
const myTrips = () => accountGroups;
const meFor = (token) => myTrips()[token]?.me || null;
function rememberTrip(token, patch) {
  const all = myTrips();
  all[token] = { ...(all[token] || {}), ...patch, opened: Date.now() };
  accountGroups = all;
}
function forgetTrip(token) {
  const all = myTrips();
  delete all[token];
  accountGroups = all;
}

// ---------------------------------------------------------------------------
// Trip session: cached data, background refresh, live watcher.
// ---------------------------------------------------------------------------
const session = { token: null, data: null, watcher: null, inflight: null };

function useTrip(token) {
  if (session.token === token) return;
  session.watcher?.stop();
  session.watcher = null;
  session.token = token;
  session.data = null;
  session.inflight = null;
}

async function refresh() {
  const token = session.token;
  const userId = currentUser?.id;
  if (!token) return null;
  if (session.inflight) return session.inflight;
  session.inflight = (async () => {
    try {
      const data = await api.getTrip(token);
      if (token !== session.token || userId !== currentUser?.id) return null;
      session.data = data;
      // Identity and permissions come from the server, never browser storage.
      rememberTrip(token, { me: data.trip.me, name: data.trip.name, people: data.members.length });
      if (myTrips()[token] || meFor(token)) {
        rememberTrip(token, { name: data.trip.name, people: data.members.length });
      }
      startWatcher(data.trip.version);
      return data;
    } finally {
      session.inflight = null;
    }
  })();
  return session.inflight;
}

function startWatcher(version) {
  if (session.watcher) {
    session.watcher.setVersion(version);
    return;
  }
  const token = session.token;
  session.watcher = watchTrip(token, version, async () => {
    try {
      await refresh();
      onRemoteChange();
    } catch {
      /* next tick */
    }
  });
}

// After our own write: refetch, then nudge everyone else.
async function afterWrite(result) {
  const v = typeof result === 'number' ? result : result?.version;
  session.watcher?.setVersion(v);
  const data = await refresh();
  session.watcher?.ping();
  return data;
}

// Re-render read-only screens when someone else changes the group. If a sheet is
// open (someone is typing their UPI ID), wait until it closes.
let remotePending = false;
function onRemoteChange() {
  const r = parseRoute();
  if (r.token !== session.token) return;
  if (r.view !== 'trip' && r.view !== 'settle') return;
  if ($('#sheet')?.open) {
    remotePending = true;
    return;
  }
  render({ keepScroll: true });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
const TOKEN = '([A-Za-z0-9_-]{24,64})';
function parseRoute() {
  const h = decodeURIComponent(location.hash || '');
  let m;
  if (h === '#/profile') return { view: 'profile' };
  if ((m = new RegExp(`^#/t/${TOKEN}/add$`).exec(h))) return { view: 'add', token: m[1] };
  if ((m = new RegExp(`^#/t/${TOKEN}/settle$`).exec(h))) return { view: 'settle', token: m[1] };
  if ((m = new RegExp(`^#/t/${TOKEN}/e/([0-9a-f-]{36})$`).exec(h))) return { view: 'edit', token: m[1], id: m[2] };
  if ((m = new RegExp(`^#/t/${TOKEN}/?$`).exec(h))) return { view: 'trip', token: m[1] };
  return { view: 'home' };
}
const go = (hash) => {
  if (location.hash === hash) render();
  else location.hash = hash;
};
const tripHash = (token, rest = '') => `#/t/${token}${rest}`;
const inviteUrl = (token) => `${location.origin}${location.pathname}#/t/${token}`;

// A single daily record per account. Failed writes can retry on navigation.
let activityKey;
function recordSiteActivity(userId) {
  const key = userId + ':' + new Date().toISOString().slice(0, 10);
  if (key === activityKey) return;
  activityKey = key;
  rpc('hs_record_site_activity').catch(() => {
    if (activityKey === key) activityKey = undefined;
  });
}

let renderSeq = 0;
async function render({ keepScroll = false } = {}) {
  const seq = ++renderSeq;
  const route = parseRoute();
  const y = window.scrollY;
  closeSheet();
  if (!currentUser) {
    paint(signInScreen());
    return;
  }
  recordSiteActivity(currentUser.id);
  if (!profileLoaded) {
    paint(loadingScreen());
    try { const profile = await api.profile(); if (seq !== renderSeq || !currentUser) return; accountProfile = profile; profileLoaded = true; }
    catch (err) { if (seq === renderSeq) paint(accountErrorScreen(err)); return; }
    if (seq !== renderSeq) return;
  }
  if (!accountProfile?.upi || !accountProfile?.upi_qr || route.view === 'profile') {
    paint(profileScreen());
    return;
  }

  if (route.view === 'home') {
    session.watcher?.stop();
    session.watcher = null;
    session.token = null;
    session.data = null;
    paint(loadingScreen());
    try {
      const groups = await api.groups();
      if (seq !== renderSeq) return;
      accountGroups = Object.fromEntries(groups.map(({ token, ...group }) => [token, group]));
      paint(homeScreen());
    } catch (err) { if (seq === renderSeq) paint(accountErrorScreen(err)); }
    document.title = 'Koto Holo · share expenses, settle in UPI';
    return;
  }

  useTrip(route.token);
  if (!session.data || !keepScroll) {
    paint(loadingScreen());
    try {
      await refresh();
    } catch (err) {
      if (seq !== renderSeq) return;
      if (err?.code === 'not_a_member') {
        try { const invite = await api.invite(route.token); if (seq === renderSeq) paint(accountJoinScreen(route.token, invite)); }
        catch (inviteError) { if (seq === renderSeq) paint(accountErrorScreen(inviteError)); }
      } else paint(accountErrorScreen(err));
      return;
    }
  }
  if (seq !== renderSeq) return;
  const data = session.data;
  document.title = `${data.trip.name} · Koto Holo`;

  const me = data.members.find((m) => m.id === data.trip.me);
  if (!me) {
    paint(accountErrorScreen(new ApiError('not_a_member', 403)));
    return;
  }
  if (route.view === 'trip') paint(tripScreen(route.token, data, me));
  else if (route.view === 'settle') paint(settleScreen(route.token, data, me));
  else if (route.view === 'add') paint(expenseScreen(route.token, data, me, null));
  else if (route.view === 'edit') {
    const exp = data.expenses.find((e) => e.id === route.id);
    paint(exp ? canEditExpense(data, me, exp) ? expenseScreen(route.token, data, me, exp) : expenseDetailScreen(route.token, data, exp) : missingScreen(route.token));
  }
  if (keepScroll) window.scrollTo(0, y);
}

function paint({ html, bind, focus }) {
  app.innerHTML = html;
  bind?.(app);
  if (focus) $(focus, app)?.focus({ preventScroll: true });
}

window.addEventListener('hashchange', () => {
  slammed.clear();
  render();
  window.scrollTo(0, 0);
});

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------
const AVATAR_TINTS = 6;
const expandedTrips = new Set();
const slammed = new Set();
const initials = (name) => {
  const words = String(name).trim().split(/\s+/);
  const first = [...words[0]][0] || '?';
  const second = words.length > 1 ? [...words[words.length - 1]][0] : '';
  return (first + second).toUpperCase();
};
function avatar(member, { size = '', you = false } = {}) {
  const tint = ((member.position || 1) - 1) % AVATAR_TINTS;
  return `<span class="av av-${tint} ${size}" aria-hidden="true">${esc(initials(member.name))}${you ? '<i class="av-you"></i>' : ''}</span>`;
}

function bar({ back = null, menu = false, title = 'Koto Holo' } = {}) {
  return `<header class="bar">
    ${back ? `<a class="bar-btn" href="${back}" aria-label="Back">${icon('back')}</a>` : '<span class="bar-btn bar-btn-blank"></span>'}
    <span class="bar-title">${esc(title)}</span>
    ${menu ? `<button class="bar-btn" type="button" data-menu aria-label="Group options" aria-haspopup="dialog">${icon('more')}</button>` : '<span class="bar-btn bar-btn-blank"></span>'}
  </header>`;
}

const rule = (cls = '') => `<hr class="rule ${cls}">`;

function stub(text) {
  return `<footer class="stub">
    ${barcodeSVG(text)}
    <p class="stub-label"><span>${esc(String(text).toUpperCase())}</span></p>
  </footer>`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function totalOf(data) {
  return data.expenses.reduce((s, e) => s + e.amount_paise, 0);
}

// ---------------------------------------------------------------------------
// Home: start a trip, list this device's trips
// ---------------------------------------------------------------------------
function homeScreen() {
  const trips = Object.entries(myTrips())
    .filter(([, t]) => t.me)
    .sort((a, b) => (b[1].opened || 0) - (a[1].opened || 0));
  const list = trips.length
    ? `${rule()}
      <section class="block">
        <h2 class="h2">Your groups</h2>
        <ul class="lines">
          ${trips
            .map(
              ([token, t]) => `<li><a class="line line-link" href="${tripHash(token)}">
                <span class="line-main"><span class="line-name">${esc(t.name || 'Group')}</span><span class="leader"></span><span class="line-val">${t.people ? plural(t.people, 'member') : ''}</span></span>
                ${icon('chevron', { size: 20, cls: 'line-chev' })}
              </a></li>`
            )
            .join('')}
        </ul>
      </section>`
    : '';
  return {
    html: `${bar()}
      <div class="block account-bar"><span>${esc(accountProfile?.name)}</span><button class="text-btn" type="button" data-profile>My profile</button></div>
      ${rule()}
      <section class="block intro">
        <h1 class="display">Share expenses.<br>Settle in UPI.</h1>
        <p class="lede">Track shared expenses, see who owes what, and settle up with UPI.</p>
      </section>
      ${rule()}
      <form class="block form" id="create" novalidate>
        <h2 class="h2">Create a group</h2>
        <label class="field">
          <span class="field-label">Group name</span>
          <input class="field-input" name="trip" maxlength="60" autocomplete="off" placeholder="Group name" required>
        </label>
        <label class="field">
          <span class="field-label">Your name</span>
          <input class="field-input" name="name" maxlength="24" autocomplete="given-name" placeholder="Your name" required>
        </label>
        <label class="field">
          <span class="field-label">Your UPI ID</span>
          <input class="field-input" name="upi" maxlength="120" autocomplete="off" autocapitalize="none" spellcheck="false" inputmode="email" placeholder="name@upi">
        </label>
        <p class="hint">To change your UPI ID, open My profile.</p>
        <p class="form-error" role="alert" hidden></p>
        <sakuga-button class="sakuga-action" type="submit">Create group</sakuga-button>
      </form>
      ${list}
      ${rule()}
      <section class="block about">
        <ul class="lines lines-quiet">
          <li class="line"><span class="line-main"><span class="line-name">Your groups</span><span class="leader"></span><span class="line-val">on every device</span></span></li>
          <li class="line"><span class="line-main"><span class="line-name">Pays out via</span><span class="leader"></span><span class="line-val">any UPI app</span></span></li>
        </ul>
      </section>
      ${stub('Koto Holo')}`,
    bind(root) {
      const form = $('#create', root);
      form.elements.name.value = accountProfile.name;
      form.elements.upi.value = accountProfile.upi || '';
      form.elements.upi.readOnly = true;
      $('[data-profile]', root).addEventListener('click', () => go('#/profile'));
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = new FormData(form);
        const trip = String(f.get('trip') || '').trim();
        const name = String(f.get('name') || '').trim();
        const upi = cleanUpi(f.get('upi'));
        const err = $('.form-error', form);
        const fail = (msg, field) => {
          err.textContent = msg;
          err.hidden = false;
          if (field) form.elements[field].focus();
        };
        if (!trip) return fail('Give the group a name.', 'trip');
        if (!name) return fail('Add your name, so members know who paid.', 'name');
        if (!upi.ok) return fail("That doesn't look like a UPI ID. It's like name@okaxis.", 'upi');
        err.hidden = true;
        await busy(form, async () => {
          try {
            const res = await api.createTrip(trip, name, upi.value);
            rememberTrip(res.token, { me: res.member_id, name: trip, people: 1, fresh: true });
            go(tripHash(res.token));
          } catch (e) {
            fail(messageFor(e));
          }
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Join: pick yourself, or add yourself
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Trip receipt
// ---------------------------------------------------------------------------
function tripScreen(token, data, me) {
  const n = data.members.length;
  const total = totalOf(data);
  const { rows } = settleTrip(data);
  const mine = rows.find((r) => r.id === me.id);
  const byId = new Map(data.members.map((m) => [m.id, m]));
  const fresh = myTrips()[token]?.fresh;

  const youLine =
    data.expenses.length === 0
      ? ''
      : `<a class="you-line" href="${tripHash(token, '/settle')}">
          <span class="you-name">You (${esc(me.name)})</span><span class="leader"></span>
          <span class="you-val ${mine.net > 0 ? 'is-pos' : ''}">${
            mine.net > 0 ? `get back ${rupees(mine.net)}` : mine.net < 0 ? `owe ${rupees(-mine.net)}` : 'all square'
          }</span>
        </a>`;

  const invite =
    n === 1 || fresh
      ? `<section class="block invite">
          <h2 class="h2">Send this to the group</h2>
          <p class="hint hint-top">Signed-in people with the link can join and add expenses. Only share it with the group.</p>
          <p class="invite-url"><span>${esc(inviteUrl(token).replace(/^https?:\/\//, ''))}</span></p>
          <div class="pair">
            <sakuga-button class="sakuga-action plate-sm" type="button" data-share>${icon('share', { size: 18 })}<span>Share link</span></sakuga-button>
            <button class="outline plate-sm" type="button" data-copy>${icon('copy', { size: 18 })}<span>Copy</span></button>
          </div>
          ${fresh && n > 1 ? `<button class="text-btn" type="button" data-dismiss-invite>Done, hide this</button>` : ''}
        </section>
        ${rule()}`
      : '';

  const FOLD = 5;
  const expanded = expandedTrips.has(token) || data.expenses.length <= FOLD + 1;
  const shown = expanded ? data.expenses : data.expenses.slice(0, FOLD);
  const more =
    data.expenses.length > FOLD + 1
      ? `<button class="ex-more" type="button" data-more aria-expanded="${expanded}">
          <span>${expanded ? 'Newest first' : `All ${data.expenses.length} expenses`}</span><span class="leader"></span>
          <span class="ex-more-act">${expanded ? 'show fewer' : `${data.expenses.length - FOLD} more`}${icon('chevron', { size: 18 })}</span>
        </button>`
      : '';
  const items = data.expenses.length
    ? `<ul class="expenses">${shown
        .map((e) => {
          const payer = byId.get(e.paid_by);
          const k = e.split.length;
          const who =
            k === n
              ? ''
              : k === 1
                ? ` · for ${esc(byId.get(e.split[0])?.name || '1 person')}`
                : ` · ${k} people`;
          return `<li><a class="ex" href="${tripHash(token, `/e/${e.id}`)}">
            <span class="ex-ic">${icon(iconFor(e.title), { size: 26, stroke: 1.75 })}</span>
            <span class="ex-body">
              <span class="ex-top"><span class="ex-title">${esc(e.title)}</span><span class="leader"></span><span class="ex-amt">${rupees(e.amount_paise)}</span></span>
              <span class="ex-sub">paid by ${esc(payer?.name || 'someone')}${who}${e.shares ? ' ? exact amounts' : ''}</span>
            </span>
            ${icon('chevron', { size: 20, cls: 'ex-chev' })}
          </a></li>`;
        })
        .join('')}</ul>
      ${more}
      <p class="total"><span class="total-label">TOTAL</span><span class="leader"></span><span>${rupees(total)}</span></p>`
    : `<div class="empty">
        <p class="empty-title">Nothing on the bill yet.</p>
        <p class="hint">Add your first expense.</p>
      </div>`;

  return {
    html: `${bar({ back: '#/', menu: true })}
      ${rule()}
      <section class="block trip-head">
        <h1 class="display">${esc(data.trip.name)}</h1>
        <p class="meta">${plural(n, 'member')}<span class="dot">·</span>${plural(data.expenses.length, 'expense')}<span class="dot">·</span>${rupees(total)}</p>
        <button class="avatars avatars-btn" type="button" data-people aria-label="People in this group: ${esc(data.members.map((m) => m.name).join(', '))}">
          ${data.members.map((m) => avatar(m, { you: m.id === me.id })).join('')}
        </button>
        ${youLine}
      </section>
      ${rule()}
      ${invite}
      <section class="block">
        <h2 class="h2">Expenses</h2>
        ${items}
      </section>
      ${rule()}
      ${stub(data.trip.name)}
      <div class="dock">
        <a class="outline" href="${tripHash(token, '/settle')}">Settle up</a>
        <a class="plate" href="${tripHash(token, '/add')}">${icon('plus', { size: 20 })}<span>Add expense</span></a>
      </div>`,
    bind(root) {
      $('[data-menu]', root)?.addEventListener('click', () => tripMenu(token, data, me));
      $('[data-people]', root)?.addEventListener('click', () => peopleSheet(token, data, me));
      $('[data-share]', root)?.addEventListener('click', () => shareInvite(token, data.trip.name));
      $('[data-more]', root)?.addEventListener('click', () => {
        if (expandedTrips.has(token)) expandedTrips.delete(token);
        else expandedTrips.add(token);
        render({ keepScroll: true });
      });
      $('[data-copy]', root)?.addEventListener('click', () => copyText(inviteUrl(token), 'Invite link copied.'));
      $('[data-dismiss-invite]', root)?.addEventListener('click', () => {
        rememberTrip(token, { fresh: false });
        render({ keepScroll: true });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Add / edit expense
// ---------------------------------------------------------------------------
function expenseScreen(token, data, me, existing) {
  const members = data.members;
  const editing = Boolean(existing);
  const state = {
    amount: existing ? groupAmount((existing.amount_paise / 100).toFixed(existing.amount_paise % 100 ? 2 : 0)) : '',
    mode: existing?.shares ? 'exact' : 'equal',
    title: existing?.title || '',
    paidBy: existing?.paid_by || me.id,
    split: new Set(existing ? existing.split : members.map((m) => m.id)),
  };
  const payer = () => members.find((m) => m.id === state.paidBy) || me;

  return {
    html: `${bar({ back: tripHash(token), menu: true })}
      ${rule()}
      <form class="exform" id="exform" novalidate>
        <section class="block">
          <h1 class="h1">${editing ? 'Edit expense' : 'Add expense'}</h1>
          <label class="amount">
            <span class="sr-only">Amount in rupees</span>
            <span class="amount-rupee" aria-hidden="true">₹</span>
            <input class="amount-input" name="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(state.amount)}" maxlength="12" enterkeyhint="next">
          </label>
          <label class="what">
            <span class="sr-only">What was it for?</span>
            <input class="what-input" name="title" maxlength="60" autocomplete="off" placeholder="Expense description" value="${esc(state.title)}" enterkeyhint="done">
          </label>
        </section>
        ${rule()}
        <section class="block paidby">
          <p class="label-row">${icon('user', { size: 20 })}<span id="paidby-label">Paid by</span></p>
          <label class="pill">
            <span class="pill-face" aria-hidden="true">${avatar(payer(), { size: 'av-sm' })}<span class="pill-name">${esc(payer().name)}</span>${icon('chevron', { size: 20 })}</span>
            <select class="pill-select" name="paid_by" aria-labelledby="paidby-label">
              ${members.map((m) => `<option value="${m.id}" ${m.id === state.paidBy ? 'selected' : ''}>${esc(m.name)}${m.id === me.id ? ' (you)' : ''}</option>`).join('')}
            </select>
          </label>
        </section>
        ${rule()}
        <fieldset class="block split">
          <div class="split-head">
            <legend class="h2">Split between</legend>
            <button class="text-btn" type="button" data-all>Everyone</button>
          </div>
          <label class="hint">Split method
            <select class="field-input" name="split_mode">
              <option value="equal" ${state.mode === 'equal' ? 'selected' : ''}>Equally</option>
              <option value="exact" ${state.mode === 'exact' ? 'selected' : ''}>Exact amounts</option>
            </select>
          </label>
          <p class="hint" data-split-total aria-live="polite"></p>
          <ul class="split-list">
            ${members
              .map(
                (m) => `<li><div class="split-row">
                  ${avatar(m, { size: 'av-sm' })}
                  <span class="split-name">${esc(m.name)}${m.id === me.id ? ' <em>(you)</em>' : ''}</span>
                  <span class="leader"></span>
                  <span class="split-amt" data-share-of="${m.id}"></span>
                  <input class="field-input exact-share" data-exact="${m.id}" inputmode="decimal" aria-label="${esc(m.name)} share in rupees" placeholder="0.00" value="${existing?.shares?.[m.id] != null ? upiAmount(existing.shares[m.id]) : ''}" hidden>
                  <sakuga-checkbox name="split" value="${m.id}" ${state.split.has(m.id) ? 'checked' : ''}><span class="sr-only">Split with ${esc(m.name)}</span></sakuga-checkbox>
                </div></li>`
              )
              .join('')}
          </ul>
        </fieldset>
        ${editing ? `<section class="block save"><button class="text-btn danger" type="button" data-delete>${icon('trash', { size: 18 })}<span>Delete expense</span></button></section>` : ''}
        <div class="dock dock-single">
          <p class="form-error" role="alert" hidden></p>
          <sakuga-button class="sakuga-action" type="submit"><span class="save-label">Save</span></sakuga-button>
        </div>
      </form>`,
    focus: editing ? null : '.amount-input',
    bind(root) {
      const form = $('#exform', root);
      const amountInput = $('.amount-input', form);
      const select = $('.pill-select', form);
      const err = $('.form-error', form);
      const saveLabel = $('.save-label', form);
      $('[data-menu]', root)?.addEventListener('click', () => tripMenu(token, data, me));

      const sizeAmount = () => {
        const len = Math.max(1, amountInput.value.length || 1);
        amountInput.style.width = `${len + 0.15}ch`;
      };
      const exactShares = () => Object.fromEntries([...state.split].map((id) => {
        const value = $(`[data-exact="${id}"]`, form).value.trim();
        return [id, /^0(?:\.0{0,2})?$/.test(value) ? 0 : parseRupees(value)];
      }));
      const update = () => {
        const paise = parseRupees(amountInput.value);
        const chosen = orderedSplit([...state.split], members);
        const shares = paise && chosen.length ? splitEqually(paise, chosen) : new Map();
        for (const m of members) {
          const cell = $(`[data-share-of="${m.id}"]`, form);
          const on = state.split.has(m.id);
          cell.textContent = on ? (paise ? rupees(shares.get(m.id)) : '₹—') : '—';
          cell.closest('.split-row').classList.toggle('is-off', !on);
          cell.hidden = state.mode === 'exact';
          const exact = $(`[data-exact="${m.id}"]`, form);
          exact.hidden = state.mode !== 'exact';
          exact.disabled = !on;
        }
        const total = Object.values(exactShares()).reduce((sum, value) => sum + (value || 0), 0);
        $('[data-split-total]', form).textContent = state.mode === 'exact'
          ? `Assigned ${rupees(total)} of ${rupees(paise || 0)}. Enter 0 for a selected person with no share.` : '';
        const k = chosen.length;
        saveLabel.textContent = k === 0 ? 'Save' : k === 1 ? 'Save · for 1 person' : `Save · split ${k} ways`;
        sizeAmount();
      };

      form.elements.split_mode.addEventListener('change', () => {
        state.mode = form.elements.split_mode.value;
        update();
      });
      $$('[data-exact]', form).forEach((input) => input.addEventListener('input', update));
      amountInput.addEventListener('input', () => {
        // Keep it a clean number (one decimal point, 2 decimals), grouped like 1,23,456.
        const v = groupAmount(amountInput.value);
        if (v !== amountInput.value) {
          amountInput.value = v;
          amountInput.setSelectionRange(v.length, v.length);
        }
        err.hidden = true;
        update();
      });
      amountInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          $('.what-input', form).focus();
        }
      });
      select.addEventListener('change', () => {
        state.paidBy = select.value;
        const p = payer();
        $('.pill-face', form).innerHTML = `${avatar(p, { size: 'av-sm' })}<span class="pill-name">${esc(p.name)}</span>${icon('chevron', { size: 20 })}`;
      });
      $$('sakuga-checkbox[name=split]', form).forEach((cb) =>
        cb.addEventListener('change', () => {
          if (cb.checked) state.split.add(cb.value);
          else state.split.delete(cb.value);
          update();
        })
      );
      $('[data-all]', form).addEventListener('click', () => {
        const all = state.split.size === members.length;
        state.split = new Set(all ? [] : members.map((m) => m.id));
        $$('sakuga-checkbox[name=split]', form).forEach((cb) => (cb.checked = state.split.has(cb.value)));
        update();
      });

      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const paise = parseRupees(amountInput.value);
        const title = $('.what-input', form).value.trim();
        const fail = (msg, el) => {
          err.textContent = msg;
          err.hidden = false;
          el?.focus();
        };
        if (!paise) return fail('Enter an amount, like 1350 or 249.50.', amountInput);
        if (paise > 100000000) return fail("That's over ₹10 lakh. Split it into parts?", amountInput);
        if (!title) return fail('Enter an expense description.', $('.what-input', form));
        if (state.split.size === 0) return fail('Pick at least one person to split it between.');
        const payload = { title, amount_paise: paise, paid_by: state.paidBy, split: orderedSplit([...state.split], members) };
        payload.shares = state.mode === 'exact' ? exactShares() : null;
        try { expenseShares(payload, members); }
        catch { return fail('Enter every selected share (0 is allowed). Shares must add up exactly to the bill.'); }
        await busy(form, async () => {
          try {
            const res = editing ? await api.updateExpense(token, existing.id, payload) : await api.addExpense(token, payload, me.id);
            await afterWrite(res);
            toast(`${editing ? 'Saved' : 'Added'} ${title} · ${rupees(paise)}`);
            go(tripHash(token));
          } catch (e) {
            fail(messageFor(e));
          }
        });
      });

      $('[data-delete]', form)?.addEventListener('click', () =>
        confirmSheet({
          title: `Delete ${existing.title}?`,
          body: `${rupees(existing.amount_paise)} comes off the group and everyone's balance changes.`,
          action: 'Delete expense',
          danger: true,
          run: async () => {
            await afterWrite(await api.deleteExpense(token, existing.id));
            toast(`Deleted ${existing.title}.`);
            go(tripHash(token));
          },
        })
      );
      update();
    },
  };
}

function missingScreen(token) {
  return {
    html: `${bar({ back: tripHash(token) })}${rule()}
      <section class="block void">
        <p class="void-stamp" aria-hidden="true">VOID</p>
        <h1 class="h1">This expense is gone.</h1>
        <p class="hint">Someone in the group deleted it.</p>
        <a class="plate" href="${tripHash(token)}">Back to the group</a>
      </section>`,
  };
}

// ---------------------------------------------------------------------------
// Settle up
// ---------------------------------------------------------------------------
function settleScreen(token, data, me) {
  const s = settleTrip(data);
  const byId = new Map(data.members.map((m) => [m.id, m]));
  const k = s.transfers.length;
  const n = s.people;
  // Your own payments first, then the rest in settle order.
  const transfers = [...s.transfers].sort((a, b) => Number(b.from === me.id || b.to === me.id) - Number(a.from === me.id || a.to === me.id));

  let headline;
  if (!data.expenses.length) headline = 'Nothing to<br>settle yet';
  else if (k === 0) headline = 'All square';
  else headline = `${k} payment${k === 1 ? '' : 's'}<br>settle everything`;

  const bound = n >= 2 ? `${plural(n, 'member')} · at most ${plural(n - 1, 'payment')}` : 'Invite members to split with';

  const cards = transfers
    .map((t, i) => {
      const from = byId.get(t.from);
      const to = byId.get(t.to);
      const link = to.upi ? upiLink({ pa: to.upi, pn: to.name, amountPaise: t.amount, tn: data.trip.name }) : null;
      const canPay = canRecordPayment(data, me, t);
      const yours = t.from === me.id ? 'is-mine' : t.to === me.id ? 'is-owed' : '';
      return `<li class="card ${yours}" data-i="${i}">
        <div class="card-main">
          ${avatar(from)}
          <div class="card-body">
            <p class="card-who"><span>${esc(from.name)}</span><span class="arrow" aria-label="pays">→</span><span>${esc(to.name)}</span></p>
            <p class="card-amt">${rupees(t.amount)}</p>
          </div>
          ${
            link && t.from === me.id
              ? `<a class="plate plate-xs" href="${esc(link)}" data-pay>Pay via UPI</a>`
              : !link && to.id === me.id ? `<button class="outline plate-xs" type="button" data-add-upi="${to.id}">Add UPI ID</button>` : ''
          }
        </div>
        <div class="card-foot">
          ${link ? `<button class="text-btn" type="button" data-qr aria-expanded="false">${icon('qr', { size: 17 })}<span>Show QR</span></button>` : `<span class="card-nupi">${esc(to.name)} has no UPI ID yet</span>`}
          ${canPay ? `<button class="text-btn" type="button" data-partial>Record part payment</button>` : ''}
          ${canPay ? `<sakuga-button class="sakuga-action sakuga-small" variant="secondary" type="button" data-paid><span>Mark as paid</span></sakuga-button>` : ''}
        </div>
        ${
          link
            ? `<div class="card-manual">
                <p class="qr-upi"><span>${esc(to.upi)}</span><button class="text-btn" type="button" data-copy-upi="${esc(to.upi)}">${icon('copy', { size: 16 })}<span>Copy UPI ID</span></button></p>
                <details class="payment-help">
                  <summary>Payment failed or blocked?</summary>
                  <p class="hint">If the payment failed without a debit, copy this UPI ID, open your UPI app yourself and pay ${rupees(t.amount)}. Confirm the recipient's bank-verified name before paying.</p>
                  <p class="hint">A risk-policy rejection comes from the UPI app or bank; Koto Holo cannot override it. If a manual payment is also blocked, contact support in your UPI app or your bank. This QR uses the same payment details and may also be rejected.</p>
                  <p class="hint">If money was debited or the payment is pending, check its status in your UPI app before trying again.</p>
                </details>
                <p class="hint">Only mark as paid after your UPI app confirms success.</p>
              </div>
              <div class="card-qr" hidden>
                <div class="qr" data-link="${esc(link)}"></div>
                <p class="qr-cap">Scan with any UPI app to pay ${esc(to.name)} ${rupees(t.amount)}</p>
              </div>`
            : ''
        }
      </li>`;
    })
    .join('');

  const showStamp = k > 0 && n >= 3 && s.everyPair > k;
  const balanceRows = s.rows
    .map((r) => {
      const m = byId.get(r.id);
      const val = r.net > 0 ? `gets ${rupees(r.net)}` : r.net < 0 ? `owes ${rupees(-r.net)}` : 'square';
      const extra = r.sent || r.received ? ` · settled ${rupees(r.sent + r.received)}` : '';
      return `<li class="bal">
        ${avatar(m, { size: 'av-sm', you: m.id === me.id })}
        <span class="bal-body">
          <span class="bal-top"><span class="bal-name">${esc(m.name)}</span><span class="leader"></span><span class="bal-val ${r.net > 0 ? 'is-pos' : ''}">${val}</span></span>
          <span class="bal-sub">paid ${rupees(r.paid)} · share ${rupees(r.share)}${extra}</span>
        </span>
      </li>`;
    })
    .join('');
  const net = s.rows.reduce((a, r) => a + r.net, 0);

  const paid = data.payments.length
    ? `${rule()}
      <section class="block">
        <h2 class="h2">Marked as paid</h2>
        <ul class="lines">
          ${data.payments
            .map(
              (p) => `<li class="line">
                <span class="line-main"><span class="line-name">${esc(byId.get(p.from)?.name)} → ${esc(byId.get(p.to)?.name)}</span><span class="leader"></span><span class="line-val">${rupees(p.amount_paise)}</span></span>
                ${canRecordPayment(data, me, p) ? `<button class="text-btn text-btn-sm" type="button" data-undo="${p.id}" aria-label="Undo ${esc(byId.get(p.from)?.name)} paid ${esc(byId.get(p.to)?.name)}">${icon('undo', { size: 16 })}<span>Undo</span></button>` : ''}
              </li>`
            )
            .join('')}
        </ul>
      </section>`
    : '';

  return {
    html: `${bar({ back: tripHash(token), menu: true })}
      ${rule()}
      <section class="block settle-head">
        <span class="settle-ic">${icon('swap', { size: 46, stroke: 2.25 })}</span>
        <h1 class="display display-center">${headline}</h1>
        <p class="meta meta-center">${data.expenses.length ? bound : 'Add an expense first.'}</p>
      </section>
      ${rule()}
      ${
        k
          ? `<ul class="cards">${cards}</ul>`
          : data.expenses.length
            ? `<div class="block square"><p class="square-stamp" aria-hidden="true">SETTLED</p><p class="hint">All balances are settled.</p></div>`
            : `<div class="block"><a class="plate" href="${tripHash(token, '/add')}">${icon('plus', { size: 20 })}<span>Add expense</span></a></div>`
      }
      ${
        showStamp
          ? `${rule()}<div class="stamp-wrap"><p class="stamp" role="note">Instead of ${s.everyPair}<br>back-and-forth payments</p></div>`
          : ''
      }
      ${
        data.expenses.length
          ? `${rule()}
      <section class="block">
        <h2 class="h2">Balances</h2>
        <ul class="bals">${balanceRows}</ul>
        <p class="sum"><span>Adds up to</span><span class="leader"></span><span>${rupees(net)}</span></p>
      </section>`
          : ''
      }
      ${paid}
      ${rule()}
      ${stub(data.trip.name)}`,
    bind(root) {
      $('[data-menu]', root)?.addEventListener('click', () => tripMenu(token, data, me));
      // The stamp slams down when it scrolls into view, not off-screen at render.
      // Once per visit: live repaints and mark-as-paid don't slam it again.
      const stampEl = $('.stamp', root);
      if (stampEl && !slammed.has(token) && !reduceMotion() && 'IntersectionObserver' in window) {
        stampEl.classList.add('pre-slam');
        const io = new IntersectionObserver(
          (entries) => {
            if (entries.some((e) => e.isIntersecting)) {
              slammed.add(token);
              stampEl.classList.replace('pre-slam', 'slam');
              io.disconnect();
            }
          },
          { threshold: 0.6 }
        );
        io.observe(stampEl);
      }
      $$('.card', root).forEach((card) => {
        const t = transfers[Number(card.dataset.i)];
        const from = byId.get(t.from);
        const to = byId.get(t.to);
        $('[data-qr]', card)?.addEventListener('click', (ev) => {
          const btn = ev.currentTarget;
          const box = $('.card-qr', card);
          const open = box.hidden;
          box.hidden = !open;
          btn.setAttribute('aria-expanded', String(open));
          $('span', btn).textContent = open ? 'Hide QR' : 'Show QR';
          const q = $('.qr', box);
          if (open && !q.firstChild) {
            q.innerHTML = qrSvg(q.dataset.link);
            api.memberPaymentQr(token, to.id).then(async (base64) => {
              const src = paymentQrSource(base64);
              if (!src || !q.isConnected) return;
              const blob = await (await fetch(src)).blob();
              await readPaymentQr(blob, to.upi);
              if (!q.isConnected) return;
              const image = document.createElement('img');
              image.src = src;
              image.alt = 'Recipient?s uploaded UPI payment QR';
              q.replaceChildren(image);
              $('.qr-cap', box).textContent = `Scan ${to.name}?s QR and verify the recipient and ${rupees(t.amount)} before paying.`;
            }).catch(() => { /* Keep the generated QR if the upload is unavailable. */ });
          }
        });
        $('[data-copy-upi]', card)?.addEventListener('click', (ev) => copyText(ev.currentTarget.dataset.copyUpi, 'UPI ID copied.'));
        $('[data-add-upi]', card)?.addEventListener('click', () => go('#/profile'));
        $('[data-partial]', card)?.addEventListener('click', () => partialPaymentSheet(token, t, from, to));
        $('[data-paid]', card)?.addEventListener('click', async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          try {
            const res = await api.recordPayment(token, t.from, t.to, t.amount);
            card.classList.add('is-paid');
            if (!reduceMotion()) await wait(650);
            await afterWrite(res);
            toast(`${from.name} → ${to.name} ${rupees(t.amount)} marked paid.`, {
              action: 'Undo',
              run: async () => {
                await afterWrite(await api.deletePayment(token, res.id));
                render({ keepScroll: true });
              },
            });
            render({ keepScroll: true });
          } catch (e) {
            btn.disabled = false;
            toast(messageFor(e));
          }
        });
      });
      $$('[data-undo]', root).forEach((btn) =>
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await afterWrite(await api.deletePayment(token, btn.dataset.undo));
            toast('Payment undone.');
            render({ keepScroll: true });
          } catch (e) {
            btn.disabled = false;
            toast(messageFor(e));
          }
        })
      );
    },
  };
}

function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) if (qr.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
  }
  const size = count + 4;
  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="UPI payment QR code" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="currentColor"/></svg>`;
}

// ---------------------------------------------------------------------------
// Loading and errors
// ---------------------------------------------------------------------------
function loadingScreen() {
  return {
    html: `${bar({ back: '#/' })}${rule()}
      <section class="block skeleton" aria-busy="true" aria-label="Loading the group">
        <span class="sk sk-title"></span><span class="sk sk-meta"></span>
        <span class="sk-row"><span class="sk sk-av"></span><span class="sk sk-av"></span><span class="sk sk-av"></span><span class="sk sk-av"></span></span>
      </section>${rule()}
      <section class="block skeleton">
        <span class="sk sk-line"></span><span class="sk sk-line"></span><span class="sk sk-line"></span>
      </section>`,
  };
}

function errorScreen(err, token) {
  const notFound = err instanceof ApiError && err.code === 'trip_not_found';
  if (notFound) forgetTrip(token);
  return {
    html: `${bar({ back: '#/' })}${rule()}
      <section class="block void">
        ${notFound ? '<p class="void-stamp" aria-hidden="true">VOID</p>' : ''}
        <h1 class="h1">${notFound ? "This group link doesn't work." : "Couldn't load the group."}</h1>
        <p class="hint">${notFound ? 'Check you copied the whole link, or ask whoever made the group to send it again.' : esc(messageFor(err))}</p>
        ${notFound ? '<a class="plate" href="#/">Create a new group</a>' : '<sakuga-button class="sakuga-action" type="button" data-retry>Try again</sakuga-button>'}
      </section>`,
    bind(root) {
      $('[data-retry]', root)?.addEventListener('click', () => render());
    },
  };
}

// ---------------------------------------------------------------------------
// Sheets (menus and small forms), toasts, helpers
// ---------------------------------------------------------------------------
const sheet = $('#sheet');
function openSheet(html, bind) {
  sheet.innerHTML = `<div class="sheet-paper"><div class="sheet-scroll">${html}</div></div>`;
  bind?.(sheet);
  if (!sheet.open) sheet.showModal();
  const first = $('input, select', sheet);
  if (first && matchMedia('(hover: hover)').matches) first.focus();
}
function closeSheet() {
  if (sheet?.open) sheet.close();
}
sheet.addEventListener('click', (ev) => {
  if (ev.target === sheet) closeSheet();
});
sheet.addEventListener('close', () => {
  if (remotePending) {
    remotePending = false;
    setTimeout(onRemoteChange, 0);
  }
});

function sheetHead(title) {
  return `<div class="sheet-head"><h2 class="h2">${esc(title)}</h2><button class="bar-btn" type="button" data-close aria-label="Close">${icon('close')}</button></div>`;
}
function bindClose(root) {
  $('[data-close]', root)?.addEventListener('click', closeSheet);
}

function tripMenu(token, data, me) {
  openSheet(
    `${sheetHead(data.trip.name)}
    <ul class="menu">
      <li><button type="button" data-act="share">${icon('share', { size: 20 })}<span>Share invite link</span></button></li>
      <li><button type="button" data-act="copy">${icon('link', { size: 20 })}<span>Copy invite link</span></button></li>
      <li><button type="button" data-act="me">${icon('user', { size: 20 })}<span>Your name and UPI ID</span></button></li>
      <li><button type="button" data-act="people">${icon('users', { size: 20 })}<span>People in this group</span></button></li>
      ${data.trip.is_owner ? `<li><button type="button" data-act="rename">${icon('pencil', { size: 20 })}<span>Rename group</span></button></li>` : ''}
      <li><button type="button" data-act="profile">${icon('user', { size: 20 })}<span>Account and payment QR</span></button></li>

    </ul>`,
    (root) => {
      bindClose(root);
      const acts = {
        share: () => shareInvite(token, data.trip.name),
        copy: () => copyText(inviteUrl(token), 'Invite link copied.'),
        me: () => { closeSheet(); go('#/profile'); },
        people: () => peopleSheet(token, data, me),
        rename: () => renameSheet(token, data),
        profile: () => { closeSheet(); go('#/profile'); },
      };
      $$('[data-act]', root).forEach((b) =>
        b.addEventListener('click', () => {
          const act = b.dataset.act;
          if (act === 'share' || act === 'copy') closeSheet();
          acts[act]();
        })
      );
    }
  );
}

function peopleSheet(token, data, me) {
  const s = settleTrip(data);
  const active = new Set();
  for (const e of data.expenses) {
    active.add(e.paid_by);
    e.split.forEach((id) => active.add(id));
  }
  for (const p of data.payments) {
    active.add(p.from);
    active.add(p.to);
  }
  openSheet(
    `${sheetHead(`${plural(data.members.length, 'member')} in this group`)}
    <ul class="people">
      ${data.members
        .map((m) => {
          const r = s.rows.find((x) => x.id === m.id);
          return `<li class="person">
            ${avatar(m, { size: 'av-sm', you: m.id === me.id })}
            <span class="person-body"><span class="person-name">${esc(m.name)}${m.id === me.id ? ' <em>(you)</em>' : ''}</span>
            <span class="person-upi">${m.upi ? esc(m.upi) : 'no UPI ID'}${r && r.net ? ` · ${r.net > 0 ? 'gets' : 'owes'} ${rupees(Math.abs(r.net))}` : ''}</span></span>
            ${m.id === me.id ? `<button class="text-btn text-btn-sm" type="button" data-edit="${m.id}">Edit</button>` : ''}
            ${data.trip.is_owner && !m.linked ? `<button class="text-btn text-btn-sm" type="button" data-link-member="${m.id}">Link account</button>` : ''}
            ${data.trip.is_owner && !active.has(m.id) && m.id !== me.id ? `<button class="text-btn text-btn-sm danger" type="button" data-remove="${m.id}" aria-label="Remove ${esc(m.name)}">${icon('close', { size: 16 })}</button>` : ''}
          </li>`;
        })
        .join('')}
    </ul>
    <sakuga-button class="sakuga-action" type="button" data-share>${icon('share', { size: 18 })}<span>Invite more members</span></sakuga-button>`,
    (root) => {
      bindClose(root);
      $('[data-share]', root).addEventListener('click', () => {
        closeSheet();
        shareInvite(token, data.trip.name);
      });
      $$('[data-link-member]', root).forEach((b) => b.addEventListener('click', () => linkMemberSheet(token, b.dataset.linkMember)));
      $$('[data-edit]', root).forEach((b) =>
        b.addEventListener('click', () => memberSheet(token, data, me, data.members.find((m) => m.id === b.dataset.edit)))
      );
      $$('[data-remove]', root).forEach((b) =>
        b.addEventListener('click', () => {
          const m = data.members.find((x) => x.id === b.dataset.remove);
          confirmSheet({
            title: `Remove ${m.name}?`,
            body: "They haven't paid for or shared anything yet, so nobody's balance changes.",
            action: `Remove ${m.name}`,
            danger: true,
            run: async () => {
              await afterWrite(await api.removeMember(token, m.id));
              toast(`${m.name} removed.`);
              render({ keepScroll: true });
            },
          });
        })
      );
    }
  );
}

function memberSheet(token, data, me, member) {
  const self = member.id === me.id;
  openSheet(
    `${sheetHead(self ? 'Your details' : `${member.name}'s details`)}
    <form class="form" id="member" novalidate>
      <label class="field">
        <span class="field-label">Name</span>
        <input class="field-input" name="name" maxlength="24" autocomplete="off" value="${esc(member.name)}" required>
      </label>
      <label class="field">
        <span class="field-label">UPI ID</span>
        <input class="field-input" name="upi" readonly maxlength="120" autocomplete="off" autocapitalize="none" spellcheck="false" inputmode="email" placeholder="name@upi" value="${esc(member.upi || '')}">
      </label>
      <p class="hint">${self ? 'Members who owe you get a Pay via UPI button with your ID.' : `Double-check it with ${esc(member.name)}. Payments go to this ID.`}</p>
      <p class="form-error" role="alert" hidden></p>
      <sakuga-button class="sakuga-action" type="submit">Save</sakuga-button>
    </form>`,
    (root) => {
      bindClose(root);
      const form = $('#member', root);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const name = form.elements.name.value.trim();
        const upi = cleanUpi(form.elements.upi.value);
        const err = $('.form-error', form);
        const fail = (msg) => {
          err.textContent = msg;
          err.hidden = false;
        };
        if (!name) return fail('A name, please.');
        if (!upi.ok) return fail("That doesn't look like a UPI ID. It's like name@okaxis.");
        await busy(form, async () => {
          try {
            await afterWrite(await api.updateMember(token, member.id, name, upi.value));
            closeSheet();
            toast('Saved.');
            render({ keepScroll: true });
          } catch (e) {
            fail(messageFor(e));
          }
        });
      });
    }
  );
}

function renameSheet(token, data) {
  openSheet(
    `${sheetHead('Rename group')}
    <form class="form" id="rename" novalidate>
      <label class="field">
        <span class="field-label">Group name</span>
        <input class="field-input" name="name" maxlength="60" autocomplete="off" value="${esc(data.trip.name)}" required>
      </label>
      <p class="form-error" role="alert" hidden></p>
      <sakuga-button class="sakuga-action" type="submit">Save</sakuga-button>
    </form>`,
    (root) => {
      bindClose(root);
      const form = $('#rename', root);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const name = form.elements.name.value.trim();
        const err = $('.form-error', form);
        if (!name) {
          err.textContent = 'The group needs a name.';
          err.hidden = false;
          return;
        }
        await busy(form, async () => {
          try {
            await afterWrite(await api.renameTrip(token, name));
            rememberTrip(token, { name });
            closeSheet();
            render({ keepScroll: true });
          } catch (e) {
            err.textContent = messageFor(e);
            err.hidden = false;
          }
        });
      });
    }
  );
}

function partialPaymentSheet(token, transfer, from, to) {
  openSheet(`${sheetHead('Record a payment')}
    <form data-payment-form novalidate>
      <p class="hint">${esc(from.name)} pays ${esc(to.name)}. Outstanding: ${rupees(transfer.amount)}.</p>
      <label class="hint">Amount actually paid (rupees)
        <input class="field-input" name="amount" inputmode="decimal" autocomplete="off" placeholder="0.00">
      </label>
      <p class="hint">Record only a successful payment. The remaining balance will be recalculated.</p>
      <p class="form-error" role="alert" hidden></p>
      <button class="plate" type="submit">Record payment</button>
    </form>`, (root) => {
      bindClose(root);
      const form = $('[data-payment-form]', root);
      form.elements.amount.focus();
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const amount = parseRupees(form.elements.amount.value);
        const error = $('.form-error', form);
        if (!amount || amount > transfer.amount) {
          error.textContent = `Enter an amount above zero and no more than ${rupees(transfer.amount)}.`;
          error.hidden = false;
          return;
        }
        await busy(form, async () => {
          try {
            const result = await api.recordPayment(token, transfer.from, transfer.to, amount);
            await afterWrite(result);
            closeSheet();
            toast(`${rupees(amount)} recorded. Remaining balances updated.`);
            render({ keepScroll: true });
          } catch (err) {
            error.textContent = messageFor(err);
            error.hidden = false;
          }
        });
      });
    });
}

function confirmSheet({ title, body, action, danger = false, run }) {
  openSheet(
    `${sheetHead(title)}
    <p class="hint hint-top">${esc(body)}</p>
    <p class="form-error" role="alert" hidden></p>
    <div class="pair">
      <button class="outline" type="button" data-close-2>Cancel</button>
      <sakuga-button class="sakuga-action" type="button" data-go>${esc(action)}</sakuga-button>
    </div>`,
    (root) => {
      bindClose(root);
      $('[data-close-2]', root).addEventListener('click', closeSheet);
      const goBtn = $('[data-go]', root);
      goBtn.addEventListener('click', async () => {
        goBtn.disabled = true;
        goBtn.classList.add('is-busy');
        try {
          await run();
          closeSheet();
        } catch (e) {
          const err = $('.form-error', root);
          err.textContent = messageFor(e);
          err.hidden = false;
          goBtn.disabled = false;
          goBtn.classList.remove('is-busy');
        }
      });
    }
  );
}

async function busy(form, fn) {
  const btn = $('sakuga-button[type=submit], button[type=submit]', form);
  if (btn?.disabled) return;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-busy');
  }
  try {
    await fn();
  } finally {
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
  }
}

const toastEl = $('#toast');
let toastTimer = null;
function toast(message, { action = null, run = null, ms = 4200 } = {}) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = `<p class="toast-msg">${esc(message)}</p>${action ? `<button class="toast-act" type="button">${esc(action)}</button>` : ''}`;
  toastEl.classList.add('is-on');
  if (action) {
    $('.toast-act', toastEl).addEventListener('click', async () => {
      toastEl.classList.remove('is-on');
      try {
        await run();
      } catch (e) {
        toast(messageFor(e));
      }
    });
  }
  toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), action ? ms + 2000 : ms);
}

async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;top:0';
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      toast(text);
      ta.remove();
      return;
    }
    ta.remove();
  }
  toast(done);
}

async function shareInvite(token, name) {
  const url = inviteUrl(token);
  if (navigator.share) {
    try {
      await navigator.share({ title: `${name} · Koto Holo`, text: `Join "${name}" on Koto Holo and add what you paid:`, url });
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return;
    }
  }
  copyText(url, 'Invite link copied. Paste it in the group.');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// "123456.5" -> "1,23,456.5" while typing. Digits and one decimal point only.
function groupAmount(raw) {
  let v = String(raw).replace(/[^\d.]/g, '');
  const dot = v.indexOf('.');
  let whole = dot === -1 ? v : v.slice(0, dot);
  const frac = dot === -1 ? null : v.slice(dot + 1).replace(/\./g, '').slice(0, 2);
  whole = whole.replace(/^0+(?=\d)/, '').slice(0, 7);
  const grouped = whole.length > 3 ? whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + whole.slice(-3) : whole;
  return frac === null ? grouped : `${grouped || '0'}.${frac}`;
}

async function boot() {
  paint(loadingScreen());
  try {
    const initialSession = await initializeAuth();
    currentUser = initialSession?.user || null;
    cleanSignInReturn();
    auth.onAuthStateChange((event, next) => {
      if ((next?.user?.id || null) === (currentUser?.id || null)) return;
      currentUser = next?.user || null;
      cleanSignInReturn();
      accountProfile = null; profileLoaded = false; accountGroups = {};
      sessionStateReset();
      setTimeout(() => render(), 0);
    });
    await render();
  } catch (error) { paint(accountErrorScreen(error)); }
}

function cleanSignInReturn() {
  if (!currentUser) return;
  const url = new URL(location.href);
  if (url.searchParams.get('signed-in') !== '1') return;
  url.searchParams.delete('signed-in');
  history.replaceState(history.state, '', url.href);
}
function sessionStateReset() {
  session.watcher?.stop(); session.watcher = null; session.token = null; session.data = null; session.inflight = null;
}
boot();

// Shadow buttons submit explicitly; preserve Enter-to-submit from text fields too.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing) return;
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.form) return;
  const submit = input.form.querySelector('sakuga-button[type="submit"]');
  if (!submit) return;
  event.preventDefault();
  if (!submit.disabled) input.form.requestSubmit();
});

// Account screens share the receipt layout; authorization is enforced again in SQL.
function canEditExpense(data, me, expense) {
  return data.trip.is_owner || expense.created_by === me.id;
}
function canRecordPayment(data, me, payment) {
  return data.trip.is_owner || payment.from === me.id || payment.to === me.id;
}
function accountErrorScreen(error) {
  return {
    html: `${bar({ back: '#/' })}${rule()}<section class="block">
      <h1 class="h1">Could not open this page</h1>
      <p class="hint">${esc(error instanceof ApiError ? messageFor(error) : error?.message || 'Please try again.')}</p>
      <button class="plate" type="button" data-retry>Try again</button>
      <a class="text-btn" href="#/profile">My account</a>
    </section>`,
    bind(root) { $('[data-retry]', root).addEventListener('click', () => currentUser ? render() : boot()); },
  };
}
function signInScreen() {
  return {
    html: `${bar()}${rule()}<section class="block intro">
      <h1 class="display">Your groups.<br>Everywhere.</h1>
      <p class="lede">Sign in with Google or email to access your groups on any device.</p>
    </section>${rule()}<section class="block form">
      <button class="plate" type="button" data-clerk-signin>Sign in / Create account</button>
      <p class="hint">Secure sign-in with Clerk.</p>
      <p class="form-error" role="alert" hidden></p>
    </section>${stub('Koto Holo')}`,
    bind(root) {
      $('[data-clerk-signin]', root).addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try { await auth.openSignIn(); }
        catch (error) { const out = $('.form-error', root); out.textContent = error.message; out.hidden = false; }
        finally { button.disabled = false; }
      });
    },
  };
}
function profileScreen() {
  const profile = accountProfile || { name: currentUser?.user_metadata?.full_name?.slice(0,24) || '', upi: '' };
  const qrSource = paymentQrSource(profile.upi_qr);
  const complete = Boolean(profile.upi && qrSource);
  return {
    html: `${bar({ back: '#/' })}${rule()}<section class="block">
      <h1 class="h1">${complete ? 'My profile' : 'Finish creating your account'}</h1>
      <p class="hint">${esc(currentUser?.email || '')}</p>
      <form class="form" data-profile-form novalidate>
        <label class="field"><span class="field-label">Your name</span><input class="field-input" name="name" maxlength="24" autocomplete="name" value="${esc(profile.name)}" required></label>
        <label class="field"><span class="field-label">UPI ID</span><input class="field-input" name="upi" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(profile.upi || '')}" placeholder="name@upi" required></label>
        <label class="field"><span class="field-label">${complete ? 'Replace UPI QR' : 'Upload UPI QR'}</span><input class="field-input" type="file" name="qr" accept="image/png,image/jpeg,image/webp" ${complete ? '' : 'required'}></label>
        <p class="hint">Upload the payment QR from your UPI app for this same ID. You can update both later.</p>
        <p class="hint">Your UPI ID updates across your groups. Your profile name is used when you join new groups; existing group names stay as they are.</p>
        <p class="form-error" role="alert" hidden></p>
        <button class="plate" type="submit">${complete ? 'Save profile' : 'Complete setup'}</button>
      </form>
      ${qrSource ? `<section class="profile-qr"><h2 class="h2">Your payment QR</h2><img class="qr" src="${qrSource}" alt="Your uploaded UPI payment QR"><a class="outline" href="${qrSource}" download="koto-holo-upi-qr.png">Download QR</a></section>` : ''}
      <p class="form-error" data-signout-error role="alert" hidden></p>
      <button class="text-btn" type="button" data-signout>Sign out</button>
    </section>`,
    bind(root) {
      const form = $('[data-profile-form]', root);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const err = $('.form-error', form);
        const name = form.elements.name.value.trim();
        const upi = cleanUpi(form.elements.upi.value);
        if (!name || !upi.ok || !upi.value) { err.textContent = !name ? 'Enter your name.' : 'Enter a valid UPI ID, like name@okaxis.'; err.hidden = false; return; }
        await busy(form, async () => {
          try {
            const file = form.elements.qr.files[0];
            if (!file && (!complete || upi.value !== profile.upi)) {
              throw new Error('Upload the payment QR for this UPI ID.');
            }
            const qr = file ? await readPaymentQr(file, upi.value) : null;
            accountProfile = await api.saveProfile(name, upi.value, qr);
            profileLoaded = true;
            sessionStateReset();
            toast('Profile saved.');
            if (!complete && location.hash !== '#/profile') render();
            else { paint(profileScreen()); }
          } catch (error) { err.textContent = error instanceof ApiError ? messageFor(error) : error.message; err.hidden = false; }
        });
      });
      $('[data-signout]', root).addEventListener('click', async (event) => {
        event.currentTarget.disabled = true;
        const { error } = await auth.signOut();
        if (error) {
          const out = $('[data-signout-error]', root); out.textContent = error.message; out.hidden = false;
          $('[data-signout]', root).disabled = false;
        }
      });

    },
  };
}
function accountJoinScreen(token, data) {
  return {
    html: `${bar({ back: '#/' })}${rule()}<section class="block">
      <h1 class="display">${esc(data.trip.name)}</h1><p class="hint">${plural(data.people,'member')}. Join with your signed-in account to see the expenses.</p>
      <form class="form" data-join-account novalidate>
        <label class="field"><span class="field-label">Your name in this group</span><input class="field-input" name="name" maxlength="24" value="${esc(accountProfile.name)}" required></label>
        <p class="hint">Already listed in an older group? Ask the group owner to link your existing membership before joining.</p>
        <p class="form-error" role="alert" hidden></p>
        <button class="plate" type="submit">Join group</button>
      </form></section>`,
    bind(root) {
      const form = $('[data-join-account]', root);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        await busy(form, async () => {
          try {
            await api.join(token,form.elements.name.value.trim(),accountProfile.upi);
            sessionStateReset(); render();
          } catch (error) { const out = $('.form-error',form); out.textContent=messageFor(error); out.hidden=false; }
        });
      });
    },
  };
}
function expenseDetailScreen(token, data, expense) {
  const byId = new Map(data.members.map((m) => [m.id,m]));
  return { html: `${bar({ back: tripHash(token) })}${rule()}<section class="block">
    <h1 class="h1">${esc(expense.title)}</h1><p class="display">${rupees(expense.amount_paise)}</p>
    <p class="hint">Paid by ${esc(byId.get(expense.paid_by)?.name)}</p>
    <ul class="lines">${[...expenseShares(expense,data.members)].map(([id,share]) => `<li class="line"><span>${esc(byId.get(id)?.name)}</span><span class="leader"></span><span>${rupees(share)}</span></li>`).join('')}</ul>
    <p class="hint">Only the person who added this expense or the group owner can edit it.</p></section>` };
}
function linkMemberSheet(token, member) {
  openSheet(`${sheetHead('Link existing member')}<form class="form" data-link-account>
    <p class="hint">Ask the site administrator for this person's Clerk account ID. This gives them access to the existing member's expenses and balances. They must have signed in and saved their profile first.</p>
    <label class="field"><span class="field-label">Account ID</span><input class="field-input" name="account" autocomplete="off" placeholder="user_..." required></label>
    <p class="form-error" role="alert" hidden></p><button class="plate" type="submit">Link account</button></form>`, root => {
      bindClose(root);
      const form = $('[data-link-account]',root);
      form.addEventListener('submit',async event => {
        event.preventDefault();
        await busy(form,async () => {
          try { await afterWrite(await api.linkMember(token,member,form.elements.account.value.trim())); closeSheet(); render(); }
          catch(error) { const out=$('.form-error',form);out.textContent=messageFor(error);out.hidden=false; }
        });
      });
    });
}
