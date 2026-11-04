import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { decodeFix44, Fix44Error } from '../../../app/protocol/fix44/index.js';

interface FrameEvent {
  kind: string;
  file?: string;
  sha256?: string;
  direction?: string;
}
interface SessionCase {
  id: string;
  events: FrameEvent[];
  expected: {
    classification: string;
    code: string;
    event_index: number;
    state: string;
    next_i_to_a: number;
    next_a_to_i: number;
    pending_i: string | null;
    pending_a: string | null;
  };
}
interface Corpus {
  version: string;
  cases: SessionCase[];
}
interface Contract {
  standard: string;
  version: number;
  messages: Record<string, { required_body: string[]; optional_body: string[] }>;
  claim_limits: Record<string, boolean>;
  classifications: Record<string, string[]>;
}
const root = process.cwd();
const directory = join(root, 'test-data/fix44/session');
const corpus = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as Corpus;
const expectedIds = [
  'C01_INITIATOR_LOGOUT',
  'C02_ACCEPTOR_LOGOUT',
  'C03_ORDINARY_HEARTBEATS',
  'C04_INITIATOR_TEST_REQUEST',
  'C05_ACCEPTOR_TEST_REQUEST',
  'C06_CROSSED_REQUESTS',
  'C07_LOGON_REQUIRED_FIELD',
  'C07_LOGON_MALFORMED_INTEGER',
  'C08_EARLY_HEARTBEAT_ID',
  'C09_ACCEPTOR_STARTS',
  'C10_DUPLICATE_LOGON',
  'C11_COMP_ID',
  'C12_SEQUENCE_GAP',
  'C13_SEQUENCE_TOO_LOW',
  'C14_MARKED_REPLAY',
  'C15_REPLAY_MISSING_ORIGINAL',
  'C16_REPLAY_REVERSED_TIME',
  'C16_ORIGINAL_WITHOUT_FLAG',
  'C17_RESEND_REQUEST',
  'C18_SEQUENCE_RESET',
  'C18_LOGON_RESET',
  'C19_SESSION_REJECT',
  'C20_APPLICATION_ORDER',
  'C20_APPLICATION_EXECUTION',
  'C20_APPLICATION_CANCEL',
  'C20_APPLICATION_CANCEL_REJECT',
  'C21_TEST_ID_MISMATCH',
  'C22_TEST_RESPONSE_MISSING',
  'C23_LOGON_REPLY_MISSING',
  'C24_LOGOUT_REPLY_MISSING',
  'C25_AFTER_CLOSED_SEQUENCE_PRIORITY',
  'C25_RECONNECT_AFTER_CLOSED',
  'C25_RECONNECT_OBSERVATION',
  'C26_CHECKSUM_BEFORE_UNSUPPORTED',
  'C26_DUPLICATE_FIELD',
  'C26_BAD_CALENDAR',
  'C26_TRUNCATED',
  'C27_UNKNOWN_BODY_TAG',
  'C27_KNOWN_EXCLUDED_FIELD',
  'C27_MALFORMED_EXCLUDED_FIELD',
  'C27_WRONG_MESSAGE_MEMBER',
  'C27_EXCLUDED_HEADER',
  'C27_BAD_EXCLUDED_HEADER',
  'C27_GROUP_EXCLUDED',
  'C27_GROUP_MEMBER_WITHOUT_COUNT',
  'C28_SEQUENCE_RANGE',
  'C28_SEQUENCE_LEADING_ZERO',
  'C28_VALUE_LIMIT',
  'C29_TEST_ID_REUSE',
  'C29_PENDING_BEFORE_REUSE',
  'C30_LOGOUT_WITH_REQUEST',
  'C30_BAD_TEST_ID',
  'C30_BAD_LOGOUT_TEXT',
  'C31_UNKNOWN_MESSAGE',
  'C31_PERIODIC_DOES_NOT_CLEAR',
  'C32_EMPTY_SESSION',
  'C32_LOGOUT_MISSING',
  'C32_CONNECTION_LOST',
  'C32_LOSS_AFTER_CLOSED',
];

void test('session corpus executes the independently reviewed inventory without orphaned vectors', () => {
  assert.equal(corpus.version, 'tradeflow-fix-session-corpus-v1');
  assert.deepEqual(
    corpus.cases.map((c) => c.id),
    expectedIds,
  );
  const references = new Map<string, string>();
  const contract = parse(readFileSync('contracts/fix-session-v1.yaml', 'utf8')) as Contract;
  for (const c of corpus.cases) {
    assert.equal(c.events.at(-1)?.kind, 'END');
    assert.equal(c.events.filter((e) => e.kind === 'END').length, 1);
    assert.ok(c.events.length <= 33);
    assert.ok(contract.classifications[c.expected.classification]?.includes(c.expected.code));
    for (const e of c.events) {
      if (e.kind !== 'FRAME') continue;
      assert.match(e.file!, /^[a-z0-9_-]{1,64}\.fix$/);
      if (references.has(e.file!)) assert.equal(references.get(e.file!), e.sha256);
      references.set(e.file!, e.sha256!);
      assert.equal(
        createHash('sha256')
          .update(readFileSync(join(directory, e.file!)))
          .digest('hex'),
        e.sha256,
      );
    }
  }
  assert.deepEqual(
    readdirSync(directory)
      .filter((name) => name.endsWith('.fix'))
      .sort(),
    [...references.keys()].sort(),
  );
});

void test('conformant admin frames have independently counted bytes but stay rejected by the application codec', () => {
  const files = new Set(
    corpus.cases
      .filter((c) => c.expected.classification === 'IN_SCOPE_CONFORMANT')
      .flatMap((c) => c.events.filter((e) => e.kind === 'FRAME').map((e) => e.file!)),
  );
  const observedTypes = new Set<string>();
  for (const file of files) {
    const raw = readFileSync(join(directory, file));
    const text = raw.toString('ascii');
    assert.equal(raw.at(-1), 1);
    assert.ok(!raw.includes(124) && !raw.includes(10) && !raw.includes(13));
    const bodyStart = raw.indexOf(1, raw.indexOf(1) + 1) + 1;
    const trailerStart = raw.length - 7;
    const pieces = text.split('\x01');
    assert.equal(pieces[0], '8=FIX.4.4');
    assert.equal(Number(pieces[1]!.slice(2)), trailerStart - bodyStart);
    assert.equal(
      pieces.at(-2),
      '10=' +
        String([...raw.subarray(0, trailerStart)].reduce((a, b) => a + b, 0) % 256).padStart(
          3,
          '0',
        ),
    );
    observedTypes.add(pieces[2]!.slice(3));
    assert.throws(
      () => decodeFix44(raw),
      (error: unknown) => error instanceof Fix44Error && error.code === 'UNSUPPORTED_MESSAGE',
    );
  }
  assert.deepEqual([...observedTypes].sort(), ['0', '1', '5', 'A']);
});

void test('the session contract keeps claims and body requirements separate from financial evidence', () => {
  const contract = parse(readFileSync('contracts/fix-session-v1.yaml', 'utf8')) as Contract;
  assert.equal(contract.standard, 'FIX.4.4');
  assert.equal(contract.version, 1);
  assert.deepEqual(Object.keys(contract.messages).sort(), ['0', '1', '5', 'A']);
  assert.deepEqual(contract.messages['A']!.required_body, ['98', '108']);
  assert.deepEqual(contract.messages['1']!.required_body, ['112']);
  assert.deepEqual(contract.claim_limits, {
    offline_conformance_only: true,
    peer_interoperability_verified: false,
    delivery_verified: false,
    financial_application_verified: false,
    external_completeness_verified: false,
  });
});

function withGateCopy(action: (directory: string) => void): void {
  const temporary = mkdtempSync(join(tmpdir(), 'tf-session-gate-'));
  try {
    for (const relative of [
      'test-data/fix44',
      'verification/python',
      'verification/vendor/quickfix',
    ]) {
      cpSync(resolve(relative), join(temporary, relative), { recursive: true });
    }
    action(temporary);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
function requireGateFailure(directory: string): void {
  const result = spawnSync(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), resolve('scripts/verify-fix44.ts')],
    {
      cwd: directory,
      env: process.env,
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, null);
  assert.notEqual(
    result.status,
    0,
    'the real FIX gate must fail for omitted or invalid session evidence',
  );
}
void test(
  'the real FIX command propagates a session expected-result mismatch',
  { timeout: 30_000 },
  () => {
    withGateCopy((temporary) => {
      const path = join(temporary, 'test-data/fix44/session/manifest.json');
      const changed = JSON.parse(readFileSync(path, 'utf8')) as Corpus;
      changed.cases[0]!.expected.next_i_to_a = 4;
      writeFileSync(path, JSON.stringify(changed));
      requireGateFailure(temporary);
    });
  },
);
void test(
  'the real FIX command fails if the mandatory session test file is missing',
  { timeout: 30_000 },
  () => {
    withGateCopy((temporary) => {
      rmSync(join(temporary, 'verification/python/test_fix_session_reference.py'));
      requireGateFailure(temporary);
    });
  },
);
