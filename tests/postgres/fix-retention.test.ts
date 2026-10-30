import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture } from './fix-fixture.js';
import { connection } from './harness.js';
void test('authorized retention honors a live lease then removes the entire expired protocol graph and all capacity reservations', async () => {
  const s = await fixture(),
    admin = await connection('admin'),
    maint = await connection('maintenance');
  try {
    await s.bind();
    await s.fix('CLAIM', { order_id: s.order, owner_id: randomUUID() });
    await admin.query<Record<string, unknown>>(
      "UPDATE fi.sandboxes SET created_at=clock_timestamp()-interval '40 days',write_expires_at=clock_timestamp()-interval '33 days',retained_until=clock_timestamp()-interval '10 days' WHERE id=$1",
      [s.id],
    );
    await maint.query<Record<string, unknown>>('SELECT fi_control.purge_expired()');
    assert.equal(
      (
        await admin.query<Record<string, unknown>>(
          'SELECT count(*)::int n FROM fi.fix_bindings WHERE sandbox_id=$1',
          [s.id],
        )
      ).rows[0]!.n,
      1,
    );
    await admin.query<Record<string, unknown>>(
      "UPDATE fi.fix_lanes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1",
      [s.id],
    );
    await maint.query<Record<string, unknown>>('SELECT fi_control.purge_expired()');
    for (const table of [
      'fi.fix_bindings',
      'fi.fix_lanes',
      'fi.fix_commands',
      'fi.fix_events',
      'fi_control.fix_reservations',
      'fi_control.command_keys',
    ])
      assert.equal(
        (
          await admin.query<Record<string, unknown>>(
            `SELECT count(*)::int n FROM ${table} WHERE sandbox_id=$1`,
            [s.id],
          )
        ).rows[0]!.n,
        0,
      );
  } finally {
    await maint.end();
    await admin.end();
    await s.close();
  }
});
