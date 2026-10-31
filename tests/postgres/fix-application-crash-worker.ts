import pg from 'pg';
import { owner } from './harness.js';
process.once('message', (message: unknown) => {
  void (async () => {
    const p = message as {
      mode: 'PREPARE' | 'APPLY';
      args: unknown[];
      commit: boolean;
      before?: boolean;
      during?: boolean;
    };
    const cfg = await owner(),
      db = new pg.Client({ connectionString: cfg.appUrl });
    db.on('error', () => {});
    await db.connect();
    await db.query('BEGIN');
    if (p.before) {
      process.send?.({ phase: 'before' });
      return;
    }
    if (p.during)
      process.send?.({
        phase: 'applying',
        pid: (await db.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid,
      });
    const sql =
      p.mode === 'PREPARE'
        ? 'SELECT fi_control.fix_command($1,$2,$3,$4,$5,$6,$7) r'
        : 'SELECT fi_control.apply_fix($1,$2,$3,$4,$5,$6) r';
    const r = await db.query<{ r: { status: number } }>(sql, p.args);
    if (![200, 201].includes(r.rows[0]!.r.status)) throw new Error('Controlled command failed.');
    if (p.commit) await db.query('COMMIT');
    process.send?.({ phase: p.commit ? 'committed' : 'uncommitted' });
  })().catch(() => {
    process.send?.({ phase: 'failed' });
    process.exitCode = 1;
  });
});
