import pg from 'pg';
import { owner } from './harness.js';
process.once('message', (message: unknown) => {
  void (async () => {
    const p = message as { args: unknown[]; commit: boolean };
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
    process.send?.({ phase: p.commit ? 'committed' : 'uncommitted' });
  })().catch(() => {
    process.send?.({ phase: 'failed' });
    process.exitCode = 1;
  });
});
