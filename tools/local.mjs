// Run the production build on this computer at http://localhost:8787, as a deployment would, but over plain http.
//   npm run local                 build, then start
//   npm run local -- --skip-build start the existing build
// Data is kept in server/.data-local (delete it to start over). Works on macOS, Linux and Windows.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`LotusPond needs Node.js 22.12 or newer; this computer has ${process.version}. Install the current LTS from https://nodejs.org and try again.`);
  process.exit(1);
}
if (!fs.existsSync(path.join(root, 'node_modules'))) {
  console.error('Dependencies are not installed yet. Run "npm install" in this folder first.');
  process.exit(1);
}

if (!args.has('--skip-build')) {
  console.log('Building the app and the server…');
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true });
  if (build.status !== 0) {
    console.error('The build failed; see the messages above.');
    process.exit(build.status ?? 1);
  }
} else if (!fs.existsSync(path.join(root, 'dist', 'index.html')) || !fs.existsSync(path.join(root, 'server', 'dist', 'index.js'))) {
  console.error('There is no build yet. Run "npm run local" without --skip-build.');
  process.exit(1);
}

const port = process.env.PORT ?? '8787';
const env = {
  ...process.env,
  NODE_ENV: 'production',
  PORT: port,
  // Only this computer can reach it unless HOST is set (for example HOST=0.0.0.0 to test from a phone on your network).
  HOST: process.env.HOST ?? '127.0.0.1',
  // Plain http on localhost: the session cookie cannot require HTTPS here. Real deployments keep the default (true).
  COOKIE_SECURE: process.env.COOKIE_SECURE ?? 'false',
  DATA_DIR: process.env.DATA_DIR ?? '.data-local',
  // On a laptop the server may generate its directory secret and file key in DATA_DIR. Servers set them instead.
  LOCAL_SECRETS: process.env.LOCAL_SECRETS ?? 'true',
};

const server = spawn(process.execPath, ['dist/index.js'], { cwd: path.join(root, 'server'), env, stdio: ['inherit', 'pipe', 'inherit'] });
server.stdout.on('data', chunk => {
  process.stdout.write(chunk);
  if (String(chunk).includes('LotusPond Health API on')) {
    console.log(`\n  LotusPond is running. Open http://localhost:${port} in your browser.\n  Data: server/${env.DATA_DIR}   Stop: Ctrl+C\n`);
  }
});
server.on('exit', code => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill(sig));
