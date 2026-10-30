import pg from 'pg';
import { owner } from './harness.js';

process.once('message', (message: unknown) => {
  void (async () => {
    const data = message as { args: unknown[]; commit: boolean };
    const config = await owner();
    const db = new pg.Client({ connectionString: config.appUrl });
    await db.connect();
    await db.query<Record<string, unknown>>('BEGIN');
    await db.query<Record<string, unknown>>(
      'SELECT fi_control.order_command($1,$2,$3,$4,$5,$6,$7,$8)',
      data.args,
    );
    if (data.commit) await db.query<Record<string, unknown>>('COMMIT');
    process.send?.({ phase: data.commit ? 'committed' : 'uncommitted' });
  })().catch(() => {
    process.send?.({ phase: 'failed' });
    process.exitCode = 1;
  });
});
