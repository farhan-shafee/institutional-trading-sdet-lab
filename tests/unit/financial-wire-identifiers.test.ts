import assert from 'node:assert/strict';
import { test } from 'node:test';
import { curveFixtureIds } from '../../app/domain/fixed-income-v3/curves.js';
import { curveFixtureIds as wireFixtures } from '../../app/domain/fixed-income-v3/wire-identifiers.js';
import { assessmentModel, assessmentReasons } from '../../app/domain/post-trade/assessment.js';
import { dollarRiskModel } from '../../app/domain/post-trade/risk.js';
import { fifoModel } from '../../app/domain/post-trade/fifo.js';
import * as wire from '../../app/domain/post-trade/wire-identifiers.js';

await test('browser wire identifiers exactly match all preserved financial kernel discriminants', () => {
  assert.deepEqual(wireFixtures, curveFixtureIds);
  assert.deepEqual(wire.assessmentReasons, assessmentReasons);
  assert.equal(wire.assessmentModel, assessmentModel);
  assert.equal(wire.dollarRiskModel, dollarRiskModel);
  assert.equal(wire.fifoModel, fifoModel);
});
