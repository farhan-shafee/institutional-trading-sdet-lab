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
          'continue-on-error': z.boolean().optional(),
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
  'npm audit',
  'npm audit --omit=dev',
  'npm run typecheck',
  'npm run lint',
  'npm run format:check',
  'npm run contract:validate',
  'npm run workflow:validate',
  'npm run test:unit',
  'npm run test:financial',
  'npm run build',
  'npm run smoke:production',
  'npm test',
]) {
  assert(
    steps.some((step) => step.run === command),
    `Missing CI gate: ${command}`,
  );
}
for (const command of ['npm audit', 'npm audit --omit=dev']) {
  const step = steps.find((candidate) => candidate.run === command);
  assert(
    step && step.if === undefined && step['continue-on-error'] !== true,
    'Dependency audits must be unconditional blocking gates.',
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

const persistence = workflowSchema
  .omit({ jobs: true })
  .extend({
    jobs: z.object({
      postgres: z.object({
        'runs-on': z.literal('ubuntu-latest'),
        'timeout-minutes': z.number().positive(),
        steps: z.array(
          z.object({
            run: z.string().optional(),
            'continue-on-error': z.boolean().optional(),
            if: z.string().optional(),
          }),
        ),
      }),
      workstation: z.object({
        'runs-on': z.literal('ubuntu-latest'),
        'timeout-minutes': z.number().positive(),
        steps: z.array(
          z.object({
            run: z.string().optional(),
            if: z.string().optional(),
            'continue-on-error': z.boolean().optional(),
          }),
        ),
      }),
      regression: z.object({
        'runs-on': z.literal('ubuntu-latest'),
        'timeout-minutes': z.number().positive(),
        steps: z.array(
          z.object({
            run: z.string().optional(),
            if: z.string().optional(),
            'continue-on-error': z.boolean().optional(),
          }),
        ),
      }),
    }),
  })
  .parse(parse(await readFile('.github/workflows/persistence.yml', 'utf8')));
const persistenceSteps = persistence.jobs.postgres.steps;
for (const command of [
  'npm ci',
  'npm audit',
  'npm audit --omit=dev',
  'npm run workflow:validate',
  'npm run test:postgres',
]) {
  const matches = persistenceSteps.filter((step) => step.run === command);
  assert(
    matches.length >= (command === 'npm run test:postgres' ? 2 : 1),
    `Missing persistence gate: ${command}`,
  );
  assert(
    matches.every((step) => step.if === undefined && step['continue-on-error'] !== true),
    'Persistence gates must be unconditional and blocking.',
  );
}
for (const command of [
  'npm ci',
  'npm run build:ui',
  'npx playwright install --with-deps chromium firefox webkit',
  'npm run test:workflow-browser',
  'npm run test:workflow-browser -- --repeat-each=2',
]) {
  const matches = persistence.jobs.workstation.steps.filter((step) => step.run === command);
  assert.equal(matches.length, 1, `Missing workstation gate: ${command}`);
  assert(
    matches.every((step) => step.if === undefined && step['continue-on-error'] !== true),
    'Workstation gates must be unconditional and blocking.',
  );
}
for (const command of ['npm ci', 'npm run validate', 'npm test -- --repeat-each=2 --retries=0']) {
  const matches = persistence.jobs.regression.steps.filter((step) => step.run === command);
  assert(matches.length === 1, `Missing independent legacy regression gate: ${command}`);
  assert(
    matches.every((step) => step.if === undefined && step['continue-on-error'] !== true),
    'Regression gates must be unconditional and blocking.',
  );
}
console.log(
  'Persistence workflow requires two fresh real-PostgreSQL executions; hosted results remain a separate check.',
);
