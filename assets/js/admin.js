import { auth, initializeAuth } from './auth.js';
import { messageFor, rpc } from './api.js';

const status = document.querySelector('#admin-status');
const signIn = document.querySelector('#admin-signin');
const signOut = document.querySelector('#admin-signout');
const report = document.querySelector('#admin-report');
const previous = document.querySelector('#admin-prev');
const next = document.querySelector('#admin-next');
const pageSize = 25;
const formatNumber = new Intl.NumberFormat();
let accountId;
let offset = 0;
let requestId = 0;

function fillRows(selector, users) {
  const body = document.querySelector(selector);
  body.replaceChildren();
  if (users.length === 0) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = 3;
    cell.textContent = 'No activity to show yet.';
    return;
  }
  for (const user of users) {
    const row = body.insertRow();
    row.insertCell().textContent = user.name || 'Profile incomplete';
    row.insertCell().textContent = formatNumber.format(user.days);
    row.insertCell().textContent = user.last_active || '—';
  }
}

async function loadReport() {
  const id = ++requestId;
  status.hidden = false;
  status.textContent = 'Loading activity…';
  previous.disabled = true;
  next.disabled = true;
  try {
    const data = await rpc('hs_admin_activity', { p_offset: offset });
    if (id !== requestId) return;
    for (const stat of report.querySelectorAll('[data-stat]')) {
      stat.textContent = formatNumber.format(data[stat.dataset.stat]);
    }
    fillRows('#admin-top', data.top);
    fillRows('#admin-users', data.users);
    document.querySelector('#admin-range').textContent = data.total
      ? [offset + 1, offset + data.users.length].join('–') + ' of ' + formatNumber.format(data.total)
      : '0 users';
    previous.disabled = offset === 0;
    next.disabled = offset + pageSize >= data.total;
    report.hidden = false;
    status.hidden = true;
  } catch (error) {
    if (id !== requestId) return;
    report.hidden = true;
    status.textContent = error.code === 'forbidden'
      ? 'This account does not have admin access.'
      : error.code === 'setup_required'
        ? 'Admin activity has not been enabled yet.'
        : messageFor(error);
  }
}

function applySession(session) {
  const userId = session?.user?.id ?? null;
  if (userId === accountId) return;
  accountId = userId;
  offset = 0;
  ++requestId;
  report.hidden = true;
  document.querySelector('#admin-users').replaceChildren();
  document.querySelector('#admin-top').replaceChildren();
  for (const stat of report.querySelectorAll('[data-stat]')) stat.textContent = '';
  signIn.hidden = Boolean(userId);
  signOut.hidden = !userId;
  if (userId) {
    const url = new URL(location.href);
    url.searchParams.delete('signed-in');
    history.replaceState(history.state, '', url.pathname + url.search);
    loadReport();
  } else {
    status.hidden = false;
    status.textContent = 'Sign in with an approved admin account.';
  }
}

signIn.addEventListener('click', async () => {
  signIn.disabled = true;
  try { await auth.openSignIn(); }
  catch (error) { status.textContent = error.message; }
  finally { signIn.disabled = false; }
});
signOut.addEventListener('click', async () => {
  const { error } = await auth.signOut();
  if (error) {
    status.hidden = false;
    status.textContent = 'Sign-out failed. Please try again.';
  }
});
previous.addEventListener('click', () => { offset -= pageSize; loadReport(); });
next.addEventListener('click', () => { offset += pageSize; loadReport(); });

try {
  const session = await initializeAuth();
  auth.onAuthStateChange((_event, nextSession) => applySession(nextSession));
  if (accountId === undefined) applySession(session);
} catch (error) {
  status.textContent = error.message || 'Could not load sign-in. Please try again.';
}
