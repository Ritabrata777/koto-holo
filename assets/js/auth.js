import { Clerk } from '../vendor/clerk.js';
import { CLERK_PUBLISHABLE_KEY } from '../../config.js';

let clerk;
let loading;
let observedSession;
const activeSession = () => observedSession === undefined ? clerk?.session : observedSession;

function normalizedSession(session, user = session?.user) {
  if (!user || session?.status !== 'active') return null;
  return { user: { id: user.id, email: user.primaryEmailAddress?.emailAddress || '',
    user_metadata: { full_name: user.fullName || user.firstName || '' } } };
}
async function loadClerk() {
  if (clerk) return clerk;
  if (loading) return loading;
  loading = (async () => {
    if (!/^pk_(test|live)_/.test(CLERK_PUBLISHABLE_KEY)) {
      throw new Error('Clerk is not configured yet. Add the Clerk publishable key to config.js.');
    }
    const domain = atob(CLERK_PUBLISHABLE_KEY.split('_')[2]).replace(/\$$/, '');
    if (!/^[a-z0-9.-]+$/i.test(domain)) throw new Error('The Clerk publishable key is invalid.');
    // Clerk Core 3 loads its UI separately from the session SDK.
    if (!window.__internal_ClerkUICtor) await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const timer = setTimeout(() => { script.remove(); reject(new Error('Clerk took too long to load. Please try again.')); }, 20000);
      script.src = `https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`;
      script.async = true; script.crossOrigin = 'anonymous';
      script.onload = () => { clearTimeout(timer); resolve(); };
      script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Could not load Clerk. Check your connection and try again.')); };
      document.head.appendChild(script);
    });
    const instance = new Clerk(CLERK_PUBLISHABLE_KEY);
    await instance.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
    clerk = instance;
    return clerk;
  })().catch(error => { loading = null; throw error; });
  return loading;
}
export async function initializeAuth() {
  const instance = await loadClerk();
  return normalizedSession(instance.session, instance.user);
}
export async function accessToken() {
  await loadClerk();
  const session = activeSession();
  return session?.status === 'active' ? session.getToken() : null;
}
export const auth = {
  onAuthStateChange(callback) {
    return clerk.addListener(({ session, user }) => {
      if (session === undefined) return;
      observedSession = session;
      const next = normalizedSession(session, user ?? session?.user);
      callback(next ? 'SIGNED_IN' : 'SIGNED_OUT', next);
    });
  },
  async openSignIn() {
    const instance = await loadClerk();
    const destination = new URL(location.pathname, location.origin);
    // Clerk's redirect must change more than the fragment to reload the app
    // when an OAuth or email flow completes outside this document.
    destination.searchParams.set('signed-in', '1');
    destination.hash = location.hash.startsWith('#/') ? location.hash : '#/';
    await instance.openSignIn({ forceRedirectUrl: destination.href, signUpForceRedirectUrl: destination.href });
  },
  async signOut() {
    try { await clerk.signOut(); return { error: null }; }
    catch (error) { return { error }; }
  },
};
