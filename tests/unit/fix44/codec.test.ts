import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  decodeFix44,
  encodeFix44,
  renderFix44,
  Fix44Error,
  Fix44Stream,
} from '../../../app/protocol/fix44/index.js';
interface Fixture {
  name: string;
  file: string;
  fields: Record<string, string>;
  body_length: number;
  checksum: string;
  sha256: string;
}
const fixtures = JSON.parse(readFileSync('test-data/fix44/manifest.json', 'utf8')) as Fixture[];
const raw = (f: Fixture) => readFileSync(`test-data/fix44/${f.file}`);
const first = fixtures[0]!;
const fields = (changes: Record<string, string | undefined> = {}) =>
  Object.fromEntries(
    Object.entries({ ...first.fields, ...changes }).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
// Test-only independent byte construction; never asks the production encoder to repair malformed inputs.
function entries(f: Record<string, string>): [string, string][] {
  const h = ['35', '49', '56', '34', '43', '52', '122'];
  return [
    ...h.filter((k) => f[k] !== undefined).map((k) => [k, f[k]!] as [string, string]),
    ...Object.entries(f).filter(([k]) => !h.includes(k)),
  ];
}
function wire(pairs: [string, string][], version = 'FIX.4.4'): Buffer {
  const body = Buffer.from(pairs.map(([k, v]) => `${k}=${v}\x01`).join(''), 'ascii');
  const prefix = Buffer.concat([Buffer.from(`8=${version}\x019=${body.length}\x01`), body]);
  return Buffer.concat([
    prefix,
    Buffer.from(
      `10=${[...prefix].reduce((a, b) => a + b, 0) % 256}`.replace(
        /=(\d+)$/,
        (_, n: string) => '=' + n.padStart(3, '0'),
      ) + '\x01',
    ),
  ]);
}
function code(fn: () => unknown, expected: string) {
  assert.throws(
    fn,
    (e: unknown) =>
      e instanceof Fix44Error &&
      e.code === expected &&
      !e.message.includes('SYN-UST') &&
      !e.message.includes('11111111'),
  );
}
for (const f of fixtures)
  void test(`golden ${f.name}: bytes, exact fields and deterministic encoding`, () => {
    const bytes = raw(f);
    const message = decodeFix44(bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), f.sha256);
    assert.equal(message.fields['9'], String(f.body_length));
    assert.equal(message.fields['10'], f.checksum);
    for (const [tag, value] of Object.entries(f.fields)) assert.equal(message.fields[tag], value);
    assert.equal(
      message.direction,
      ['D', 'F'].includes(f.fields['35']!) ? 'CLIENT_TO_DEALER' : 'DEALER_TO_CLIENT',
    );
    // Encoder uses canonical order, while decoder accepts a base-valid body order.
    const encoded = encodeFix44(f.fields);
    assert.deepEqual(encoded, bytes);
    assert.deepEqual(encodeFix44(f.fields), encoded);
    assert.deepEqual(decodeFix44(encoded).fields, message.fields);
    assert.deepEqual(decodeFix44(wire(entries(f.fields))).fields, message.fields);
    assert.equal(renderFix44(message), bytes.toString('ascii').replaceAll('\x01', '|'));
    assert.ok(!encoded.includes(124));
  });
void test('fragment at every byte boundary without emitting incomplete messages', () => {
  for (const f of [fixtures[0]!, fixtures[4]!])
    for (let i = 0; i <= raw(f).length; i++) {
      const parser = new Fix44Stream();
      const a = parser.push(raw(f).subarray(0, i));
      const b = parser.push(raw(f).subarray(i));
      assert.equal(a.messages.length + b.messages.length, 1);
      assert.equal(parser.bufferedBytes, 0);
      parser.finish();
    }
});
void test('byte-at-a-time, coalescing, incomplete status and finish', () => {
  const parser = new Fix44Stream();
  let count = 0;
  for (const byte of raw(first)) count += parser.push(Buffer.from([byte])).messages.length;
  assert.equal(count, 1);
  parser.finish();
  const many = new Fix44Stream();
  assert.equal(many.push(Buffer.concat(fixtures.map(raw))).messages.length, fixtures.length);
  const incomplete = new Fix44Stream();
  assert.equal(incomplete.push(raw(first).subarray(0, -1)).status, 'incomplete');
  code(() => incomplete.finish(), 'TRUNCATED');
  code(() => decodeFix44(raw(first).subarray(0, -1)), 'TRUNCATED');
});
void test('bounded batches, explicit backpressure and buffer exhaustion', () => {
  const parser = new Fix44Stream({ maxBatch: 2 });
  const result = parser.push(Buffer.concat([raw(first), raw(first), raw(first)]));
  assert.equal(result.messages.length, 2);
  assert.equal(result.status, 'backpressure');
  code(() => parser.push(raw(first)), 'BACKPRESSURE');
  assert.equal(parser.push(Buffer.alloc(0)).messages.length, 1);
  parser.finish();
  code(() => new Fix44Stream().push(Buffer.alloc(16385)), 'BUFFER_LIMIT');
  code(() => new Fix44Stream({ maxBatch: 0 }), 'INVALID_LIMIT');
});
void test('framing rejects corruption, delimiter repair, version, trailing bytes and header order', () => {
  const pairs = entries(first.fields);
  code(
    () => decodeFix44(Buffer.from(raw(first).toString('ascii').replace('99.123', '98.123'))),
    'CHECKSUM',
  );
  code(
    () =>
      decodeFix44(
        Buffer.from(
          raw(first)
            .toString('ascii')
            .replace('9=' + first.body_length + '\x01', '9=1\x01'),
        ),
      ),
    'BODY_LENGTH',
  );
  code(
    () =>
      decodeFix44(
        Buffer.from(
          raw(first)
            .toString('ascii')
            .replace(/10=\d{3}/, '10=12'),
        ),
      ),
    'CHECKSUM',
  );
  code(
    () => decodeFix44(Buffer.from(raw(first).toString('ascii').replaceAll('\x01', '|'))),
    'FRAMING',
  );
  code(() => decodeFix44(wire(pairs, 'FIX.4.2')), 'VERSION');
  code(() => decodeFix44(Buffer.concat([raw(first), raw(first)])), 'TRAILING_BYTES');
  code(() => decodeFix44(wire([pairs[1]!, pairs[0]!, ...pairs.slice(2)])), 'FIELD_ORDER');
  const bad = Buffer.from(raw(first));
  bad[50] = 0xff;
  code(() => decodeFix44(bad), 'NON_ASCII');
});
void test('missing, duplicate, unknown, groups, encoded data and unsupported type', () => {
  code(() => encodeFix44(fields({ '11': undefined })), 'MISSING_FIELD');
  code(
    () => decodeFix44(wire([...entries(first.fields), ['11', first.fields['11']!]])),
    'DUPLICATE_FIELD',
  );
  for (const tag of ['9999', '453', '354'])
    code(() => decodeFix44(wire([...entries(first.fields), [tag, '1']])), 'UNSUPPORTED_FIELD');
  code(() => decodeFix44(wire(entries(fields({ '35': 'A' })))), 'UNSUPPORTED_MESSAGE');
  code(() => encodeFix44(fields({ '37': 'FAKE-DEALER-ORDER' })), 'UNSUPPORTED_FIELD');
  code(() => encodeFix44(fields({ '8': 'FIX.4.4' })), 'RESERVED_FIELD');
  code(
    () =>
      decodeFix44(
        wire([
          ...entries(first.fields),
          ...Array.from({ length: 50 }, (_, i) => [String(8000 + i), 'x'] as [string, string]),
        ]),
      ),
    'FIELD_LIMIT',
  );
  code(() => encodeFix44(fields({ '11': 'x'.repeat(257) })), 'FIELD_LENGTH');
  code(() => decodeFix44(Buffer.from('8=FIX.4.4\x019=8192\x0135=D\x01')), 'FRAME_LIMIT');
});
void test('exact financial text, dates, retransmission and directional validation', () => {
  for (const change of [
    { '44': '99.1' },
    { '38': '100000' },
    { '38': '01.00' },
    { '44': '1e2' },
    { '38': '0.00' },
    { '38': '1000000000.01' },
    { '64': '20260229' },
    { '52': '20260229-12:00:00.000' },
    { '52': '20261030-24:00:00.000' },
    { '54': '3' },
    { '167': 'CORP' },
    { '49': 'ATLAS', '56': 'TRADEFLOW' },
    { '43': 'Y' },
    { '122': '20261030-14:00:00.000' },
  ])
    code(() => encodeFix44(fields(change)), 'INVALID_VALUE');
  assert.equal(
    decodeFix44(encodeFix44(fields({ '64': '20280229', '52': '20280229-23:59:59.999' }))).fields[
      '64'
    ],
    '20280229',
  );
  code(() => encodeFix44(fields({ '43': 'Y', '122': '20261030-15:00:00.000' })), 'INVALID_VALUE');
});
void test('FIX4.4 trade semantics, quantities and cancellation identifiers', () => {
  const partial = fixtures.find((f) => f.name === 'partial')!.fields;
  for (const change of [
    { '150': '1' },
    { '150': '2' },
    { '31': undefined },
    { '32': undefined },
    { '6': undefined },
    { '14': '100001.00' },
    { '151': '1.00' },
    { '32': '50000.00' },
    { '31': '99.123456789013' },
    { '39': '2' },
    { '41': first.fields['11'] },
  ])
    code(
      () =>
        encodeFix44(
          Object.fromEntries(
            Object.entries({ ...partial, ...change }).filter(([, v]) => v !== undefined),
          ) as Record<string, string>,
        ),
      change['150']
        ? 'UNSUPPORTED_VALUE'
        : (change['6'] === undefined && Object.hasOwn(change, '6')) ||
            (Object.hasOwn(change, '31') && change['31'] === undefined) ||
            (Object.hasOwn(change, '32') && change['32'] === undefined)
          ? 'MISSING_FIELD'
          : 'INVALID_VALUE',
    );
  const reject = fixtures.find((f) => f.name === 'cancel-reject')!.fields;
  code(() => encodeFix44({ ...reject, '17': 'INVENTED' }), 'UNSUPPORTED_FIELD');
  code(() => encodeFix44({ ...reject, '11': reject['41']! }), 'INVALID_VALUE');
});
void test('stream errors poison parser; no resynchronization or partial trust', () => {
  const parser = new Fix44Stream();
  code(() => parser.push(Buffer.concat([Buffer.from('garbage'), raw(first)])), 'FRAMING');
  code(() => parser.push(raw(first)), 'PARSER_FAILED');
  const a = new Fix44Stream();
  a.push(Buffer.from('8=FIX.'));
  code(() => a.finish(), 'TRUNCATED');
});
void test('unsupported classifications still require a well-formed common header', () => {
  code(() => decodeFix44(wire([['35', 'A']])), 'MISSING_FIELD');
  code(
    () => decodeFix44(wire(entries(fields({ '35': 'A', '52': 'not-a-time' })))),
    'INVALID_VALUE',
  );
});
void test('rendering requires an actually decoded message and immutable field ownership', () => {
  const decoded = decodeFix44(raw(first));
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.fields));
  code(() => renderFix44({ ...decoded }), 'UNTRUSTED_MESSAGE');
});
void test('calendar, numeric syntax, header placement, field lengths and source-event combinations', () => {
  for (const change of [
    { '52': '20260431-12:00:00' },
    { '52': '19000229-00:00:00' },
    { '52': '20261030-12:00:60' },
    { '52': '20261030-12:00:00.1' },
    { '34': '0' },
    { '34': '2147483648' },
    { '34': '01' },
    { '44': '-1.000000000000' },
    { '44': '0.000000000000' },
    { '38': '1.001' },
    { '64': '20310115' },
    { '64': '20250114' },
    { '75': '20261031' },
    { '11': 'NOT-A-UUID' },
    { '55': 'US9123456789' },
    { '15': 'EUR' },
    { '40': '1' },
    { '59': '0' },
    { '854': '1' },
    { '423': '2' },
    { '43': 'X' },
  ])
    code(() => encodeFix44(fields(change)), 'INVALID_VALUE');
  assert.equal(
    decodeFix44(encodeFix44(fields({ '52': '20000229-12:00:00', '64': '20280229' }))).fields['52'],
    '20000229-12:00:00',
  );
  const pair = entries(first.fields);
  const misplaced = [
    ...pair.filter(([t]) => t !== '52'),
    ['52', first.fields['52']!] as [string, string],
  ];
  code(() => decodeFix44(wire(misplaced)), 'FIELD_ORDER');
  code(() => decodeFix44(wire([...pair, ['58', 'x'.repeat(257)]])), 'FIELD_LENGTH');
  code(() => decodeFix44(wire(pair.map(([tag, v]) => [tag === '11' ? '0' : tag, v]))), 'FRAMING');
  const reject = fixtures.find((f) => f.name === 'rejected')!.fields;
  code(() => encodeFix44({ ...reject, '103': '1' }), 'UNSUPPORTED_VALUE');
  const canceled = fixtures.find((f) => f.name === 'canceled')!.fields;
  code(() => encodeFix44({ ...canceled, '151': '1.00' }), 'INVALID_VALUE');
  const pending = fixtures.find((f) => f.name === 'pending-cancel')!.fields;
  code(() => encodeFix44({ ...pending, '14': '40000.00', '151': '0.00' }), 'INVALID_VALUE');
  const cancel = fixtures.find((f) => f.name === 'cancel-request')!.fields;
  code(() => encodeFix44({ ...cancel, '37': 'BIRCH-OTHER' }), 'INVALID_VALUE');
});
void test('independent review: impossible incremental length/checksum prefixes fail immediately', () => {
  for (const suffix of ['X', '0', '01', '1x'])
    code(() => new Fix44Stream().push(Buffer.from('8=FIX.4.4\x019=' + suffix)), 'BODY_LENGTH');
  for (const suffix of ['8192', '99999'])
    code(() => new Fix44Stream().push(Buffer.from('8=FIX.4.4\x019=' + suffix)), 'FRAME_LIMIT');
  const bytes = raw(first);
  const end = bytes.length - 7;
  for (const suffix of ['10=x', '10=0x', '10=00x'])
    code(
      () => new Fix44Stream().push(Buffer.concat([bytes.subarray(0, end), Buffer.from(suffix)])),
      'CHECKSUM',
    );
  code(
    () => new Fix44Stream().push(Buffer.concat([bytes.subarray(0, end), Buffer.from('11')])),
    'BODY_LENGTH',
  );
  for (const suffix of ['', '1', '10', '10=', '10=0', '10=00', '10=000']) {
    const parser = new Fix44Stream();
    assert.equal(
      parser.push(Buffer.concat([bytes.subarray(0, end), Buffer.from(suffix)])).status,
      'incomplete',
    );
  }
});
void test('independent review: unsupported messages cannot mask malformed retransmission headers', () => {
  for (const change of [
    { '43': 'X' },
    { '43': 'Y' },
    { '43': 'Y', '122': 'not-a-time' },
    { '43': 'N', '122': '20261030-14:00:00.000' },
  ])
    code(() => decodeFix44(wire(entries(fields({ '35': 'A', ...change })))), 'INVALID_VALUE');
});
