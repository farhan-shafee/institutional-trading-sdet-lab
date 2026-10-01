import { readFile } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { parse } from 'yaml';
import { z } from 'zod';

const workflowSchema = z.object({
  name: z.string(),
  on: z.object({ push: z.null(), pull_request: z.null(), workflow_dispatch: z.null() }),
  permissions: z.object({ contents: z.literal('read') }),
  jobs: z.object({
    quality: z.object({
      'runs-on': z.string(),
      'timeout-minutes': z.number().positive(),
      env: z.object({ CI: z.literal('true') }),
      steps: z.array(
        z.object({
          name: z.string(),
          uses: z.string().optional(),
          run: z.string().optional(),
          if: z.string().optional(),
          with: z.record(z.string(), z.unknown()).optional(),
        }),
      ),
    }),
  }),
});

const workflow = workflowSchema.parse(
  parse(await readFile('.github/workflows/quality.yml', 'utf8')),
);
const steps = workflow.jobs.quality.steps;
for (const command of [
  'npm ci',
  'npm run typecheck',
  'npm run lint',
  'npm run format:check',
  'npm run contract:validate',
  'npm run workflow:validate',
  'npm run test:unit',
  'npm test',
]) {
  assert(
    steps.some((step) => step.run === command),
    `Missing CI gate: ${command}`,
  );
}
assert(
  steps.some((step) => step.run?.includes('install --with-deps chromium firefox webkit')),
  'Missing cross-browser installation',
);
const uploads = steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'));
assert.equal(uploads.length, 2);
assert(
  uploads.some((step) => step.if === '${{ always() }}' && step.with?.path === 'playwright-report/'),
);
assert(
  uploads.some((step) => step.if === '${{ failure() }}' && step.with?.path === 'test-results/'),
);
for (const step of uploads) {
  assert(
    typeof step.with?.['retention-days'] === 'number' &&
      step.with['retention-days'] > 0 &&
      step.with['retention-days'] <= 14,
    'Artifact retention must be finite',
  );
}
console.log(
  'Workflow YAML parses; quality gates and finite artifact retention verified. GitHub-hosted execution remains a separate check.',
);
