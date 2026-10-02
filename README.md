# ComicReader

A comic reader for phone and desktop that you install from the browser as an app (a PWA). It's built for reading digital comics, keeping your library organised, tracking where you are in every book, and syncing that between devices through your own Google Drive.

> **Renaming:** change `APP` in `src/config.ts` and the `<title>` in `index.html`. Everything else (window title, install name, Drive folder, sync file) reads from there.

## Features

**Formats**: CBZ, CBR (RAR4 and RAR5), CB7, CBT, PDF, image-based EPUB (fixed-layout comics and manga), plain ZIP/RAR/7z/TAR, and folders of loose JPG/PNG/WebP/AVIF/GIF images (packaged as a comic on import). The format is detected from the file's contents, so a `.cbr` that's really a ZIP still opens.

**Reading modes**, set per comic (with defaults in Settings):
- **Single page**: tap zones, swipe, keyboard, mouse wheel
- **Two-page spreads**: cover shown alone; wide (already-spread) pages shown alone
- **Vertical scroll**: continuous scrolling for webtoons and long strips, with adjustable gap and width
- **Panel by panel**: detects panels automatically and zooms from one to the next (like Panels' and YACReader's guided view)
- **Left→right or right→left (manga)**. Right-to-left turns on automatically when ComicInfo.xml or the EPUB says the book is manga.
- Page-turn animations: slide, 3D page turn, fade, or instant
- Fit to screen, width, height, or 1:1. Pinch, double-tap, or Ctrl+scroll to zoom. Auto-crop for scanner borders.
- Brightness, night "warmth" filter, background colour, keep-screen-awake
- Bookmarks, a page grid / thumbnail jump, and an "Up next in series" prompt at the end of a book

**Library**: covers grid, "Continue reading" shelf, group by series, search, sort, filters (unread / reading / finished / favorites / not downloaded), and multi-select for bulk mark-read, add-to-collection, and delete. It reads ComicInfo.xml metadata and falls back to parsing filenames (`Saga 012 (2013).cbz`, `Berserk Vol 3.cbz`). You can edit metadata. Import by drag-and-drop (files or whole folders), the file picker, a folder picker, or "Open with…" once the desktop app is installed.

**Collections**: ordered reading lists you can reorder, plus smart collections that fill themselves from rules (text, status, publisher, years, favorites). Turn on **Sync to Google Drive** for a collection and its comic files are uploaded so your other devices can download them.

**Reading history**: every reading session is logged with its device, time spent, and pages. The Reading tab shows totals, your streak, a 14-day chart, and time per device.

**Sync between phone and desktop** (through your Google Drive):
- Progress, bookmarks, collections, reading sessions, metadata edits, and settings sync automatically: when the app opens, when you come back to it, a few seconds after changes, and when you close a comic.
- If you're reading on one device and another device moves further ahead, you get a prompt like "Page 14 on Windows PC — Jump?".
- Comic **files** only go to Drive when you upload them or put them in a Drive-synced collection. They're stored in `ComicReader/Comics` in your Drive. The app uses the `drive.file` scope, so it can only see files it created itself, never the rest of your Drive.

## Running it

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. `npm run build` writes the installable app to `dist/`.

## Google Drive sync setup (one time, about 5 minutes)

Sync runs entirely in the browser with Google sign-in. There's no server, so you need your own free OAuth Client ID:

1. **Sign in with the Google account whose Drive you want to use** (e.g. your personal Gmail), then go to https://console.cloud.google.com/ and create a project (any name). If you're signed into several accounts, check the avatar in the top-right corner. A work (Google Workspace) account's admin can block this kind of app, which is another reason to use a personal account.
2. **APIs & Services → Library**: enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen** (also labelled "Google Auth Platform"): choose **External**, fill in the app name and your email, and add the Gmail address you'll sync with under **Test users**. While the app is in "Testing", only the test users you list can sign in, which is all you need.
4. **Credentials → Create credentials → OAuth client ID → Web application**. Under **Authorized JavaScript origins**, add every address you'll open the app from, for example:
   - `http://localhost:5173` (development)
   - your hosted address, e.g. `https://yourname.github.io`
5. Copy the Client ID (`…apps.googleusercontent.com`) and paste it into **Settings → Google Drive sync** on each device, then tap **Connect**. Google will ask which account to use: pick the same personal account on every device. Settings then shows "Connected as …", and **Switch Google account** lets you change it later. You can also put it in `.env.local` as `VITE_GOOGLE_CLIENT_ID=…` so it's built in.

Google tokens last about an hour. The app renews them quietly when it can; if your browser blocks that, Settings shows a **Reconnect** button.

## Getting it on your phone

The app is hosted on GitHub Pages at **https://jacksonwholesale.github.io/comicreader/**. To publish changes:

```bash
npm run deploy
```

That builds the app and pushes `dist/` to the `gh-pages` branch, which GitHub serves.

A phone needs the app served over **HTTPS**. Any static host works, because `dist/` is just files:

- **Netlify Drop**: run `npm run build` and drag the `dist` folder onto https://app.netlify.com/drop
- **GitHub Pages / Cloudflare Pages / Vercel**: point them at this repo, with build command `npm run build` and output folder `dist`

Then add that HTTPS address to the OAuth client's authorized origins, open it on your phone, and choose **Install app** (Android/Chrome) or **Share → Add to Home Screen** (iPhone). On desktop, use Chrome or Edge's install button in the address bar; the installed app then shows up in "Open with…" for CBZ/CBR/PDF files.

## Notes and limits

- Comics are stored in the browser's own storage on each device. The app asks for persistent storage so they aren't cleared under pressure. On iPhone, install it to the Home Screen: Safari may clear data from sites you haven't opened in a while, but installed apps are kept.
- Folder import (picking a whole folder) works on desktop browsers. On phones, select multiple files instead.
- A comic counts as the same comic on every device when the files are byte-for-byte identical, which is what you get when one device downloads it from Drive.
- Backups: **Settings → Export backup** saves progress, collections, history, and settings as JSON (not the comic files).

## Project layout

```
src/
  config.ts              app name (rename here)
  db.ts                  IndexedDB schema (Dexie)
  lib/archive.ts         format detection + CBZ/CBR/CB7/CBT/PDF/EPUB readers
  lib/importer.ts        import pipeline, content-hash IDs, covers, metadata
  lib/panels.ts          panel detection for the guided view, auto-crop
  lib/drive.ts           Google Drive API (Google Identity Services)
  lib/sync.ts            merge logic, auto-sync, upload/download queue
  lib/library.ts         progress, sessions, collections, stats
  components/reader/     the reader (modes, gestures, settings, page grid)
  views/                 Library, Collections, Reading stats, Settings
```
