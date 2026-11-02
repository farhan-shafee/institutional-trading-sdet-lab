import pg from 'pg';
import { owner } from './harness.js';
process.once('message', (message: unknown) => {
  void (async () => {
    if (typeof message !== 'object' || message === null) throw new Error('Invalid crash request.');
    const p = message as { args?: unknown; commit?: unknown };
    if (
      typeof p.commit !== 'boolean' ||
      !Array.isArray(p.args) ||
      p.args.length !== 7 ||
      !p.args.every((v, i) => (i === 2 ? v === 1 || v === '1' : typeof v === 'string')) ||
      !['BIND', 'PREPARE', 'RECORD'].includes(String(p.args[3]))
    )
      throw new Error('Invalid crash request.');
    const cfg = await owner(),
      db = new pg.Client({ connectionString: cfg.appUrl });
    await db.connect();
    await db.query('BEGIN');
    const r = await db.query<{ r: { status: number } }>(
      'SELECT fi_control.fix_command($1,$2,$3,$4,$5,$6,$7) r',
      p.args,
    );
    if (r.rows[0]?.r.status !== 201) throw new Error('Metadata command failed.');
    if (p.commit) await db.query('COMMIT');
    // Only fixed phases cross IPC; no credentials, raw bytes or driver errors.
    process.send?.({ phase: p.commit ? 'committed' : 'uncommitted' });
  })().catch(() => {
    process.send?.({ phase: 'failed' });
    process.exitCode = 1;
  });
});
