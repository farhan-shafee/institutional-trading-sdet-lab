import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const persistenceStepSchema = z
  .object({
    name: z.string().min(1),
    uses: z.string().optional(),
    with: z.record(z.string(), z.unknown()).optional(),
    run: z.string().optional(),
    if: z.string().optional(),
    shell: z.string().optional(),
    env: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const persistenceJobSchema = z
  .object({
    name: z.string().optional(),
    needs: z.union([z.string(), z.array(z.string())]).optional(),
    if: z.string().optional(),
    'runs-on': z.literal('ubuntu-latest'),
    'timeout-minutes': z.literal(15),
    env: z.record(z.string(), z.unknown()).optional(),
    permissions: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(persistenceStepSchema),
  })
  .strict();

const persistenceWorkflowSchema = z
  .object({
    name: z.string(),
    on: z.object({ push: z.null(), pull_request: z.null(), workflow_dispatch: z.null() }).strict(),
    permissions: z.object({ contents: z.literal('read') }).strict(),
    concurrency: z.object({ group: z.string(), 'cancel-in-progress': z.boolean() }).strict(),
    jobs: z.record(z.string(), persistenceJobSchema),
  })
  .strict();

const nodeSetup = [
  { uses: 'actions/checkout@v6' },
  { uses: 'actions/setup-node@v7', with: { 'node-version': '24', cache: 'npm' } },
];
const archivePreference =
  [
    'test -f /etc/apt/apt-mirrors.txt',
    "grep -Fq 'mirror+file:/etc/apt/apt-mirrors.txt' /etc/apt/sources.list.d/ubuntu.sources",
    "printf '%s\\tpriority:%s\\n' \\",
    "  'https://archive.ubuntu.com/ubuntu/' 1 \\",
    "  'http://azure.archive.ubuntu.com/ubuntu/' 2 \\",
    "  'https://security.ubuntu.com/ubuntu/' 3 |",
    '  sudo tee /etc/apt/apt-mirrors.txt > /dev/null',
  ].join('\n') + '\n';
const postgresSteps = [
  ...nodeSetup,
  { run: 'npm ci' },
  { run: 'npm audit' },
  { run: 'npm audit --omit=dev' },
  { run: 'npm run workflow:validate' },
  { run: 'npm run test:postgres' },
];
const browserSetup = [
  ...nodeSetup,
  { run: 'npm ci' },
  { run: 'npm run build:ui' },
  { run: archivePreference },
  { run: 'npx playwright install --with-deps chromium firefox webkit' },
];
const aggregateCommand =
  [
    'set -euo pipefail',
    'printf \'first=%s second=%s\\n\' "$FIRST_RESULT" "$SECOND_RESULT"',
    'test "$FIRST_RESULT" = \'success\'',
    'test "$SECOND_RESULT" = \'success\'',
  ].join('\n') + '\n';

function aggregateJob(name: string, first: string, second: string) {
  return {
    name,
    needs: [first, second],
    if: '${{ always() }}',
    'runs-on': 'ubuntu-latest',
    'timeout-minutes': 15,
    permissions: {},
    steps: [
      {
        if: '${{ always() }}',
        shell: 'bash',
        env: {
          FIRST_RESULT: `\${{ needs['${first}'].result }}`,
          SECOND_RESULT: `\${{ needs['${second}'].result }}`,
        },
        run: aggregateCommand,
      },
      {
        if: '${{ cancelled() }}',
        shell: 'bash',
        run: 'exit 1',
      },
    ],
  };
}

const executionEnvironment = {
  'runs-on': 'ubuntu-latest',
  'timeout-minutes': 15,
  env: { CI: 'true' },
};
const expectedPersistenceWorkflow = {
  name: 'TradeFlow persistence foundation',
  on: { push: null, pull_request: null, workflow_dispatch: null },
  permissions: { contents: 'read' },
  concurrency: { group: 'persistence-${{ github.ref }}', 'cancel-in-progress': true },
  jobs: {
    'postgres-run-a': {
      name: 'postgres-run-a',
      ...executionEnvironment,
      steps: postgresSteps,
    },
    'postgres-run-b': {
      name: 'postgres-run-b',
      needs: 'postgres-run-a',
      ...executionEnvironment,
      steps: postgresSteps,
    },
    postgres: aggregateJob('postgres', 'postgres-run-a', 'postgres-run-b'),
    'workstation-baseline': {
      name: 'workstation-baseline',
      ...executionEnvironment,
      steps: [...browserSetup, { run: 'npm run test:workflow-browser' }],
    },
    'workstation-repeat': {
      name: 'workstation-repeat',
      needs: 'workstation-baseline',
      ...executionEnvironment,
      steps: [...browserSetup, { run: 'npm run test:workflow-browser -- --repeat-each=2' }],
    },
    workstation: aggregateJob('workstation', 'workstation-baseline', 'workstation-repeat'),
    regression: {
      ...executionEnvironment,
      steps: [
        ...nodeSetup,
        { uses: 'actions/setup-python@v6', with: { 'python-version': '3.12' } },
        { run: 'npm ci' },
        { run: archivePreference },
        { run: 'npx playwright install --with-deps chromium firefox webkit' },
        { run: 'npm run validate' },
        { run: 'npm test -- --repeat-each=2 --retries=0' },
      ],
    },
  },
};

const statusFunctionExpression = /\$\{\{[^}]*\b(?:always|cancelled|failure|success)\s*\(/;

function validateStatusFunctionContexts(value: unknown, path: string[] = []): void {
  if (typeof value === 'string') {
    if (statusFunctionExpression.test(value)) {
      const jobIf = path.length === 3 && path[0] === 'jobs' && path[2] === 'if';
      const stepIf =
        path.length === 5 && path[0] === 'jobs' && path[2] === 'steps' && path[4] === 'if';
      assert(jobIf || stepIf, 'Unsupported status-function expression context: ' + path.join('.'));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateStatusFunctionContexts(item, [...path, String(index)]));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [field, item] of Object.entries(value)) {
      validateStatusFunctionContexts(item, [...path, field]);
    }
  }
}

export function validatePersistenceWorkflow(input: unknown): void {
  validateStatusFunctionContexts(input);
  const workflow = persistenceWorkflowSchema.parse(input);
  // Step names are descriptive; every field that can affect execution is compared exactly.
  const normalized = {
    ...workflow,
    jobs: Object.fromEntries(
      Object.entries(workflow.jobs).map(([id, job]) => [
        id,
        {
          ...job,
          steps: job.steps.map((step) => {
            const { name, ...executable } = step;
            assert(name.length > 0);
            return executable;
          }),
        },
      ]),
    ),
  };
  assert.deepEqual(
    normalized,
    expectedPersistenceWorkflow,
    'Persistence jobs must preserve the reviewed complete workloads and fail-closed gates.',
  );
}

async function validateWorkflows(): Promise<void> {
  const qualitySource: unknown = parse(await readFile('.github/workflows/quality.yml', 'utf8'));
  z.object({
    jobs: z
      .object({ quality: z.object({ name: z.literal('quality').optional() }).passthrough() })
      .strict(),
  })
    .passthrough()
    .parse(qualitySource);
  const workflow = workflowSchema.parse(qualitySource);
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
    'npm run test:fix44',
    'npm run build',
    'npm run smoke:production',
    'npm test',
  ]) {
    assert(
      steps.some((step) => step.run === command),
      `Missing CI gate: ${command}`,
    );
  }
  for (const command of ['npm audit', 'npm audit --omit=dev', 'npm run test:fix44']) {
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
    uploads.some(
      (step) => step.if === '${{ always() }}' && step.with?.path === 'playwright-report/',
    ),
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

  validatePersistenceWorkflow(parse(await readFile('.github/workflows/persistence.yml', 'utf8')));
  console.log(
    'Persistence workflow requires two fresh real-PostgreSQL executions; hosted results remain a separate check.',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await validateWorkflows();
}
