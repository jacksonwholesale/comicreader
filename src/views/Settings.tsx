import { useLiveQuery } from 'dexie-react-hooks';
import { Cloud, CloudOff, Download, RefreshCw, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { APP } from '../config';
import { db, getKV, setKV } from '../db';
import { connectedEmail, getAccountEmail, getClientId, isConnected } from '../lib/drive';
import { formatBytes, timeAgo } from '../lib/library';
import { setPrefs, usePrefs } from '../lib/prefs';
import { connectDrive, disconnectDrive, syncNow } from '../lib/sync';
import { device, markDirty } from '../lib/syncState';
import { useSyncStatus } from '../lib/useLibrary';
import { PrefControls, Seg } from '../components/reader/ReaderSettings';

export function Settings({ notify }: { notify: (m: string) => void }) {
  const prefs = usePrefs();
  const status = useSyncStatus();
  const [clientId, setClientId] = useState('');
  const [email, setEmail] = useState<string | undefined>(connectedEmail);
  const [deviceName, setDeviceName] = useState(device.name);
  const [storage, setStorage] = useState<{ usage?: number; quota?: number }>({});
  const counts = useLiveQuery(async () => ({ comics: await db.comics.filter((c) => !c.deleted).count(), local: await db.comics.where('hasFile').equals(1).count() }), [], { comics: 0, local: 0 });

  useEffect(() => {
    void getClientId().then(setClientId);
    void navigator.storage?.estimate?.().then((e) => setStorage({ usage: e.usage, quota: e.quota }));
  }, []);
  useEffect(() => {
    if (isConnected() && status.state === 'idle') getAccountEmail().then(setEmail, () => {});
  }, [status.state]);

  const connected = status.state !== 'off';

  return (
    <div className="view settings">
      <header className="view-head"><h1>Settings</h1></header>

      <section className="panel">
        <h2><Cloud size={20} /> Google Drive sync</h2>
        <p className="muted small">
          Keeps reading progress, bookmarks, collections, reading sessions and settings in step between your phone and computer. Comic files are copied to a
          “{APP.driveFolder}/Comics” folder in your Drive only when you upload them or turn on Drive sync for a collection. {APP.name} can only see files it created.
        </p>
        {!connected ? (
          <>
            <label className="field">
              <span>Google OAuth Client ID</span>
              <input
                value={clientId}
                placeholder="xxxxxxxx.apps.googleusercontent.com"
                onChange={(e) => setClientId(e.target.value.trim())}
                onBlur={() => void setKV('googleClientId', clientId)}
              />
            </label>
            <p className="muted small">
              One-time setup — see “Google Drive sync setup” in the README. Use the same Client ID on every device. When you connect, Google asks which
              account to use — pick the same one on your phone and computer.
            </p>
            <button
              className="btn primary"
              disabled={!clientId}
              onClick={async () => {
                await setKV('googleClientId', clientId);
                connectDrive().then(
                  () => {
                    setEmail(connectedEmail());
                    notify(`Connected as ${connectedEmail() ?? 'your Google account'}`);
                  },
                  (e) => notify((e as Error).message),
                );
              }}
            >
              <Cloud size={18} /> Connect Google Drive
            </button>
          </>
        ) : (
          <>
            <div className="sync-status">
              <span className={`status-dot ${status.state}`} />
              <div className="grow">
                <strong>{email ? `Connected as ${email}` : 'Connected'}</strong>
                <span className="muted small">
                  {status.state === 'syncing'
                    ? 'Syncing…'
                    : status.state === 'error'
                      ? status.message
                      : `Last synced ${timeAgo('lastSync' in status ? status.lastSync : undefined)}`}
                </span>
              </div>
              {status.state === 'error' && status.needsSignIn ? (
                <button className="btn small primary" onClick={() => connectDrive().catch((e) => notify((e as Error).message))}>Reconnect</button>
              ) : (
                <button className="btn small" disabled={status.state === 'syncing'} onClick={() => void syncNow()}><RefreshCw size={16} /> Sync now</button>
              )}
            </div>
            <div className="row gap wrap">
              <button
                className="btn small"
                onClick={() => {
                  disconnectDrive();
                  setEmail(undefined);
                  connectDrive().then(
                    () => {
                      setEmail(connectedEmail());
                      notify(`Connected as ${connectedEmail() ?? 'new account'}`);
                    },
                    (e) => notify((e as Error).message),
                  );
                }}
              >
                Switch Google account
              </button>
              <button className="btn ghost small" onClick={() => confirm('Disconnect Google Drive on this device? Nothing is deleted.') && disconnectDrive()}>
                <CloudOff size={16} /> Disconnect
              </button>
            </div>
          </>
        )}
        <label className="field">
          <span>This device's name</span>
          <input
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            onBlur={() => {
              device.name = deviceName;
              setDeviceName(device.name);
            }}
          />
        </label>
        <p className="muted small">Shown in reading history and in “continue on…” prompts.</p>
      </section>

      <section className="panel">
        <h2>Appearance</h2>
        <Seg value={prefs.theme} onChange={(theme) => setPrefs({ theme })} options={[['dark', 'Dark'], ['light', 'Light'], ['system', 'System']]} />
      </section>

      <section className="panel prefs-panel">
        <h2>Reading defaults</h2>
        <p className="muted small">Change layout and direction per comic from inside the reader; these are the defaults.</p>
        <PrefControls prefs={prefs} showDefaults />
      </section>

      <section className="panel">
        <h2>Storage</h2>
        <p>
          {counts.comics} comics in library · {counts.local} stored on this device
          {storage.usage !== undefined && ` · ${formatBytes(storage.usage)} used`}
          {storage.quota ? ` of ${formatBytes(storage.quota)} available` : ''}
        </p>
        <div className="row gap wrap">
          <button
            className="btn"
            onClick={async () => {
              const ok = await navigator.storage?.persist?.();
              notify(ok ? 'Storage marked as persistent' : 'The browser decided not to grant persistent storage');
            }}
          >
            Keep my comics (persistent storage)
          </button>
          <button className="btn" onClick={() => void exportBackup()}><Download size={16} /> Export backup</button>
          <label className="btn">
            <Upload size={16} /> Import backup
            <input type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && importBackup(e.target.files[0]).then(() => notify('Backup restored'), (err) => notify(err.message))} />
          </label>
        </div>
        <p className="muted small">Backups include progress, bookmarks, collections, history and settings — not the comic files.</p>
      </section>

      <section className="panel">
        <h2>Keyboard shortcuts</h2>
        <dl className="shortcuts">
          <div><dt>← →</dt><dd>Turn page (follows reading direction)</dd></div>
          <div><dt>Space / Shift+Space</dt><dd>Next / previous</dd></div>
          <div><dt>Home / End</dt><dd>First / last page</dd></div>
          <div><dt>+ − 0</dt><dd>Zoom in / out / reset (or Ctrl+scroll)</dd></div>
          <div><dt>F</dt><dd>Fullscreen</dd></div>
          <div><dt>M or Enter</dt><dd>Show / hide controls</dd></div>
          <div><dt>B</dt><dd>Bookmark page</dd></div>
          <div><dt>Esc</dt><dd>Close reader</dd></div>
        </dl>
      </section>
      <p className="muted small center pad">{APP.name}</p>
    </div>
  );
}

async function exportBackup() {
  const data = {
    app: APP.name,
    exportedAt: new Date().toISOString(),
    comics: (await db.comics.toArray()).map(({ cover: _c, ...c }) => c),
    progress: await db.progress.toArray(),
    collections: await db.collections.toArray(),
    sessions: await db.sessions.toArray(),
    prefs: localStorage.getItem('prefs.v1'),
    clientId: await getKV('googleClientId', ''),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${APP.shortName.toLowerCase()}-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importBackup(file: File) {
  const data = JSON.parse(await file.text());
  if (!Array.isArray(data.comics)) throw new Error('Not a valid backup file');
  await db.transaction('rw', [db.comics, db.progress, db.collections, db.sessions], async () => {
    for (const c of data.comics) {
      const local = await db.comics.get(c.id);
      if (!local || c.updatedAt > local.updatedAt) await db.comics.put({ ...c, cover: local?.cover, hasFile: local?.hasFile ?? 0 });
    }
    for (const p of data.progress ?? []) {
      const local = await db.progress.get(p.comicId);
      if (!local || p.updatedAt > local.updatedAt) await db.progress.put(p);
    }
    for (const c of data.collections ?? []) {
      const local = await db.collections.get(c.id);
      if (!local || c.updatedAt > local.updatedAt) await db.collections.put(c);
    }
    await db.sessions.bulkPut(data.sessions ?? []);
  });
  if (data.prefs) setPrefs(JSON.parse(data.prefs));
  if (data.clientId) await setKV('googleClientId', data.clientId);
  markDirty();
}
