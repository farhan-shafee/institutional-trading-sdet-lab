import { spawn } from 'node:child_process';

const python = process.env['PYTHON'] ?? (process.platform === 'win32' ? 'python' : 'python3');
const child = spawn(python, ['scripts/test-fix-live-application.py'], { stdio: 'inherit' });
child.on('error', () => {
  console.error('FIX_LIVE_GATE_PYTHON_UNAVAILABLE');
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    child.kill(signal);
  });
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
