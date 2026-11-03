// Bundle the API into dist/index.js, and the partner-lab import command into dist/facilities/import-cli.js (same
// depth as in src/, since both find the server folder relative to themselves). Dependencies stay external.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts', 'src/facilities/import-cli.ts'],
  outdir: 'dist',
  outbase: 'src',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  // The bundle is the production server: default NODE_ENV accordingly (secure cookies, serve ../dist).
  banner: { js: "process.env.NODE_ENV ??= 'production';" },
  logLevel: 'info',
});
