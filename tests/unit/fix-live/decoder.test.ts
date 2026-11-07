import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  decodeLiveFix44,
  liveFix44Bytes,
  LiveFix44Error,
} from '../../../app/protocol/fix44-live/index.js';
import { decodeFix44, renderFix44 } from '../../../app/protocol/fix44/index.js';

type Vector = {
  name: string;
  raw_hex: string;
  sha256: string;
  accepted: boolean;
  fields?: Record<string, string>;
  type?: string;
  direction?: string;
  error?: string;
};
const vectors = JSON.parse(readFileSync('test-data/fix44/live/manifest.json', 'utf8')) as Vector[];
const first = vectors[0]!;
function wire(changes: Record<string, string | undefined> = {}, order?: string[]): Buffer {
  const f = Object.fromEntries(
    Object.entries({ ...first.fields, ...changes }).filter(
      ([k, v]) => !['8', '9', '10'].includes(k) && v !== undefined,
    ),
  ) as Record<string, string>;
  const header = order ?? [
    '35',
    '34',
    ...(f['43'] ? ['43'] : []),
    '49',
    '52',
    '56',
    ...(f['122'] ? ['122'] : []),
  ];
  const pairs = [
    ...header.map((k) => [k, f[k]!]),
    ...Object.entries(f).filter(([k]) => !header.includes(k)),
  ];
  const body = Buffer.from(pairs.map(([k, v]) => `${k}=${v}\x01`).join(''), 'ascii');
  const start = Buffer.concat([Buffer.from(`8=FIX.4.4\x019=${body.length}\x01`), body]);
  return Buffer.concat([
    start,
    Buffer.from(`10=${String([...start].reduce((s, b) => s + b, 0) % 256).padStart(3, '0')}\x01`),
  ]);
}
function error(input: Uint8Array, expected: string) {
  assert.throws(
    () => decodeLiveFix44(input),
    (e: unknown) => e instanceof LiveFix44Error && e.code === expected,
  );
}

for (const vector of vectors) {
  void test(`live decoder ${vector.accepted ? 'accepts authored terms' : 'rejects actual transport-only probe'}: ${vector.name}`, () => {
    const raw = Buffer.from(vector.raw_hex, 'hex');
    assert.equal(createHash('sha256').update(raw).digest('hex'), vector.sha256);
    if (!vector.accepted) {
      error(raw, vector.error!);
      return;
    }
    const parsed = decodeLiveFix44(raw);
    assert.equal(parsed.profile, 'live-fix-ingress-v1');
    assert.equal(parsed.type, vector.type);
    assert.equal(parsed.direction, vector.direction);
    assert.deepEqual({ ...parsed.fields }, vector.fields);
    assert.equal(parsed.sha256, vector.sha256);
    assert.deepEqual(liveFix44Bytes(parsed), raw);
    assert.throws(
      () => decodeFix44(raw),
      (e: unknown) => e instanceof Error && 'code' in e && e.code === 'FIELD_ORDER',
    );
  });
}

void test('raw provenance copies both the caller input and returned bytes', () => {
  const input = Buffer.from(first.raw_hex, 'hex');
  const parsed = decodeLiveFix44(input);
  input.fill(0);
  const returned = liveFix44Bytes(parsed);
  assert.equal(returned.toString('hex'), first.raw_hex);
  returned.fill(0);
  assert.equal(liveFix44Bytes(parsed).toString('hex'), first.raw_hex);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.fields));
});
void test('live and legacy trust registries reject structural casts', () => {
  const parsed = decodeLiveFix44(Buffer.from(first.raw_hex, 'hex'));
  assert.throws(
    () => liveFix44Bytes({ ...parsed }),
    (e: unknown) => e instanceof LiveFix44Error && e.code === 'UNTRUSTED_MESSAGE',
  );
  assert.throws(
    () => renderFix44(parsed),
    (e: unknown) => e instanceof Error && 'code' in e && e.code === 'UNTRUSTED_MESSAGE',
  );
});
void test('profile rejects legacy header order without rewriting the frame', () =>
  error(wire({}, ['35', '49', '56', '34', '52']), 'FIELD_ORDER'));
void test('fresh and retransmission headers require exact millisecond calendar timestamps', () => {
  for (const timestamp of [
    '20261107-13:00:00',
    '20261107-13:00:00.123456',
    '20260229-13:00:00.123',
    '20261107-25:00:00.123',
  ])
    error(wire({ '52': timestamp }), 'INVALID_VALUE');
  error(
    wire({ '43': 'Y', '122': '20261107-13:00:00.124', '52': '20261107-13:00:00.123' }),
    'INVALID_VALUE',
  );
});
void test('unobserved replay-header forms are refused', () => {
  error(wire({ '43': 'N' }), 'INVALID_VALUE');
  error(wire({ '122': '20261030-14:15:16.123' }), 'INVALID_VALUE');
  error(wire({ '43': 'Y' }), 'MISSING_FIELD');
});
void test('D requires the transport-only handling instruction and preserves economic rules', () => {
  error(wire({ '21': undefined }), 'MISSING_FIELD');
  error(wire({ '21': '2' }), 'UNSUPPORTED_VALUE');
  error(wire({ '44': '99.12' }), 'INVALID_VALUE');
  error(wire({ '38': '100000' }), 'INVALID_VALUE');
  error(wire({ '11': 'SYN-ORDER' }), 'INVALID_VALUE');
});
void test('only ATLAS and the existing business direction are allowed', () => {
  error(wire({ '56': 'BIRCH' }), 'INVALID_VALUE');
  error(wire({ '49': 'ATLAS', '56': 'TRADEFLOW' }), 'INVALID_VALUE');
});
void test('byte framing, checksum, field length and total limits fail before business processing', () => {
  error(new Uint8Array(8193), 'FRAME_LIMIT');
  error(wire({ '9999': 'x'.repeat(257) }), 'FIELD_LENGTH');
  error(wire({ '9999': 'unexpected' }), 'UNSUPPORTED_FIELD');
  const raw = Buffer.from(first.raw_hex, 'hex');
  raw[raw.length - 2] = raw[raw.length - 2] === 48 ? 49 : 48;
  error(raw, 'CHECKSUM');
  error(Buffer.from(first.raw_hex, 'hex').subarray(0, -1), 'TRUNCATED');
  const nonAscii = Buffer.from(first.raw_hex, 'hex');
  nonAscii[20] = 255;
  error(nonAscii, 'NON_ASCII');
});
void test('duplicate fields and surplus fields cannot overwrite financial values', () => {
  const valid = wire();
  const bodyStart = valid.indexOf(1, valid.indexOf(1) + 1) + 1;
  const body = Buffer.concat([
    valid.subarray(bodyStart, -7),
    Buffer.from('44=99.123456789012\x01'),
  ]);
  const start = Buffer.concat([Buffer.from(`8=FIX.4.4\x019=${body.length}\x01`), body]);
  const duplicate = Buffer.concat([
    start,
    Buffer.from(`10=${String([...start].reduce((s, b) => s + b, 0) % 256).padStart(3, '0')}\x01`),
  ]);
  error(duplicate, 'DUPLICATE_FIELD');
  const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(8000 + i), 'x']));
  error(wire(many), 'FIELD_LIMIT');
});
