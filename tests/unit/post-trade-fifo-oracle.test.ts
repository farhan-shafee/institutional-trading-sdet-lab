import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fifo } from '../../app/domain/post-trade/fifo.js';
import type { EconomicExecution } from '../../app/domain/post-trade/economics.js';
import type { Rational } from '../../app/domain/fixed-income-v3/numbers.js';

function fill(
  id: number,
  side: 'BUY' | 'SELL',
  par: string,
  cents: string,
  extra: Partial<EconomicExecution> = {},
): EconomicExecution {
  return {
    execution_id: '00000000-0000-4000-8000-' + String(id).padStart(12, '0'),
    command_seq: String((id % 16) + 1),
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
const pair = (r: Rational): readonly [string, string] => [
  r.numerator.toString(),
  r.denominator.toString(),
];
void test('68 FIFO books agree exactly with independent Fraction long short and partial-lot reconstruction', () => {
  const books: EconomicExecution[][] = [];
  let seed = 472651n;
  const next = (): bigint => {
    seed = (1103515245n * seed + 12345n) % 2147483648n;
    return seed;
  };
  const parCents = [1n, 3n, 125n, 300n, 1000n, 10000n];
  for (let b = 0; b < 64; b++) {
    const entries: EconomicExecution[] = [];
    for (let i = 0; i < b % 9; i++) {
      const amount = parCents[Number(next() % 6n)]!,
        price = 80n + (next() % 31n);
      const raw = amount * price;
      let cash = raw / 100n;
      const rem = raw % 100n;
      if (2n * rem > 100n || (2n * rem === 100n && cash % 2n === 1n)) cash++;
      const corp = next() % 2n === 1n;
      entries.push(
        fill(
          b * 16 + i + 1,
          next() % 2n === 0n ? 'BUY' : 'SELL',
          String(amount / 100n) + '.' + String(amount % 100n).padStart(2, '0'),
          cash.toString(),
          {
            command_seq: String(i + 1),
            revision: Number(next() % 3n),
            instrument_id: corp ? 'SYN-CORP-2031' : 'SYN-UST-2031',
            definition_version: corp ? 'phase1-corp-1' : 'phase1-ust-1',
          },
        ),
      );
    }
    books.push(b % 2 === 0 ? entries : entries.reverse());
  }
  books.push([fill(1, 'BUY', '100', '10088'), fill(2, 'SELL', '40', '4380')]);
  books.push([
    fill(1, 'BUY', '0.03', '1'),
    fill(2, 'SELL', '0.01', '1'),
    fill(3, 'SELL', '0.01', '1'),
  ]);
  books.push([fill(1, 'SELL', '100', '11000'), fill(2, 'BUY', '40', '4000')]);
  books.push([
    fill(1, 'BUY', '0.01', '0', { value_date: '2025-01-15', revision: 1 }),
    fill(2, 'SELL', '0.01', '1', { value_date: '2025-01-15' }),
  ]);
  assert.equal(books.length, 68);
  const expected = JSON.parse(
    execFileSync(
      'python3',
      [fileURLToPath(new URL('../../verification/python/fifo.py', import.meta.url))],
      { input: JSON.stringify(books), encoding: 'utf8', timeout: 10000 },
    ),
  ) as unknown[];
  assert.equal(expected.length, 68);
  books.forEach((book, index) => {
    const result = fifo(book);
    const actual = {
      realized: pair(result.realized_usd),
      lots: result.lots.map((lot) => ({
        ...lot,
        remaining_par: pair(lot.remaining_par),
        remaining_basis_or_proceeds_usd: pair(lot.remaining_basis_or_proceeds_usd),
      })),
      positions: result.positions.map((position) => ({
        ...position,
        signed_par: pair(position.signed_par),
      })),
    };
    assert.deepEqual(actual, expected[index], JSON.stringify({ index, book }));
  });
});
