import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { DEFAULT_SITE_URL } from './shared/site.ts'
import { normalizeSiteUrl, site, siteInputs } from './tools/site/vite-plugin.ts'
import { ocrAssets } from './tools/ocr-assets.ts'

// In development the API runs on :8787 (npm run dev starts both); the dev server forwards /api to it, and /oauth
// (an agent's consent page, which sends people to /login and back), so agent connections can be tried on one origin.
const apiTarget = { target: `http://localhost:${process.env.API_PORT ?? 8787}`, changeOrigin: false }
const api = { '/api': apiTarget, '/oauth': apiTarget }

// Two builds:
// - default: the public site (/, /privacy/, /terms/, /trust/, 404) plus the app shell (app.html, served at /app,
//   /login and /signup), for the Node server. Absolute paths, so the 404 page works at any depth.
// - `--mode artifact` (tools/build-artifact.mjs): only the app, with relative paths, for server-less hosts.
// - `--mode mobile` (tools/build-mobile.mjs): only the app, with relative paths, for the iOS and Android projects.
export default defineConfig(({ mode }) => {
  const artifact = mode === 'artifact' || mode === 'mobile'
  const siteUrl = normalizeSiteUrl(process.env.SITE_URL || DEFAULT_SITE_URL)
  return {
    base: artifact ? './' : '/',
    appType: 'mpa',
    // On-device report reading: everywhere but the server-less preview (mode 'artifact').
    plugins: [react(), site({ siteUrl, artifact }), ocrAssets({ enabled: mode !== 'artifact', base: artifact ? './' : '/' })],
    define: { __SITE_URL__: JSON.stringify(siteUrl) },
    build: {
      chunkSizeWarningLimit: 2500,
      assetsInlineLimit: 0,
      rolldownOptions: { input: artifact ? { app: 'app.html' } : siteInputs() },
    },
    server: { proxy: api },
    preview: { proxy: api },
  }
})
