import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createApplicationServer } from '../app/server/index.js';

const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
async function run(args: string[]) {
  const child = spawn(python, args, { stdio: 'inherit', shell: false });
  const deadline = setTimeout(() => child.kill(), 60_000);
  try {
    const [code] = (await once(child, 'exit')) as [number | null];
    if (code !== 0) throw new Error(`Independent Python verification failed (${String(code)}).`);
  } finally {
    clearTimeout(deadline);
  }
}
const server = createApplicationServer();
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Owned loopback listener missing.');
  await run(['verification/python/verify.py', '--base-url', `http://127.0.0.1:${address.port}`]);
} finally {
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}
