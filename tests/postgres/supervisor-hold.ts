import pg from 'pg';
import { owner } from './harness.js';

const config = await owner();
const db = new pg.Client({ connectionString: config.appUrl });
await db.connect();
await db.query('BEGIN');
process.send?.({ phase: 'ready' });
process.on('message', () => {
  /* Deliberately retain the owned verification child until cancellation. */
});
await new Promise<void>(() => {
  /* The supervisor must terminate and await this process. */
});
