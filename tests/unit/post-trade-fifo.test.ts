import assert from 'node:assert/strict';
import test from 'node:test';
import { fifo } from '../../app/domain/post-trade/fifo.js';
import type { EconomicExecution } from '../../app/domain/post-trade/economics.js';

function fill(
  index: number,
  side: 'BUY' | 'SELL',
  par: string,
  cents: string,
  extra: Partial<EconomicExecution> = {},
): EconomicExecution {
  return {
    execution_id: '00000000-0000-4000-8000-' + String(index).padStart(12, '0'),
    command_seq: String(index),
    instrument_id: 'SYN-UST-2031',
    definition_version: 'phase1-ust-1',
    side,
    par_amount: par,
    consideration_cents: cents,
    value_date: '2030-01-15',
    revision: 0,
    ...extra,
  };
}

void test('FIFO literal dirty basis retains rational partial cost and realized proceeds', () => {
  const r = fifo([fill(1, 'BUY', '100', '10088'), fill(2, 'SELL', '40', '4380')]);
  assert.equal(r.realized_usd.numerator, 431n);
  assert.equal(r.realized_usd.denominator, 125n);
  assert.equal(r.lots.length, 1);
  assert.equal(r.lots[0]!.remaining_par.fixed(2), '60.00');
  assert.equal(r.lots[0]!.remaining_basis_or_proceeds_usd.numerator, 7566n);
  assert.equal(r.lots[0]!.remaining_basis_or_proceeds_usd.denominator, 125n);
  assert.equal(r.positions[0]!.signed_par.fixed(2), '60.00');
});

void test('oldest long lots close first across multiple acquisition prices', () => {
  const r = fifo([
    fill(1, 'BUY', '100', '10000'),
    fill(2, 'BUY', '100', '12000'),
    fill(3, 'SELL', '150', '19500'),
  ]);
  assert.equal(r.realized_usd.fixed(2), '35.00');
  assert.equal(r.lots.length, 1);
  assert.equal(r.lots[0]!.opening_execution_id, fill(2, 'BUY', '100', '12000').execution_id);
  assert.equal(r.lots[0]!.remaining_par.fixed(2), '50.00');
  assert.equal(r.lots[0]!.remaining_basis_or_proceeds_usd.fixed(2), '60.00');
});

void test('partial penny-lot allocations remain exact rather than rounding each closure', () => {
  const r = fifo([
    fill(1, 'BUY', '0.03', '1'),
    fill(2, 'SELL', '0.01', '1'),
    fill(3, 'SELL', '0.01', '1'),
  ]);
  assert.equal(r.realized_usd.numerator, 1n);
  assert.equal(r.realized_usd.denominator, 75n);
  assert.equal(r.lots[0]!.remaining_par.fixed(2), '0.01');
  assert.equal(r.lots[0]!.remaining_basis_or_proceeds_usd.numerator, 1n);
  assert.equal(r.lots[0]!.remaining_basis_or_proceeds_usd.denominator, 300n);
});

void test('short sale realization uses allocated original proceeds minus cover cash', () => {
  const r = fifo([fill(1, 'SELL', '100', '11000'), fill(2, 'BUY', '40', '4000')]);
  assert.equal(r.realized_usd.fixed(2), '4.00');
  assert.equal(r.lots[0]!.side, 'SHORT');
  assert.equal(r.lots[0]!.remaining_par.fixed(2), '60.00');
  assert.equal(r.lots[0]!.remaining_basis_or_proceeds_usd.fixed(2), '66.00');
  assert.equal(r.positions[0]!.signed_par.fixed(2), '-60.00');
});

void test('crossing through long and short closes opposing lots before opening new exposure', () => {
  const r = fifo([
    fill(1, 'BUY', '50', '5000'),
    fill(2, 'SELL', '80', '8800'),
    fill(3, 'BUY', '50', '4500'),
  ]);
  assert.equal(r.realized_usd.fixed(2), '11.00');
  assert.equal(r.lots.length, 1);
  assert.equal(r.lots[0]!.side, 'LONG');
  assert.equal(r.lots[0]!.remaining_par.fixed(2), '20.00');
  assert.equal(r.lots[0]!.remaining_basis_or_proceeds_usd.fixed(2), '18.00');
});

void test("different instrument definitions never consume one another's lots", () => {
  const r = fifo([
    fill(1, 'BUY', '100', '10000'),
    fill(2, 'SELL', '100', '11000', {
      instrument_id: 'SYN-CORP-2031',
      definition_version: 'phase1-corp-1',
    }),
  ]);
  assert.equal(r.realized_usd.fixed(2), '0.00');
  assert.equal(r.lots.length, 2);
  assert.deepEqual(
    r.positions.map((p) => [p.instrument_id, p.signed_par.fixed(2)]),
    [
      ['SYN-UST-2031', '100.00'],
      ['SYN-CORP-2031', '-100.00'],
    ],
  );
});

void test('valid small corrected zero cash remains zero basis and can close for one cent', () => {
  const r = fifo([
    fill(1, 'BUY', '0.01', '0', { value_date: '2025-01-15', revision: 1 }),
    fill(2, 'SELL', '0.01', '1', { value_date: '2025-01-15' }),
  ]);
  assert.equal(r.realized_usd.fixed(2), '0.01');
  assert.equal(r.lots.length, 0);
  assert.equal(r.positions[0]!.signed_par.fixed(2), '0.00');
});

void test('corrections restate cash at original ordering and bust removal rebuilds without rewriting input', () => {
  const original = [
    fill(2, 'BUY', '10', '1200'),
    fill(1, 'BUY', '10', '1000'),
    fill(3, 'SELL', '10', '1100'),
  ];
  const before = JSON.stringify(original);
  assert.equal(fifo(original).realized_usd.fixed(2), '1.00');
  const corrected = original.map((e) =>
    e.command_seq === '1' ? { ...e, consideration_cents: '900', revision: 1 } : e,
  );
  assert.equal(fifo(corrected).realized_usd.fixed(2), '2.00');
  assert.equal(fifo(original.filter((e) => e.command_seq !== '1')).realized_usd.fixed(2), '-1.00');
  assert.equal(JSON.stringify(original), before);
});

void test('original sequence ties use stable canonical execution identity', () => {
  const first = fill(1, 'BUY', '10', '1000', { command_seq: '2' });
  const second = fill(2, 'BUY', '10', '1200', { command_seq: '2' });
  assert.equal(fifo([second, first, fill(3, 'SELL', '10', '1100')]).realized_usd.fixed(2), '1.00');
});

void test('empty FIFO math is exact and output cannot mutate its source calculation', () => {
  const empty = fifo([]);
  assert.equal(empty.realized_usd.numerator, 0n);
  assert.deepEqual(empty.lots, []);
  assert.deepEqual(empty.positions, []);
  const r = fifo([fill(1, 'BUY', '1', '100')]);
  assert.equal(Object.isFrozen(r), true);
  assert.equal(Object.isFrozen(r.lots), true);
  assert.equal(Object.isFrozen(r.lots[0]), true);
  assert.equal(Object.isFrozen(r.positions), true);
  assert.equal(Reflect.set(r.lots[0]!, 'side', 'SHORT'), false);
});

void test('FIFO rejects duplicate roots unsupported definitions invalid units and excess roots', () => {
  const good = fill(1, 'BUY', '1', '100');
  assert.throws(() => fifo([good, good]));
  assert.throws(() => fifo(Array.from({ length: 9 }, (_, i) => fill(i + 1, 'BUY', '1', '100'))));
  for (const fault of [
    { par_amount: '0' },
    { par_amount: '0.001' },
    { par_amount: '1000000000.01' },
    { consideration_cents: '-1' },
    { consideration_cents: '1.5' },
    { consideration_cents: '10002000000001' },
    { definition_version: 'UNKNOWN' },
    { instrument_id: 'SYN-ZERO-2031' },
    { value_date: '2031-01-15' },
    { command_seq: '0' },
    { execution_id: 'bad' },
    { unknown: true },
  ])
    assert.throws(() => fifo([{ ...good, ...fault } as EconomicExecution]));
});
