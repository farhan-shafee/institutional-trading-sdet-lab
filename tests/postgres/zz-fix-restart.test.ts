import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { fixture, report } from './fix-fixture.js';
import { durableFixSnapshot } from './fix-recovery-evidence.js';
import { connection, owner } from './harness.js';
import { restartOwnedPostgres } from '../../scripts/owned-postgres.js';
import { WorkflowDatabase } from '../../app/persistence/postgres/workflow.js';
import { FixFoundationService } from '../../app/server/fix/foundation.js';
import type { FoundationOperation } from '../../app/server/fix/foundation.js';
import { encodeFix44 } from '../../app/protocol/fix44/index.js';
import { DomainError } from '../../app/domain/errors.js';

void test('real PostgreSQL stop/restart preserves exact physical evidence and prepared identities; original-key recovery never applies or delivers', async () => {
  const s = await fixture(),
    cfg = await owner(),
    db = new WorkflowDatabase(cfg.appUrl!),
    service = new FixFoundationService(db, true),
    databases = [db];
  s.app.on('error', () => {});
  const binding = { sandboxId: s.id, digest: s.proof, scope: 'trade' as const, generation: '1' },
    bindInput = { order_id: s.order, dealer_id: 'ATLAS', channel_id: s.channel },
    bindKey = randomUUID(),
    financialTables = [
      'sandboxes',
      'commands',
      'audit_events',
      'orders',
      'order_states',
      'executions',
      'positions',
      'cancellation_requests',
      'cancellation_outcomes',
      'order_history',
    ],
    originals: {
      action: FoundationOperation;
      input: Record<string, unknown>;
      key: string;
      status: number;
      body: unknown;
    }[] = [];
  try {
    const financialBefore = await durableFixSnapshot(s.id),
      bound = await service.command(binding, s.actor, 'BIND', bindInput, bindKey, () => {});
    assert.equal(financialBefore['orders']!.length, 1);
    assert.equal(financialBefore['order_states']![0]!['status'], 'PENDING_ACK');
    assert.equal(financialBefore['order_states']![0]!['version'], 1);
    for (const table of [
      'executions',
      'positions',
      'cancellation_requests',
      'cancellation_outcomes',
    ])
      assert.equal(financialBefore[table]!.length, 0);
    assert.equal(bound.status, 201);
    assert.equal(bound.replayed, false);
    originals.push({ action: 'BIND', input: bindInput, key: bindKey, ...bound });

    const fields = await report(s),
      physicalFields = [
        fields,
        { ...fields, '43': 'Y', '122': fields['52'], '52': '20261030-12:01:00.000' },
        { ...fields, '43': 'Y', '122': fields['52'], '52': '20261030-12:02:00.000' },
      ],
      physical = physicalFields.map((f) => ({
        raw: encodeFix44(f),
        id: randomUUID(),
        key: randomUUID(),
      }));
    assert.equal(new Set(physical.map((attempt) => attempt.raw.toString('hex'))).size, 3);
    let message = '';
    for (const [index, attempt] of physical.entries()) {
      const input = {
          order_id: s.order,
          raw_hex: attempt.raw.toString('hex'),
          attempt_id: attempt.id,
        },
        result = await service.command(binding, s.actor, 'RECORD', input, attempt.key, () => {}),
        body = result.body as Record<string, unknown>;
      assert.equal(result.status, 201);
      assert.equal(result.replayed, false);
      assert.equal(body['attempt_id'], attempt.id);
      assert.equal(body['raw_hash'], createHash('sha256').update(attempt.raw).digest('hex'));
      assert.equal(body['logical_duplicate'], index > 0);
      assert.equal(body['physical_duplicate'], false);
      assert.equal(body['financial_applied'], false);
      assert.equal(body['delivery_state'], 'NOT_IMPLEMENTED');
      if (index === 0) {
        assert.equal(typeof body['message_id'], 'string');
        message = body['message_id'] as string;
      }
      assert.equal(body['message_id'], message);
      originals.push({ action: 'RECORD', input, key: attempt.key, ...result });
    }

    const outboundFields = Object.fromEntries(
      (
        [
          '35',
          '49',
          '56',
          '34',
          '52',
          '11',
          '55',
          '167',
          '54',
          '854',
          '38',
          '40',
          '59',
          '423',
          '44',
          '15',
          '64',
          '60',
        ] as const
      ).map((tag) => [tag, fields[tag]]),
    );
    Object.assign(outboundFields, { '35': 'D', '49': 'TRADEFLOW', '56': 'ATLAS' });
    const outboundRaw = encodeFix44(outboundFields),
      outboundAttempt = randomUUID(),
      outbound = await service.command(
        binding,
        s.actor,
        'RECORD',
        { order_id: s.order, attempt_id: outboundAttempt, raw_hex: outboundRaw.toString('hex') },
        randomUUID(),
        () => {},
      ),
      fillRaw = encodeFix44({
        ...fields,
        '34': '2',
        '17': 'ATLAS-' + randomUUID().toUpperCase(),
        '150': 'F',
        '39': '1',
        '14': '40.00',
        '151': '60.00',
        '32': '40.00',
        '31': fields['44'],
        '6': fields['44'],
      }),
      fillAttempt = randomUUID(),
      fill = await service.command(
        binding,
        s.actor,
        'RECORD',
        { order_id: s.order, attempt_id: fillAttempt, raw_hex: fillRaw.toString('hex') },
        randomUUID(),
        () => {},
      );
    assert.equal(outbound.status, 201);
    assert.equal(fill.status, 201);
    const outboundMessage = (outbound.body as Record<string, unknown>)['message_id'],
      fillMessage = (fill.body as Record<string, unknown>)['message_id'],
      work = randomUUID(),
      laterWork = randomUUID(),
      laneOwner = randomUUID();
    assert.equal(
      (
        await service.command(
          binding,
          s.actor,
          'QUEUE',
          { order_id: s.order, message_id: message, work_id: work },
          randomUUID(),
          () => {},
        )
      ).status,
      201,
    );
    assert.equal(
      (
        await service.command(
          binding,
          s.actor,
          'QUEUE',
          { order_id: s.order, message_id: fillMessage, work_id: laterWork },
          randomUUID(),
          () => {},
        )
      ).status,
      201,
    );
    const claim = await service.command(
        binding,
        s.actor,
        'CLAIM',
        { order_id: s.order, owner_id: laneOwner },
        randomUUID(),
        () => {},
      ),
      financialKey = randomUUID(),
      prepareInput = {
        order_id: s.order,
        owner_id: laneOwner,
        fence: '1',
        work_id: work,
        financial_key: financialKey,
      },
      prepareKey = randomUUID();
    assert.equal(claim.status, 200);
    assert.equal((claim.body as Record<string, unknown>)['fence'], '1');
    const prepared = await service.command(
      binding,
      s.actor,
      'PREPARE',
      prepareInput,
      prepareKey,
      () => {},
    );
    assert.equal(prepared.status, 201);
    assert.equal(prepared.replayed, false);
    assert.equal((prepared.body as Record<string, unknown>)['financial_key'], financialKey);
    assert.ok(
      isDeepStrictEqual((prepared.body as Record<string, unknown>)['payload'], {
        order_id: s.order,
        expected_version: '1',
      }),
      'prepared ACK uses the original order/version',
    );
    assert.equal(
      (prepared.body as Record<string, unknown>)['application_state'],
      'NOT_IMPLEMENTED',
    );
    assert.equal((prepared.body as Record<string, unknown>)['financial_applied'], false);
    originals.push({ action: 'PREPARE', input: prepareInput, key: prepareKey, ...prepared });

    const before = await durableFixSnapshot(s.id),
      state = await service.read(binding, 'STATE', s.order, () => {}),
      attempts = before['fix_attempts']!.filter((a) => a['message_id'] === message).sort(
        (a, b) => Number(a['attempt_no']) - Number(b['attempt_no']),
      );
    assert.equal(state.status, 200);
    assert.equal((state.body as Record<string, unknown>)['financial_applied'], false);
    assert.equal((state.body as Record<string, unknown>)['delivery_verified'], false);
    assert.equal(before['fix_messages']!.length, 3);
    assert.equal(before['fix_attempts']!.length, 5);
    assert.equal(attempts.length, 3);
    for (const [index, attempt] of attempts.entries()) {
      const expected = physical[index]!,
        raw = Buffer.from(String(attempt['raw_bytes']).slice(2), 'hex');
      assert.equal(attempt['id'], expected.id);
      assert.equal(attempt['attempt_no'], index + 1);
      assert.equal(attempt['state'], 'RECEIVED');
      assert.ok(raw.equals(expected.raw), 'the exact physical frame is durably retained');
      assert.equal(attempt['raw_hash'], createHash('sha256').update(raw).digest('hex'));
      assert.equal(typeof attempt['recorded_at'], 'string');
    }
    for (const [id, raw, expectedState] of [
      [outboundAttempt, outboundRaw, 'STAGED'],
      [fillAttempt, fillRaw, 'RECEIVED'],
    ] as const) {
      const attempt = before['fix_attempts']!.find((a) => a['id'] === id)!;
      assert.ok(attempt);
      assert.equal(attempt['attempt_no'], 1);
      assert.equal(attempt['state'], expectedState);
      assert.equal(attempt['raw_bytes'], '\\x' + raw.toString('hex'));
      assert.equal(attempt['raw_hash'], createHash('sha256').update(raw).digest('hex'));
    }
    const ack = before['fix_messages']!.find((m) => m['id'] === message)!,
      candidate = before['fix_messages']!.find((m) => m['id'] === fillMessage)!,
      intent = before['fix_prepared']![0]!;
    assert.equal(ack['order_id'], s.order);
    assert.equal(ack['dealer_id'], 'ATLAS');
    assert.equal(ack['identity_kind'], 'EXEC_REPORT');
    for (const original of originals.filter((r) => r.action === 'RECORD'))
      assert.equal(
        (original.body as Record<string, unknown>)['semantic_hash'],
        ack['semantic_hash'],
      );
    assert.equal(ack['identity_value'], fields['17']);
    assert.equal((ack['fields'] as Record<string, unknown>)['11'], s.order);
    assert.equal(ack['execution_id'], null);
    assert.equal(ack['source_event_id'], null);
    assert.match(String(candidate['execution_id']), /^[a-f0-9-]{36}$/);
    assert.match(String(candidate['source_event_id']), /^[a-f0-9-]{36}$/);
    assert.notEqual(candidate['execution_id'], candidate['source_event_id']);
    assert.ok(
      isDeepStrictEqual(before['fix_dealer_correlations'], [
        {
          sandbox_id: s.id,
          order_id: s.order,
          dealer_id: 'ATLAS',
          dealer_order_id: fields['37'],
          first_message_id: message,
        },
      ]),
      'the first inbound report owns the immutable dealer correlation',
    );
    assert.equal(before['fix_bindings']![0]!['cl_ord_id'], s.order);
    assert.equal(before['fix_bindings']![0]!['channel_id'], s.channel);
    assert.equal(before['fix_work']!.length, 2);
    assert.equal(before['fix_work']!.find((w) => w['id'] === work)!['lane_seq'], 1);
    assert.equal(before['fix_work']!.find((w) => w['id'] === laterWork)!['lane_seq'], 2);
    assert.equal(before['fix_prepared']!.length, 1);
    assert.equal(intent['work_id'], work);
    assert.equal(intent['order_id'], s.order);
    assert.equal(intent['operation'], 'ACK_ORDER');
    assert.ok(
      isDeepStrictEqual(intent['payload'], { order_id: s.order, expected_version: '1' }),
      'the durable preparation freezes the original order/version',
    );
    assert.equal(intent['financial_key'], financialKey);
    assert.equal(intent['prepared_fence'], 1);
    assert.equal(intent['prepared_generation'], 1);
    assert.equal(
      intent['request_hash'],
      createHash('sha256').update(String(intent['payload_text'])).digest('hex'),
    );
    assert.equal(
      before['command_keys']!.find((k) => k['idempotency_key'] === financialKey)!['domain'],
      'FIX_PREPARED',
    );
    assert.equal(before['fix_outcomes']!.length, 0);
    assert.ok(
      isDeepStrictEqual(before['fix_outbox'], [
        {
          sandbox_id: s.id,
          message_id: outboundMessage,
          order_id: s.order,
          delivery_state: 'NOT_IMPLEMENTED',
        },
      ]),
      'outbound bytes have only an unimplemented delivery intent',
    );
    assert.ok(
      isDeepStrictEqual(before['fix_reservations'], [
        {
          sandbox_id: s.id,
          order_id: s.order,
          commands: 25,
          events: 43,
          released_at: null,
        },
      ]),
      'the entire financial reservation remains unconsumed',
    );
    for (const table of financialTables)
      assert.ok(
        isDeepStrictEqual(before[table], financialBefore[table]),
        `${table} has no FIX financial effect`,
      );
    assert.equal(before['fix_events']!.length, before['fix_commands']!.length);
    for (const event of before['fix_events']!) {
      const command = before['fix_commands']!.find(
        (r) => r['command_seq'] === event['command_seq'],
      )!;
      assert.ok(command);
      assert.equal(event['event_type'], command['operation']);
      assert.equal(event['event_index'], 0);
      assert.equal(event['order_id'], s.order);
      assert.equal((event['payload'] as Record<string, unknown>)['financial_applied'], false);
    }
    for (const original of originals) {
      const receipt = before['fix_commands']!.find((r) => r['idempotency_key'] === original.key)!;
      assert.equal(receipt['operation'], original.action);
      assert.equal(receipt['http_status'], original.status);
      assert.ok(
        isDeepStrictEqual(receipt['response_body'], original.body),
        'durable receipt retains the original body',
      );
    }

    await restartOwnedPostgres(process.env.TF_DB_OWNER_FILE!, async () => {
      await assert.rejects(
        service.read(binding, 'STATE', s.order, () => {}),
        (e: unknown) => e instanceof DomainError && e.status === 503,
      );
      for (const original of originals)
        await assert.rejects(
          service.command(
            binding,
            s.actor,
            original.action,
            original.input,
            original.key,
            () => {},
          ),
          (e: unknown) => e instanceof DomainError && e.status === 503,
        );
    });
    await db.close();
    assert.ok(
      isDeepStrictEqual(await durableFixSnapshot(s.id), before),
      'real restart preserves every durable row exactly',
    );
    const fresh = [new WorkflowDatabase(cfg.appUrl!), new WorkflowDatabase(cfg.appUrl!)];
    databases.push(...fresh);
    const services = fresh.map((database) => new FixFoundationService(database, true)),
      recovered = services[0]!;
    const restoredState = await recovered.read(binding, 'STATE', s.order, () => {});
    assert.equal(restoredState.status, 200);
    assert.ok(
      isDeepStrictEqual(restoredState.body, state.body),
      'fresh pool sees the original owned state',
    );
    for (const original of originals) {
      const results = await Promise.all(
        services.map((caller) =>
          caller.command(binding, s.actor, original.action, original.input, original.key, () => {}),
        ),
      );
      for (const result of results) {
        assert.equal(result.status, original.status);
        assert.equal(result.replayed, true);
        assert.ok(
          isDeepStrictEqual(result.body, original.body),
          'competing fresh pools recover the original receipt',
        );
      }
      const receipt = await recovered.read(binding, 'RECEIPT', original.key, () => {}),
        body = receipt.body as Record<string, unknown>;
      assert.equal(receipt.status, 200);
      assert.equal(body['operation'], original.action);
      assert.equal(body['status'], original.status);
      assert.ok(
        isDeepStrictEqual(body['body'], original.body),
        'authorized receipt read agrees with original replay',
      );
    }
    assert.ok(
      isDeepStrictEqual(await durableFixSnapshot(s.id), before),
      'concurrent original-key recovery writes no new evidence',
    );

    const admin = await connection('admin');
    try {
      await admin.query(
        "UPDATE fi.fix_lanes SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE sandbox_id=$1",
        [s.id],
      );
    } finally {
      await admin.end();
    }
    const newOwner = randomUUID(),
      reclaimed = await recovered.command(
        binding,
        s.actor,
        'CLAIM',
        { order_id: s.order, owner_id: newOwner },
        randomUUID(),
        () => {},
      );
    assert.equal(reclaimed.status, 200);
    assert.equal((reclaimed.body as Record<string, unknown>)['fence'], '2');
    const afterClaim = await durableFixSnapshot(s.id),
      replay = await recovered.command(
        binding,
        s.actor,
        'PREPARE',
        prepareInput,
        prepareKey,
        () => {},
      );
    assert.equal(replay.status, 201);
    assert.equal(replay.replayed, true);
    assert.ok(
      isDeepStrictEqual(replay.body, prepared.body),
      'stale owner retains original-key recovery without rebasing',
    );
    const stale = await recovered.command(
      binding,
      s.actor,
      'PREPARE',
      prepareInput,
      randomUUID(),
      () => {},
    );
    assert.equal(stale.status, 409);
    assert.equal((stale.body as { error: { code: string } }).error.code, 'FIX_STALE_FENCE');
    for (const [input, code] of [
      [{ ...prepareInput, owner_id: newOwner, fence: '2' }, 'FIX_ALREADY_PREPARED_RETAIN_ORIGINAL'],
      [
        { ...prepareInput, owner_id: newOwner, fence: '2', work_id: laterWork },
        'FIX_UNRESOLVED_HEAD',
      ],
    ] as const) {
      const result = await recovered.command(
        binding,
        s.actor,
        'PREPARE',
        input,
        randomUUID(),
        () => {},
      );
      assert.equal(result.status, 409);
      assert.equal((result.body as { error: { code: string } }).error.code, code);
    }
    const application = await recovered.command(
      binding,
      s.actor,
      'RESOLVE_METADATA',
      { order_id: s.order, owner_id: newOwner, fence: '2', work_id: work },
      randomUUID(),
      () => {},
    );
    assert.equal(application.status, 409);
    assert.equal(
      (application.body as { error: { code: string } }).error.code,
      'FIX_FINANCIAL_APPLICATION_DISABLED',
    );
    for (const invalid of [
      { ...binding, digest: createHash('sha256').update('wrong-proof').digest('hex') },
      { ...binding, generation: '2' },
    ]) {
      const denied = await recovered.command(
          invalid,
          s.actor,
          'PREPARE',
          prepareInput,
          prepareKey,
          () => {},
        ),
        read = await recovered.read(invalid, 'RECEIPT', prepareKey, () => {});
      for (const result of [denied, read]) {
        assert.equal(result.status, 404);
        assert.equal((result.body as { error: { code: string } }).error.code, 'SANDBOX_NOT_FOUND');
      }
    }
    await assert.rejects(
      recovered.command(
        { ...binding, scope: 'read' },
        s.actor,
        'PREPARE',
        prepareInput,
        prepareKey,
        () => {},
      ),
      (e: unknown) => e instanceof DomainError && e.status === 403 && e.code === 'FORBIDDEN',
    );
    await assert.rejects(
      recovered.command(binding, s.actor, 'PREPARE', prepareInput, prepareKey, () => {
        throw new DomainError(401, 'UNAUTHORIZED', 'Session expired.');
      }),
      (e: unknown) => e instanceof DomainError && e.status === 401 && e.code === 'UNAUTHORIZED',
    );
    const final = await durableFixSnapshot(s.id);
    assert.ok(
      isDeepStrictEqual(final, afterClaim),
      'stale, unauthorized and disabled application attempts mutate no durable evidence',
    );
    assert.ok(
      isDeepStrictEqual(final['fix_prepared'], before['fix_prepared']),
      'reclaim preserves prepared key/payload/hash/fence/generation',
    );
    assert.ok(
      isDeepStrictEqual(final['fix_attempts'], before['fix_attempts']),
      'recovery never invents a physical attempt',
    );
    assert.ok(
      isDeepStrictEqual(final['fix_reservations'], before['fix_reservations']),
      'recovery consumes no reserved capacity',
    );
    assert.equal(final['fix_outcomes']!.length, 0);
    for (const table of financialTables)
      assert.ok(
        isDeepStrictEqual(final[table], financialBefore[table]),
        `${table} remains financially unchanged after recovery`,
      );
  } finally {
    await Promise.all(databases.map((database) => database.close()));
    await s.close();
  }
});
