// Bundle the API into dist/index.js. Dependencies stay external and load from node_modules.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
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
