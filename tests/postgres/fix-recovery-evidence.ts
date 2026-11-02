import pg from 'pg';
import { verifyOwned } from '../../scripts/owned-postgres.js';

/** Direct persisted evidence, not the application's STATE projection or codec. */
export async function durableFixSnapshot(
  sandboxId: string,
): Promise<Record<string, Record<string, unknown>[]>> {
  const path = process.env.TF_DB_OWNER_FILE;
  if (!path) throw new Error('Recovery evidence requires an owned PostgreSQL descriptor.');
  const owned = await verifyOwned(path);
  const db = new pg.Client({ connectionString: owned.adminUrl });
  await db.connect();
  try {
    const marker = await db.query<{ marker: string }>(
      "SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()",
    );
    if (marker.rows[0]?.marker !== `TradeFlow local owner ${owned.nonce}`)
      throw new Error('Recovery evidence database ownership mismatch.');
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result: Record<string, Record<string, unknown>[]> = {};
    const tables = [
      ['fix_channels', 'fi.fix_channels'],
      ['fix_bindings', 'fi.fix_bindings'],
      ['fix_lanes', 'fi.fix_lanes'],
      ['fix_messages', 'fi.fix_messages'],
      ['fix_sequence_slots', 'fi.fix_sequence_slots'],
      ['fix_attempts', 'fi.fix_attempts'],
      ['fix_outbox', 'fi.fix_outbox'],
      ['fix_dealer_correlations', 'fi.fix_dealer_correlations'],
      ['fix_cancel_correlations', 'fi.fix_cancel_correlations'],
      ['fix_work', 'fi.fix_work'],
      ['fix_prepared', 'fi.fix_prepared'],
      ['fix_outcomes', 'fi.fix_outcomes'],
      ['fix_commands', 'fi.fix_commands'],
      ['fix_events', 'fi.fix_events'],
      ['fix_reservations', 'fi_control.fix_reservations'],
      ['command_keys', 'fi_control.command_keys'],
      ['commands', 'fi.commands'],
      ['audit_events', 'fi.audit_events'],
      ['orders', 'fi.orders'],
      ['order_states', 'fi.order_states'],
      ['executions', 'fi.executions'],
      ['positions', 'fi.positions'],
      ['cancellation_requests', 'fi.cancellation_requests'],
      ['cancellation_outcomes', 'fi.cancellation_outcomes'],
      ['order_history', 'fi.order_history'],
    ] as const;
    for (const [name, table] of tables) {
      const projection =
        name === 'fix_prepared'
          ? "to_jsonb(t)||jsonb_build_object('payload_text',t.payload::text)"
          : 'to_jsonb(t)';
      result[name] = (
        await db.query<{ record: Record<string, unknown> }>(
          `SELECT ${projection} AS record FROM ${table} t WHERE sandbox_id=$1 ORDER BY to_jsonb(t)::text`,
          [sandboxId],
        )
      ).rows.map((row) => row.record);
    }
    result['sandboxes'] = (
      await db.query<{ record: Record<string, unknown> }>(
        "SELECT jsonb_build_object('command_count',command_count,'event_count',event_count,'commit_seq',commit_seq,'generation',generation) AS record FROM fi.sandboxes WHERE id=$1",
        [sandboxId],
      )
    ).rows.map((row) => row.record);
    await db.query('COMMIT');
    return result;
  } finally {
    await db.end();
  }
}
