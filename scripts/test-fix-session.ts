import { spawn } from 'node:child_process';

const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const child = spawn(python, ['scripts/test-fix-session.py'], { stdio: 'inherit' });
child.on('error', () => {
  console.error('FIX_SESSION_PYTHON_UNAVAILABLE');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
