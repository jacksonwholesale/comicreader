// Copies pdf.js image decoders (JPEG 2000, JBIG2, colour profiles) into public/ so the app can
// render scanned PDFs that use them (common in Internet Archive downloads). Runs before dev/build.
import { copyFileSync, mkdirSync } from 'node:fs';

const src = 'node_modules/pdfjs-dist/wasm';
const dest = 'public/pdfjs/wasm';
mkdirSync(dest, { recursive: true });
for (const f of ['openjpeg.wasm', 'jbig2.wasm', 'qcms_bg.wasm']) copyFileSync(`${src}/${f}`, `${dest}/${f}`);
