import pg from 'pg';
import { owner } from './harness.js';

process.once('message', (message: unknown) => {
  void (async () => {
    const data = message as {
      id: string;
      read: string;
      trade: string;
      hash: string;
      key: string;
      actor: string;
      commit: boolean;
    };
    const config = await owner();
    const db = new pg.Client({ connectionString: config.appUrl });
    await db.connect();
    await db.query('BEGIN');
    await db.query('SELECT fi_control.create_sandbox($1,$2,$3,$4,$5,$6)', [
      data.id,
      data.read,
      data.trade,
      data.hash,
      data.key,
      data.actor,
    ]);
    if (data.commit) await db.query('COMMIT');
    process.send?.({ phase: data.commit ? 'committed' : 'uncommitted' });
    // The parent kills this real process while its connection/transaction is held.
  })().catch(() => {
    process.send?.({ phase: 'failed' });
    process.exitCode = 1;
  });
});
