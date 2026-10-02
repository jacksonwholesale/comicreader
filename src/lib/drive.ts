import { APP } from '../config';
import { getKV } from '../db';

/**
 * Google Drive access via Google Identity Services (browser-only OAuth, no backend).
 * Scopes:
 *  - drive.appdata: hidden per-app folder holding the sync file (progress, collections, sessions)
 *  - drive.file: only files this app creates, i.e. comics you upload; it cannot see the rest of your Drive
 */
const SCOPES = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file';
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

/** interactive=true must be called from a click handler so the popup is not blocked. */
export function requestToken(interactive: boolean): Promise<string> {
  if (pending) return pending;
  pending = (async () => {
    const clientId = await getClientId();
    if (!clientId) throw new Error('Add your Google OAuth Client ID in Settings first.');
    await loadGis();
    return new Promise<string>((resolve, reject) => {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPES,
        // Always show the account chooser when connecting, so a browser signed into several
        // Google accounts never silently picks the wrong one. Background renewals are pinned
        // to the account chosen then.
        prompt: interactive ? 'select_account consent' : '',
        login_hint: interactive ? undefined : connectedEmail(),
        callback: (resp: any) => {
          if (resp.error) return reject(new Error(resp.error_description || resp.error));
          const token = { access: resp.access_token, expires: Date.now() + Number(resp.expires_in) * 1000 };
          localStorage.setItem('drive.token', JSON.stringify(token));
          localStorage.setItem('drive.connected', '1');
          resolve(token.access);
        },
        error_callback: (err: any) => reject(new Error(err?.message || err?.type || 'Sign-in cancelled')),
      });
      client.requestAccessToken();
    });
  })().finally(() => {
    pending = null;
  });
  return pending;
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
