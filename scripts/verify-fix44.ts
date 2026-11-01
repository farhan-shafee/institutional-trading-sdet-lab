import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { encodeFix44 } from '../app/protocol/fix44/index.js';
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
async function run(args: string[], input?: string): Promise<void> {
  const child = spawn(python, args, { stdio: ['pipe', 'inherit', 'inherit'], shell: false });
  const deadline = setTimeout(() => child.kill(), 60_000);
  child.stdin.end(input);
  try {
    const [code] = (await once(child, 'exit')) as [number | null];
    if (code !== 0) throw new Error(`FIX44 independent verification failed (${String(code)}).`);
  } finally {
    clearTimeout(deadline);
  }
}
await run([
  '-m',
  'unittest',
  'discover',
  '-s',
  'verification/python',
  '-p',
  'test_fix44_reference.py',
  '-v',
]);
const fixtures = JSON.parse(await readFile('test-data/fix44/manifest.json', 'utf8')) as {
  name: string;
  fields: Record<string, string>;
}[];
await run(
  ['verification/python/fix44_reference.py'],
  JSON.stringify(
    Object.fromEntries(fixtures.map((f) => [f.name, encodeFix44(f.fields).toString('base64')])),
  ),
);
