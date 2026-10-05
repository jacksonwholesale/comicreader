import { APP } from '../config';
import { getKV } from '../db';

/**
 * Google Drive access via Google Identity Services (browser-only OAuth, no backend).
 * Scopes:
 *  - drive.appdata: hidden per-app folder holding the sync file (progress, collections, sessions)
 *  - drive.file: files this app creates (comics you upload from the app)
 *  - drive.readonly: read access so folders you link can be listed and streamed. The app
 *    never edits or deletes anything outside its own files.
 */
const READONLY = 'https://www.googleapis.com/auth/drive.readonly';
const SCOPES = `https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file ${READONLY}`;
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

declare global {
  interface Window {
    google?: any;
  }
}

export async function getClientId(): Promise<string> {
  return (await getKV<string>('googleClientId', '')) || import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
}

let gisPromise: Promise<void> | null = null;
function loadGis() {
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        gisPromise = null;
        reject(new Error('Could not load Google sign-in (offline?)'));
      };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

interface Token {
  access: string;
  expires: number;
}

function readToken(): Token | null {
  try {
    const t = JSON.parse(localStorage.getItem('drive.token') || 'null') as Token | null;
    return t && t.expires > Date.now() + 60_000 ? t : null;
  } catch {
    return null;
  }
}

export function isConnected() {
  try {
    return localStorage.getItem('drive.connected') === '1';
  } catch {
    return false;
  }
}

export function hasValidToken() {
  return !!readToken();
}

let pending: Promise<string> | null = null;

// The token client is created ahead of time so a tap on "Connect" can open Google's window
// immediately. iPhone Safari only allows a window opened directly inside the tap — any waiting
// first (loading Google's script) makes it fail with "Failed to open window".
let tokenClient: any = null;
let tokenClientFor = '';
let waiting: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;

function storeToken(access: string, expiresIn: number, scope: string) {
  localStorage.setItem('drive.token', JSON.stringify({ access, expires: Date.now() + expiresIn * 1000 }));
  localStorage.setItem('drive.scopes', scope);
  localStorage.setItem('drive.connected', '1');
}

/** Load Google sign-in and set up the token client now, so the next tap can open it instantly. */
export async function prepareGoogle(clientId?: string): Promise<boolean> {
  const id = clientId ?? (await getClientId());
  if (!id) return false;
  await loadGis();
  if (tokenClient && tokenClientFor === id) return true;
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: id,
    scope: SCOPES,
    callback: (resp: any) => {
      if (resp.error) return waiting?.reject(new Error(resp.error_description || resp.error));
      storeToken(resp.access_token, Number(resp.expires_in), String(resp.scope ?? ''));
      waiting?.resolve(resp.access_token);
    },
    error_callback: (err: any) =>
      waiting?.reject(new PopupError(err?.type === 'popup_failed_to_open' ? 'Failed to open window' : err?.message || err?.type || 'Sign-in cancelled', err?.type)),
  });
  tokenClientFor = id;
  localStorage.setItem('drive.clientId', id);
  return true;
}

export function isGoogleReady() {
  return !!tokenClient;
}

export class PopupError extends Error {
  constructor(
    message: string,
    public kind?: string,
  ) {
    super(message);
  }
}

/** interactive=true must be called straight from a tap, with no awaiting before it. */
export function requestToken(interactive: boolean): Promise<string> {
  if (pending) return pending;
  const ask = () =>
    new Promise<string>((resolve, reject) => {
      waiting = { resolve, reject };
      // Always show the account chooser when connecting, so a browser signed into several
      // Google accounts never silently picks the wrong one. Background renewals are pinned
      // to the account chosen then.
      tokenClient.requestAccessToken({
        prompt: interactive ? 'select_account consent' : '',
        login_hint: interactive ? undefined : connectedEmail(),
        hint: interactive ? undefined : connectedEmail(),
      });
    });
  pending = (
    tokenClient
      ? ask() // ready: the window opens inside this tap
      : prepareGoogle().then((ok) => {
          if (!ok) throw new Error('Add your Google OAuth Client ID in Settings first.');
          return ask();
        })
  ).finally(() => {
    pending = null;
    waiting = null;
  });
  return pending;
}

/**
 * Backup sign-in for when a pop-up can't open (some iPhone home-screen apps): go to Google's
 * page and come back. Needs the app's address listed under "Authorized redirect URIs".
 */
export function redirectUri() {
  return location.origin + location.pathname;
}

function authUrl(clientId: string, prompt: string, returnTo: string) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPES,
    include_granted_scopes: 'true',
    prompt,
    // where to land afterwards (the screen you were on)
    state: `cr-auth|${prompt === 'none' ? 'silent' : 'ask'}|${returnTo}`,
  });
  const hint = connectedEmail();
  if (hint) params.set('login_hint', hint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function signInWithRedirect(returnTo = '#/settings') {
  const clientId = await getClientId();
  if (!clientId) throw new Error('Add your Google OAuth Client ID in Settings first.');
  location.assign(authUrl(clientId, 'select_account consent', returnTo));
}

// ---- staying signed in ----
// Google's tokens last an hour and phones block renewing them in a pop-up. Once you've signed in
// through Google's page (proving this app's address is registered), the app renews by bouncing
// through Google with prompt=none: no screen, no tap, back where you were in about a second.

const REDIRECT_OK = 'drive.redirectOk';

export function staysSignedIn() {
  try {
    return localStorage.getItem(REDIRECT_OK) === '1';
  } catch {
    return false;
  }
}

/** Starts a silent renewal (the page navigates away and comes back). False if not possible right now. */
export function silentRenew(): boolean {
  if (!staysSignedIn() || !isConnected() || document.visibilityState !== 'visible' || !navigator.onLine) return false;
  const clientId = tokenClientFor || localStorage.getItem('drive.clientId');
  if (!clientId) return false;
  // never loop: at most one attempt every 2 minutes, and not after Google said a tap is needed
  const last = Number(sessionStorage.getItem('auth.silentAt')) || 0;
  if (Date.now() - last < 120_000 || sessionStorage.getItem('auth.silentFailed')) return false;
  sessionStorage.setItem('auth.silentAt', String(Date.now()));
  location.replace(authUrl(clientId, 'none', location.hash || '#/'));
  return true;
}

/** Renew ahead of time if the token is about to run out (call on launch / when the app comes back). */
export function renewIfExpiring(minutesLeft = 5) {
  if (!staysSignedIn() || !isConnected()) return;
  try {
    const t = JSON.parse(localStorage.getItem('drive.token') || 'null') as Token | null;
    if (!t || t.expires - Date.now() < minutesLeft * 60_000) silentRenew();
  } catch {}
}

/** On startup: pick up the token Google sends back after a redirect sign-in. Returns an error message, if any. */
export function finishRedirectSignIn(): { done: boolean; error?: string; silent?: boolean } {
  const h = location.hash.replace(/^#/, '');
  if (!/(^|&)(access_token|error)=/.test(h)) return { done: false };
  const q = new URLSearchParams(h);
  const [tag, mode, returnTo] = (q.get('state') ?? '').split('|');
  if (tag !== 'cr-auth') return { done: false };
  const silent = mode === 'silent';
  history.replaceState(null, '', `${location.pathname}${location.search}${returnTo && returnTo.startsWith('#') ? returnTo : '#/settings'}`);
  if (q.get('error')) {
    // silent renewal needs a tap after all (signed out of Google, etc.): show Reconnect, don't retry this session
    if (silent) sessionStorage.setItem('auth.silentFailed', '1');
    return { done: true, silent, error: q.get('error') === 'access_denied' ? 'Sign-in cancelled' : q.get('error')! };
  }
  storeToken(q.get('access_token')!, Number(q.get('expires_in') || 3600), q.get('scope') ?? '');
  localStorage.setItem(REDIRECT_OK, '1');
  sessionStorage.removeItem('auth.silentFailed');
  return { done: true, silent };
}

/** True once the user has granted read access for linked folders (added after first release). */
export function hasFolderAccess() {
  try {
    return (localStorage.getItem('drive.scopes') ?? '').includes(READONLY);
  } catch {
    return false;
  }
}

/** The Google account Drive sync is connected to on this device. */
export function connectedEmail(): string | undefined {
  try {
    return localStorage.getItem('drive.email') || undefined;
  } catch {
    return undefined;
  }
}

export function disconnect() {
  const t = readToken();
  if (t && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(t.access, () => {});
  localStorage.removeItem('drive.token');
  localStorage.removeItem('drive.connected');
  localStorage.removeItem('drive.email');
  localStorage.removeItem('drive.scopes');
  localStorage.removeItem(REDIRECT_OK);
}

export class NeedsSignIn extends Error {
  constructor() {
    super('Google Drive session expired — tap "Reconnect" in Settings.');
  }
}

async function token(): Promise<string> {
  const t = readToken();
  if (t) return t.access;
  if (!isConnected()) throw new NeedsSignIn();
  // stay signed in: bounce through Google and come back (this page is about to reload)
  if (silentRenew()) return new Promise<string>(() => {});
  try {
    return await requestToken(false);
  } catch {
    throw new NeedsSignIn();
  }
}

async function api(url: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${await token()}` } });
  if (res.status === 401 && retry) {
    localStorage.removeItem('drive.token');
    return api(url, init, false);
  }
  if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

export async function getAccountEmail(): Promise<string | undefined> {
  const res = await api(`${API}/about?fields=user(emailAddress)`);
  const email: string | undefined = (await res.json()).user?.emailAddress;
  if (email) localStorage.setItem('drive.email', email);
  return email;
}

// ---- sync file (appDataFolder) ----

export async function findSyncFile(): Promise<{ id: string; modifiedTime: string } | null> {
  const q = encodeURIComponent(`name='${APP.syncFile}' and trashed=false`);
  const res = await api(`${API}/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`);
  return (await res.json()).files?.[0] ?? null;
}

export async function readSyncFile(id: string): Promise<unknown> {
  return (await api(`${API}/files/${id}?alt=media`)).json();
}

export async function writeSyncFile(id: string | null, data: unknown): Promise<string> {
  const body = JSON.stringify(data);
  if (id) {
    await api(`${UPLOAD}/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    return id;
  }
  const meta = { name: APP.syncFile, parents: ['appDataFolder'], mimeType: 'application/json' };
  const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', body: multipart(meta, body, 'application/json') });
  return (await res.json()).id;
}

function multipart(meta: object, body: BlobPart, type: string) {
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', new Blob([body], { type }));
  return form;
}

// ---- comic files (visible "<App>/Comics" folder) ----

const folderCache = new Map<string, string>();
async function ensureFolder(name: string, parent?: string): Promise<string> {
  const key = `${parent ?? 'root'}/${name}`;
  const cached = folderCache.get(key);
  if (cached) return cached;
  const q = encodeURIComponent(
    `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false` +
      (parent ? ` and '${parent}' in parents` : ''),
  );
  const found = (await (await api(`${API}/files?q=${q}&fields=files(id)`)).json()).files?.[0]?.id;
  const id =
    found ??
    (
      await (
        await api(`${API}/files?fields=id`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: parent ? [parent] : undefined }),
        })
      ).json()
    ).id;
  folderCache.set(key, id);
  return id;
}

export async function comicsFolder() {
  return ensureFolder('Comics', await ensureFolder(APP.driveFolder));
}

/** Resumable upload so large comics show progress and survive flaky mobile connections better. */
export async function uploadComic(blob: Blob, name: string, onProgress?: (fraction: number) => void): Promise<string> {
  const parent = await comicsFolder();
  const init = await api(`${UPLOAD}/files?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Length': String(blob.size) },
    body: JSON.stringify({ name, parents: [parent] }),
  });
  const location = init.headers.get('Location');
  if (!location) throw new Error('Drive did not return an upload URL');
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', location);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve(JSON.parse(xhr.responseText).id) : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Upload failed (network)'));
    xhr.send(blob);
  });
}

export async function downloadComic(fileId: string, onProgress?: (fraction: number) => void): Promise<Blob> {
  const res = await api(`${API}/files/${fileId}?alt=media`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body || !total) return res.blob();
  const reader = res.body.getReader();
  const chunks: BlobPart[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as BlobPart);
    loaded += value.length;
    onProgress?.(loaded / total);
  }
  return new Blob(chunks);
}

export async function deleteDriveFile(fileId: string) {
  await api(`${API}/files/${fileId}`, { method: 'DELETE' }).catch(() => {});
}

// ---- linked folders: listing and byte-range streaming ----

export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  parents?: string[];
}

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Children of a folder ('root' = My Drive). Folders and files, all pages. */
export async function listChildren(folderId: string, foldersOnly = false): Promise<DriveItem[]> {
  const out: DriveItem[] = [];
  let pageToken = '';
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false${foldersOnly ? ` and mimeType='${FOLDER_MIME}'` : ''}`);
  do {
    const res = await api(
      `${API}/files?q=${q}&pageSize=1000&orderBy=folder,name_natural&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ''}`,
    );
    const json = await res.json();
    out.push(...json.files.map((f: any) => ({ ...f, size: f.size ? Number(f.size) : undefined })));
    pageToken = json.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

export async function getItem(id: string): Promise<DriveItem> {
  const res = await api(`${API}/files/${id}?fields=id,name,mimeType,size,modifiedTime,parents&supportsAllDrives=true`);
  const f = await res.json();
  return { ...f, size: f.size ? Number(f.size) : undefined };
}

/** Bytes [start, end] (inclusive) of a Drive file, without downloading the rest. */
export async function fetchRange(fileId: string, start: number, end: number): Promise<Uint8Array> {
  const res = await api(`${API}/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Range: `bytes=${start}-${end}` } });
  const buf = new Uint8Array(await res.arrayBuffer());
  // A server that ignores Range sends the whole file; slice so callers always get what they asked for.
  return res.status === 206 ? buf : buf.subarray(start, end + 1);
}

/** Folders other people shared with you (top level of "Shared with me"). */
export async function listSharedFolders(): Promise<DriveItem[]> {
  const q = encodeURIComponent(`sharedWithMe and mimeType='${FOLDER_MIME}' and trashed=false`);
  const res = await api(`${API}/files?q=${q}&pageSize=200&orderBy=name_natural&fields=files(id,name,mimeType)`);
  return (await res.json()).files ?? [];
}
