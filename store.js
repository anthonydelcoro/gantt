/* Firebase layer.

   Everything is written field by field rather than as one document, so two
   people editing different rows never overwrite each other. Only inputs are
   stored (durations, links, overrides). Dates are computed in each browser
   from those inputs, so everyone sees the same chart without anyone having to
   agree on who recalculates. */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getDatabase, ref, onValue, update, set, remove, onDisconnect, serverTimestamp, get
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';

import { firebaseConfig, ALLOWED_DOMAIN, SCHEDULE_PATH } from './config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

const P = SCHEDULE_PATH;
let currentUser = null;

/* ------------------------------------------------------------------ auth */

export function watchUser(onIn, onOut) {
  onAuthStateChanged(auth, user => {
    if (!user) { currentUser = null; onOut(null); return; }
    const email = (user.email || '').toLowerCase();
    if (ALLOWED_DOMAIN && !email.endsWith('@' + ALLOWED_DOMAIN)) {
      signOut(auth);
      currentUser = null;
      onOut(`${user.email} is not a ${ALLOWED_DOMAIN} account. Sign in with your university account.`);
      return;
    }
    currentUser = user;
    onIn(user);
  });
}

export async function signIn() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: ALLOWED_DOMAIN, prompt: 'select_account' });
  await signInWithPopup(auth, provider);
}

export function leave() { return signOut(auth); }
export function user() { return currentUser; }

export function friendlyAuthError(err) {
  const code = err && err.code || '';
  if (code === 'auth/popup-closed-by-user') return '';
  if (code === 'auth/popup-blocked') return 'Your browser blocked the sign in popup. Allow popups for this site and try again.';
  if (code === 'auth/unauthorized-domain') {
    return 'This domain is not in the Firebase authorised list. Add it under Authentication, Settings, Authorized domains.';
  }
  return (err && err.message) || 'Sign in failed.';
}

/* --------------------------------------------------------------- reading */

/* Objects come back from Firebase as maps keyed by id. Turn them into arrays
   and put the key on each record. */
function toList(obj) {
  if (!obj) return [];
  return Object.entries(obj).map(([id, v]) => ({ id, ...v }));
}

export function subscribe(handlers) {
  const stop = [];
  stop.push(onValue(ref(db, `${P}/meta`), s => handlers.meta(s.val() || {})));
  stop.push(onValue(ref(db, `${P}/tasks`), s => handlers.tasks(toList(s.val()))));
  stop.push(onValue(ref(db, `${P}/links`), s => handlers.links(toList(s.val()))));
  stop.push(onValue(ref(db, `${P}/presence`), s => handlers.presence(toList(s.val()))));
  return () => stop.forEach(fn => fn());
}

export function onPermissionError(cb) { permissionHandler = cb; }
let permissionHandler = null;

function guard(promise) {
  return promise.catch(err => {
    const msg = String(err && err.message || err);
    if (/permission_denied|PERMISSION_DENIED/i.test(msg) && permissionHandler) {
      permissionHandler();
    } else {
      console.error(err);
    }
    throw err;
  });
}

/* --------------------------------------------------------------- writing */

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function patchTask(id, fields) {
  return guard(update(ref(db, `${P}/tasks/${id}`), fields));
}

export function createTask(id, task) {
  return guard(set(ref(db, `${P}/tasks/${id}`), task));
}

/* Removing a row takes its descendants and every link touching any of them,
   in one atomic write so the chart never renders a dangling dependency. */
export function removeTasks(ids, linkIds) {
  const patch = {};
  for (const id of ids) patch[`tasks/${id}`] = null;
  for (const id of linkIds) patch[`links/${id}`] = null;
  return guard(update(ref(db, P), patch));
}

export function createLink(id, link) {
  return guard(set(ref(db, `${P}/links/${id}`), link));
}

export function removeLink(id) {
  return guard(remove(ref(db, `${P}/links/${id}`)));
}

export function patchMeta(fields) {
  return guard(update(ref(db, `${P}/meta`), fields));
}

/* Used by undo and by the row reorder, which touches several rows at once. */
export function applyPatch(patch) {
  return guard(update(ref(db, P), patch));
}

export async function loadAll() {
  const snap = await get(ref(db, P));
  return snap.val();
}

/* -------------------------------------------------------------- presence */

export function announce(user) {
  const node = ref(db, `${P}/presence/${user.uid}`);
  onDisconnect(node).remove();
  set(node, {
    name: user.displayName || user.email,
    photo: user.photoURL || '',
    at: serverTimestamp()
  }).catch(() => { });
  window.addEventListener('beforeunload', () => { remove(node); });
}

/* ------------------------------------------------------------------ seed */

export async function seedIfEmpty(starter) {
  const snap = await get(ref(db, `${P}/tasks`));
  if (snap.exists()) return false;
  await guard(update(ref(db, P), starter));
  return true;
}
