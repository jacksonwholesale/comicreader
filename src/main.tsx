import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { APP } from './config';
import { go } from './lib/hooks';
import { importFile } from './lib/importer';
import { queueImport } from './lib/importQueue';
import { afterRedirectSignIn, startAutoSync } from './lib/sync';
import { finishRedirectSignIn, prepareGoogle } from './lib/drive';
import './styles.css';

document.title = APP.name;
registerSW({ immediate: true });

// Ask the browser not to evict the library under storage pressure.
void navigator.storage?.persist?.();

// Coming back from Google's sign-in page (backup sign-in for iPhone home-screen apps)?
const redirect = finishRedirectSignIn();
if (redirect.error) sessionStorage.setItem('auth.error', redirect.error);

startAutoSync();
if (redirect.done && !redirect.error) void afterRedirectSignIn();
// Get Google sign-in ready early, so tapping Connect/Reconnect can open its window instantly.
void prepareGoogle().catch(() => {});

// The reader does its own zooming; stop iOS Safari from pinch-zooming the whole app instead.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

// Desktop "Open with…" for the installed app (manifest file_handlers).
if ('launchQueue' in window) {
  (window as any).launchQueue.setConsumer(async (params: { files: FileSystemFileHandle[] }) => {
    if (!params.files?.length) return;
    const files = await Promise.all(params.files.map((h) => h.getFile()));
    if (files.length === 1) {
      try {
        const { id } = await importFile(files[0], files[0].name);
        go(`read/${id}`);
        return;
      } catch {
        /* fall through to the queue, which reports the error */
      }
    }
    queueImport(files.map((f) => ({ file: f, name: f.name, path: f.name })));
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
