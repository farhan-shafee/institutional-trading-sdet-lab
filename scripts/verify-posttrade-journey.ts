import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Direct native test invocation has the same exact source/dependency boundary. No bypass flag. */
export function admitPostTradeNative(): void {
  const program =
    "import json,sys;from pathlib import Path;r=Path.cwd();sys.path.insert(0,str(r/'tools/fix-session'));from gate import admit_pins;from preservation_v4 import load_preservation,verify_preserved;verify_preserved(r,load_preservation(r)['files']);admit_pins(json.loads((r/'tools/fix-session/dependencies.lock.json').read_text()),(r/'tools/fix-session/Dockerfile').read_text())";
  const result = spawnSync(process.env['PYTHON'] ?? 'python3', ['-c', program], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 65536,
  });
  if (result.status !== 0 || result.error || result.signal) {
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error('POSTTRADE_NATIVE_SOURCE_ADMISSION_FAILED');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const child = spawn(process.env['PYTHON'] ?? 'python3', ['scripts/verify-posttrade-journey.py'], {
    stdio: 'inherit',
  });
  child.once('error', () => {
    console.error('Owned post-trade native gate could not start.');
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
