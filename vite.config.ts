import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development the API runs on :8787 (npm run dev starts both); the dev server forwards /api to it.
const api = { '/api': { target: `http://localhost:${process.env.API_PORT ?? 8787}`, changeOrigin: false } }

export default defineConfig({
  base: './',
  plugins: [react()],
  build: { chunkSizeWarningLimit: 2500, assetsInlineLimit: 0 },
  server: { proxy: api },
  preview: { proxy: api },
})
