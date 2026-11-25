// Thin client for the hs_* Postgres functions (PostgREST RPC). No SDK needed.
import { accessToken } from './auth.js';
import { SUPABASE_URL, SUPABASE_API_KEY } from '../../config.js';

export class ApiError extends Error {
  constructor(code, status, detail) {
    super(code);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const MESSAGES = {
  sign_in_required: 'Sign in to continue.',
  auth_setup_required: 'Clerk login succeeded, but database access is not configured. Enable the Clerk?Supabase integration and run migration 003.',
  forbidden: 'You do not have permission to make this change.',
  not_a_member: 'Join this group to view its expenses.',
  legacy_group_locked: 'This older group needs its owner linked to a verified account. Ask the site administrator to restore access; your expenses are preserved.',
  account_not_found: 'That person must sign in and save their profile first. Check their account ID.',
  account_already_linked: 'That account is already a member of this group.',
  setup_required: 'Account setup is not finished on the server. Please contact the site administrator.',

  trip_not_found: "This group link doesn't work. Check you copied all of it.",
  name_taken: 'Someone in this group already has that name. Add an initial?',
  name_required: 'Type a name first.',
  name_too_long: "That's a bit long. Keep it short.",
  bad_upi: "That doesn't look like a UPI ID. It's like name@okaxis.",
  payment_profile_required: 'Save your UPI ID and payment QR to continue.',
  bad_qr: 'Upload a valid payment QR image for your UPI ID.',
  bad_shares: 'Shares must match the selected people and add up to the bill.',
  bad_amount: 'Enter an amount, like 1350 or 249.50.',
  split_required: 'Pick at least one person to split it between.',
  member_not_found: 'That person is no longer in this group. Refresh and try again.',
  expense_not_found: 'That expense was deleted by someone else.',
  payment_not_found: 'That payment was already undone.',
  member_has_activity: "They've already got money in this group, so they can't be removed.",
  trip_full: 'This group has hit its limit.',
  same_member: "Someone can't pay themselves.",
  network: "Couldn't reach the server. Check your connection and try again.",
  paused: 'The server is waking up. Try again in a minute.',
};

export function messageFor(err) {
  if (err instanceof ApiError) return MESSAGES[err.code] || 'Something went wrong. Try again.';
  return MESSAGES.network;
}

export async function rpc(name, args = {}, { signal } = {}) {
  const token = await accessToken();
  if (!token) throw new ApiError('sign_in_required', 401);
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_API_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError('network', 0, String(e));
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const code = typeof body?.message === 'string' && MESSAGES[body.message] ? body.message : res.status === 401 || body?.code === '42501' ? 'auth_setup_required' : body?.code === 'PGRST202' ? 'setup_required' : res.status >= 500 ? 'paused' : 'unknown';
    throw new ApiError(code, res.status, body);
  }
  return body;
}

export const api = {
  profile: () => rpc('hs_get_profile'),
  saveProfile: (name, upi, qr) => rpc('hs_save_payment_profile', { p_name: name, p_upi: upi, p_upi_qr: qr }),
  memberPaymentQr: (token, member) => rpc('hs_member_payment_qr', { p_token: token, p_member: member }),
  groups: () => rpc('hs_my_groups'),
  invite: (token) => rpc('hs_invite_info', { p_token: token }),
  linkMember: (token, member, account) => rpc('hs_link_member', { p_token: token, p_member: member, p_account: account }),
  createTrip: (name, memberName, upi) => rpc('hs_create_trip', { p_name: name, p_member_name: memberName, p_member_upi: upi || null }),
  getTrip: (token, opts) => rpc('hs_get_trip', { p_token: token }, opts),
  version: (token, opts) => rpc('hs_trip_version', { p_token: token }, opts),
  renameTrip: (token, name) => rpc('hs_rename_trip', { p_token: token, p_name: name }),
  join: (token, name, upi) => rpc('hs_join_trip', { p_token: token, p_name: name, p_upi: upi || null }),
  updateMember: (token, member, name, upi) => rpc('hs_update_member', { p_token: token, p_member: member, p_name: name, p_upi: upi || null }),
  removeMember: (token, member) => rpc('hs_remove_member', { p_token: token, p_member: member }),
  addExpense: (token, e, actor) =>
    rpc('hs_add_expense_v2', { p_shares: e.shares ?? null, p_token: token, p_title: e.title, p_amount_paise: e.amount_paise, p_paid_by: e.paid_by, p_split: e.split, p_actor: actor || null }),
  updateExpense: (token, id, e) =>
    rpc('hs_update_expense_v2', { p_shares: e.shares ?? null, p_token: token, p_expense: id, p_title: e.title, p_amount_paise: e.amount_paise, p_paid_by: e.paid_by, p_split: e.split }),
  deleteExpense: (token, id) => rpc('hs_delete_expense', { p_token: token, p_expense: id }),
  recordPayment: (token, from, to, amount) => rpc('hs_record_payment', { p_token: token, p_from: from, p_to: to, p_amount_paise: amount }),
  deletePayment: (token, id) => rpc('hs_delete_payment', { p_token: token, p_payment: id }),
};
