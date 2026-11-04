import { createServer, createConnection, type Socket } from 'node:net';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { verifyOwned } from '../../scripts/owned-postgres.js';

// Data only: assertions remain in the recovery/restart tests. Exact row text
// preserves numeric/raw evidence even when JSON numbers are parsed by JavaScript.
export type RecoveryState = Record<string, Record<string, unknown>[]>;
export const recoveryTables = [
  'fi.order_states',
  'fi.order_history',
  'fi.commands',
  'fi.audit_events',
  'fi.executions',
  'fi.positions',
  'fi.cancellation_requests',
  'fi.cancellation_outcomes',
  'fi.fix_prepared',
  'fi.fix_applications',
  'fi.fix_consumptions',
  'fi.fix_commands',
  'fi.fix_events',
  'fi_control.command_keys',
  'fi_control.fix_reservations',
  'fi.fix_work',
  'fi.fix_messages',
  'fi.fix_attempts',
  'fi.fix_sequence_slots',
  'fi.fix_outcomes',
  'fi.fix_protocol_observations',
  'fi.fix_outbox',
  'fi.fix_lanes',
  'fi.fix_bindings',
  'fi.fix_dealer_correlations',
  'fi.fix_cancel_correlations',
  'fi_control.fix_apply_context',
] as const;
export async function recoveryState(db: pg.Client, id: string): Promise<RecoveryState> {
  await db.query<Record<string, unknown>>('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const result: RecoveryState = {};
    for (const table of recoveryTables)
      result[table] = (
        await db.query<{ record: Record<string, unknown> }>(
          "SELECT to_jsonb(t)||jsonb_build_object('_exact_row',to_jsonb(t)::text)" +
            (table === 'fi.fix_prepared'
              ? "||jsonb_build_object('_payload_text',t.payload::text)"
              : '') +
            ' AS record FROM ' +
            table +
            ' t WHERE sandbox_id=$1 ORDER BY to_jsonb(t)::text',
          [id],
        )
      ).rows.map((r) => r.record);
    result['financial_counters'] = (
      await db.query<Record<string, unknown>>(
        'SELECT command_count,event_count,commit_seq::text,generation::text FROM fi.sandboxes WHERE id=$1',
        [id],
      )
    ).rows;
    await db.query<Record<string, unknown>>('COMMIT');
    return result;
  } catch (error) {
    await db.query<Record<string, unknown>>('ROLLBACK');
    throw error;
  }
}
export async function recoveryOracle(db: pg.Client, id: string) {
  const order = (
    await db.query<Record<string, unknown>>(
      'SELECT id,contract FROM fi.orders WHERE sandbox_id=$1',
      [id],
    )
  ).rows[0];
  const executions = (
    await db.query<Record<string, unknown>>(
      'SELECT *,settlement_date::text FROM fi.executions WHERE sandbox_id=$1 ORDER BY fill_sequence',
      [id],
    )
  ).rows;
  const position = (
    await db.query<Record<string, unknown>>('SELECT * FROM fi.positions WHERE sandbox_id=$1', [id])
  ).rows[0];
  const lifecycle = (
    await db.query<Record<string, unknown>>('SELECT * FROM fi.order_states WHERE sandbox_id=$1', [
      id,
    ])
  ).rows[0];
  const messages = (
    await db.query<Record<string, unknown>>(
      "SELECT m.id,m.execution_id,m.source_event_id,encode(a.raw_bytes,'base64') raw_base64 FROM fi.fix_messages m JOIN fi.fix_attempts a ON(a.sandbox_id,a.message_id)=(m.sandbox_id,m.id) WHERE m.sandbox_id=$1 AND a.attempt_no=1 ORDER BY m.received_at",
      [id],
    )
  ).rows.map((m) => ({ ...m, raw_base64: String(m['raw_base64']).replaceAll('\n', '') }));
  return spawnSync(
    process.env.PYTHON ?? 'python3',
    ['verification/python/fix_application_reference.py'],
    {
      input: JSON.stringify({ order, executions, position, lifecycle, messages }),
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 65536,
    },
  );
}
type AckObservation = {
  reason: string;
  connections: number;
  commitQueries: number;
  commandCompleteSuppressed: boolean;
  readyForQuerySuppressed: boolean;
};
// A one-connection, bounded test fault, NOT a general proxy: no target argument,
// only the nonce-verified owned tf_app endpoint, IPv4 loopback, <=1MiB traffic,
// <=64KiB frames and the existing 5s transaction lifetime. No wire/auth logging.
export async function dropOwnedCommitAcknowledgement() {
  const descriptor = process.env.TF_DB_OWNER_FILE;
  if (!descriptor) throw new Error('Owned descriptor required for COMMIT fault.');
  const cfg = await verifyOwned(descriptor),
    target = new URL(cfg.appUrl!),
    adminUrl = new URL(cfg.adminUrl);
  if (
    target.hostname !== '127.0.0.1' ||
    target.username !== 'tf_app' ||
    target.port !== adminUrl.port ||
    target.pathname !== adminUrl.pathname ||
    !target.port ||
    target.port === '0' ||
    target.search ||
    target.hash
  )
    throw new Error('COMMIT fault requires the exact owned application endpoint.');
  const observer = new pg.Client({
    connectionString: cfg.adminUrl,
    connectionTimeoutMillis: 500,
    query_timeout: 2000,
  });
  try {
    await observer.connect();
    const marker = (
      await observer.query<{ marker: string }>(
        "SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()",
      )
    ).rows[0]?.marker;
    if (marker !== 'TradeFlow local owner ' + cfg.nonce)
      throw new Error('COMMIT fault database nonce mismatch.');
  } finally {
    await observer.end();
  }
  const sockets = new Set<Socket>();
  let connections = 0,
    commitQueries = 0,
    bytes = 0,
    commandCompleteSuppressed = false,
    readyForQuerySuppressed = false,
    finished = false,
    front = Buffer.alloc(0),
    back = Buffer.alloc(0);
  let settle!: (value: AckObservation) => void;
  const observation = new Promise<AckObservation>((resolve) => {
    settle = resolve;
  });
  const finish = (reason: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    settle({
      reason,
      connections,
      commitQueries,
      commandCompleteSuppressed,
      readyForQuerySuppressed,
    });
    for (const socket of sockets) socket.destroy();
    front = Buffer.alloc(0);
    back = Buffer.alloc(0);
  };
  const timer = setTimeout(() => finish('BOUNDED_LIFETIME_EXPIRED'), 5000);
  timer.unref();
  const server = createServer((client) => {
    connections++;
    if (connections !== 1 || finished) {
      client.destroy();
      finish('EXTRA_CONNECTION');
      return;
    }
    const upstream = createConnection({ host: '127.0.0.1', port: Number(target.port) });
    sockets.add(client);
    sockets.add(upstream);
    for (const socket of [client, upstream]) {
      socket.on('error', () => finish('CONNECTION_ERROR'));
      socket.on('close', () => {
        sockets.delete(socket);
        if (!finished) finish('CONNECTION_CLOSED');
      });
    }
    let startup = true;
    client.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1048576) {
        finish('TRAFFIC_BOUND');
        return;
      }
      front = Buffer.concat([front, chunk]);
      while (!finished) {
        if (front.length < (startup ? 4 : 5)) return;
        const length = front.readUInt32BE(startup ? 0 : 1),
          total = startup ? length : length + 1;
        if (length < (startup ? 8 : 4) || length > 65536) {
          finish('FRAMING_BOUND');
          return;
        }
        if (front.length < total) return;
        const frame = front.subarray(0, total);
        front = front.subarray(total);
        if (startup) {
          if (frame.readUInt32BE(4) !== 196608) {
            finish('UNSUPPORTED_STARTUP');
            return;
          }
          startup = false;
        } else if (frame[0] === 81 && frame.subarray(5, -1).toString('ascii') === 'COMMIT') {
          commitQueries++;
          if (commitQueries !== 1) {
            finish('EXTRA_COMMIT');
            return;
          }
        }
        upstream.write(frame);
      }
    });
    upstream.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1048576) {
        finish('TRAFFIC_BOUND');
        return;
      }
      back = Buffer.concat([back, chunk]);
      while (!finished) {
        if (back.length < 5) return;
        const length = back.readUInt32BE(1),
          total = length + 1;
        if (length < 4 || length > 65536) {
          finish('FRAMING_BOUND');
          return;
        }
        if (back.length < total) return;
        const frame = back.subarray(0, total);
        back = back.subarray(total);
        if (
          commitQueries === 1 &&
          frame[0] === 67 &&
          frame.subarray(5).toString('ascii') === 'COMMIT\0'
        ) {
          commandCompleteSuppressed = true;
          continue;
        }
        if (commandCompleteSuppressed) {
          if (frame[0] !== 90 || frame.subarray(5).toString('ascii') !== 'I') {
            finish('UNEXPECTED_POST_COMMIT_FRAME');
            return;
          }
          readyForQuerySuppressed = true;
          finish('COMMIT_ACK_WITHHELD');
          return;
        }
        client.write(frame);
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1')
      throw new Error('COMMIT fault must remain IPv4 loopback.');
    const url = new URL(target);
    url.port = String(address.port);
    return {
      // Test callers never print this credential-bearing value.
      appUrl: url.href,
      observation,
      async close() {
        finish('CLOSED');
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  } catch (error) {
    finish('STARTUP_FAILED');
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}

export function oracleEvidence(text: string): {
  frames: number;
  executions: number;
  cash_cents: number;
  per_fill_minus_whole_cents: number;
} {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed independent recovery oracle output.');
  const record = value as Record<string, unknown>;
  for (const field of ['frames', 'executions', 'cash_cents', 'per_fill_minus_whole_cents'])
    if (!Number.isSafeInteger(record[field]))
      throw new Error('Malformed independent recovery oracle counters.');
  return record as {
    frames: number;
    executions: number;
    cash_cents: number;
    per_fill_minus_whole_cents: number;
  };
}
