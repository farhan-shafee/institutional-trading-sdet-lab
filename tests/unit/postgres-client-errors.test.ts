import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

for (const adapter of ['workflow', 'verification']) {
  for (const scenario of [
    'acquire',
    'before-commit',
    'after-commit',
    'readonly',
    'readonly-commit',
    'late-destroy',
    'healthy',
  ]) {
    await test(`${adapter} owns checked-out client errors: ${scenario}`, () => {
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'tests/unit/postgres-client-error-worker.ts', adapter, scenario],
        {
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      assert.equal(child.status, 0, child.stderr || child.stdout);
      const result = JSON.parse(child.stdout) as {
        adapter: string;
        scenario: string;
        passed: boolean;
      };
      assert.equal(result.adapter, adapter);
      assert.equal(result.scenario, scenario);
      assert.equal(result.passed, true);
    });
  }
}
