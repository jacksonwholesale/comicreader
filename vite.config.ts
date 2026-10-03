import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { APP } from './src/config';

export default defineConfig({
  base: './',
  // shown in Settings so you can tell which version a device is running
  define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC') },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,wasm,mjs}'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
      },
      manifest: {
        name: APP.name,
        short_name: APP.shortName,
        description: APP.tagline,
        theme_color: '#0f1115',
        background_color: '#0f1115',
        display: 'standalone',
        orientation: 'any',
        start_url: './',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
        // Lets the installed desktop app appear in "Open with" for comic files.
        file_handlers: [
          {
            action: './',
            accept: {
              'application/vnd.comicbook+zip': ['.cbz'],
              'application/vnd.comicbook-rar': ['.cbr'],
              'application/zip': ['.zip'],
              'application/pdf': ['.pdf'],
            },
          },
        ],
      } as any,
    }),
  ],
  optimizeDeps: { exclude: ['node-unrar-js'] },
});
