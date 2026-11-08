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
    return seed >> 16n;
  };
  const parCents = [1n, 3n, 125n, 300n, 1000n, 10000n];
  for (let b = 0; b < 60; b++) {
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
  const generatedProfiles = [
    ...new Set(books.flatMap((book) => book.map((row) => row.instrument_id + ':' + row.side))),
  ].sort();
  assert.deepEqual(
    generatedProfiles,
    ['SYN-CORP-2031:BUY', 'SYN-CORP-2031:SELL', 'SYN-UST-2031:BUY', 'SYN-UST-2031:SELL'],
    'generated FIFO corpus must cover both sides of each instrument',
  );
  const opposingBooks = books.filter((book) =>
    ['SYN-UST-2031', 'SYN-CORP-2031'].some(
      (id) =>
        new Set(book.filter((row) => row.instrument_id === id).map((row) => row.side)).size === 2,
    ),
  ).length;
  assert.ok(
    opposingBooks > 0,
    'generated FIFO books must actually consume same-instrument opposing lots',
  );
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
  const corp = { instrument_id: 'SYN-CORP-2031', definition_version: 'phase1-corp-1' } as const;
  const crossings = [
    [
      fill(1, 'BUY', '30.00', '3000'),
      fill(2, 'BUY', '70.00', '7100'),
      fill(3, 'SELL', '120.00', '13200'),
      fill(4, 'BUY', '5.00', '500'),
    ],
    [
      fill(1, 'SELL', '30.00', '3300', corp),
      fill(2, 'SELL', '70.00', '7000', corp),
      fill(3, 'BUY', '120.00', '12000', corp),
      fill(4, 'SELL', '5.00', '550', corp),
    ],
  ];
  const quantity = (row: EconomicExecution) => BigInt(row.par_amount.replace('.', ''));
  for (const book of crossings) {
    const [first, second, crossing, partialCover] = book;
    assert.ok(first && second && crossing && partialCover);
    assert.equal(first.instrument_id, second.instrument_id);
    assert.equal(first.instrument_id, crossing.instrument_id);
    assert.equal(first.instrument_id, partialCover.instrument_id);
    assert.equal(first.side, second.side);
    assert.notEqual(first.side, crossing.side);
    assert.equal(first.side, partialCover.side);
    assert.ok(
      BigInt(first.command_seq) < BigInt(second.command_seq) &&
        BigInt(second.command_seq) < BigInt(crossing.command_seq) &&
        BigInt(crossing.command_seq) < BigInt(partialCover.command_seq),
    );
    const opening = quantity(first) + quantity(second);
    assert.ok(quantity(crossing) > opening, 'explicit crossing must consume both opening lots');
    assert.ok(
      quantity(partialCover) > 0n && quantity(partialCover) < quantity(crossing) - opening,
      'explicit partial cover must retain the crossed position',
    );
  }
  books.push(...crossings);
  books.push([
    fill(1, 'BUY', '100.00', '10000'),
    fill(2, 'SELL', '100.00', '11000', corp),
    fill(3, 'SELL', '40.00', '4400'),
    fill(4, 'BUY', '40.00', '4000', corp),
    fill(5, 'SELL', '90.00', '9900'),
    fill(6, 'BUY', '90.00', '9000', corp),
  ]);
  books.push([
    fill(3, 'BUY', '40.00', '4000', { command_seq: '7' }),
    fill(1, 'SELL', '60.00', '6600', { command_seq: '7' }),
    fill(2, 'BUY', '100.00', '10000', { command_seq: '7' }),
  ]);
  console.log(
    'FIFO_ORACLE_COVERAGE ' +
      JSON.stringify({
        generated_books: 60,
        generated_instrument_sides: generatedProfiles.length,
        generated_opposing_books: opposingBooks,
        explicit_multi_lot_crossings: crossings.length,
        explicit_books: books.length - 60,
        total_books: books.length,
      }),
  );
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
