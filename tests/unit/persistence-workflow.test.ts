import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import * as workflowValidation from '../../scripts/validate-workflow.js';

void test('persistence validation exposes a pure independently callable API', () => {
  assert.equal(typeof Reflect.get(workflowValidation, 'validatePersistenceWorkflow'), 'function');
});

type Mapping = Record<string, unknown>;
type Mutation = (workflow: Mapping) => void;

const jobIds = [
  'postgres-run-a',
  'postgres-run-b',
  'postgres',
  'workstation-baseline',
  'workstation-repeat',
  'workstation',
  'regression',
] as const;
type JobId = (typeof jobIds)[number];
const executionJobs = [
  'postgres-run-a',
  'postgres-run-b',
  'workstation-baseline',
  'workstation-repeat',
  'regression',
] as const;
const aggregateJobs = [
  { id: 'postgres', first: 'postgres-run-a', second: 'postgres-run-b' },
  { id: 'workstation', first: 'workstation-baseline', second: 'workstation-repeat' },
] as const;

function mapping(value: unknown): Mapping {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Mapping;
}

// This fixture comes from the reviewed YAML, independently of the validator's manifests.
const parsedWorkflow: unknown = parse(
  readFileSync(new URL('../../.github/workflows/persistence.yml', import.meta.url), 'utf8'),
);
const validWorkflow = mapping(parsedWorkflow);

function job(workflow: Mapping, id: JobId): Mapping {
  return mapping(mapping(workflow.jobs)[id]);
}

function steps(workflow: Mapping, id: JobId): unknown[] {
  const value = job(workflow, id).steps;
  assert(Array.isArray(value));
  return value as unknown[];
}

function step(workflow: Mapping, id: JobId, index: number): Mapping {
  return mapping(steps(workflow, id)[index]);
}

function commandIndex(workflow: Mapping, id: JobId, command: string): number {
  const index = steps(workflow, id).findIndex((candidate) => mapping(candidate).run === command);
  assert(index >= 0, 'The actual reviewed fixture must contain ' + id + ': ' + command);
  return index;
}

function commandStep(workflow: Mapping, id: JobId, command: string): Mapping {
  return step(workflow, id, commandIndex(workflow, id, command));
}

function replaceRun(workflow: Mapping, id: JobId, from: string, to: string): void {
  const target = step(workflow, id, 0);
  assert.equal(typeof target.run, 'string');
  const original = target.run as string;
  assert(
    original.includes(from),
    'The actual gate body must contain the independently named guard',
  );
  target.run = original.replace(from, to);
}

function rejectMutation(name: string, mutate: Mutation): void {
  void test('persistence validation rejects ' + name, () => {
    const candidate = structuredClone(validWorkflow);
    mutate(candidate);
    assert.throws(() => workflowValidation.validatePersistenceWorkflow(candidate));
  });
}

function freezeTree(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value as Mapping)) freezeTree(nested);
    Object.freeze(value);
  }
}

void test('persistence validation accepts the complete frozen reviewed workflow without mutation', () => {
  const candidate = structuredClone(validWorkflow);
  const before = structuredClone(candidate);
  freezeTree(candidate);
  assert.equal(workflowValidation.validatePersistenceWorkflow(candidate), undefined);
  assert.deepEqual(candidate, before);
  assert.equal(workflowValidation.validatePersistenceWorkflow(candidate), undefined);
});

void test('persistence validator imports and validates from an unrelated cwd without CLI output', () => {
  const validatorUrl = new URL('../../scripts/validate-workflow.ts', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '--eval',
      'const validation = await import(' +
        JSON.stringify(validatorUrl) +
        '); validation.validatePersistenceWorkflow(JSON.parse(process.argv[1]));',
      JSON.stringify(validWorkflow),
    ],
    {
      cwd: tmpdir(),
      env: { ...process.env, NODE_OPTIONS: '' },
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 65_536,
    },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
});

for (const [name, value] of [
  ['undefined', undefined],
  ['null', null],
  ['number', 1],
  ['string', 'not a workflow'],
  ['array', []],
  ['empty mapping', {}],
] as const) {
  void test('persistence validation rejects malformed input: ' + name, () => {
    assert.throws(() => workflowValidation.validatePersistenceWorkflow(value));
  });
}

for (const id of jobIds) {
  rejectMutation('missing job ' + id, (workflow) => {
    delete mapping(workflow.jobs)[id];
  });
  rejectMutation(id + ' changed runner', (workflow) => {
    job(workflow, id)['runs-on'] = 'windows-latest';
  });
  rejectMutation(id + ' changed 15-minute budget', (workflow) => {
    job(workflow, id)['timeout-minutes'] = 16;
  });
  rejectMutation(id + ' missing 15-minute budget', (workflow) => {
    delete job(workflow, id)['timeout-minutes'];
  });
  for (const tolerance of [true, false]) {
    rejectMutation(id + ' job continue-on-error=' + String(tolerance), (workflow) => {
      job(workflow, id)['continue-on-error'] = tolerance;
    });
    rejectMutation(id + ' step continue-on-error=' + String(tolerance), (workflow) => {
      step(workflow, id, 0)['continue-on-error'] = tolerance;
    });
  }
  rejectMutation(id + ' escalated job permissions', (workflow) => {
    job(workflow, id).permissions = { contents: 'write', 'id-token': 'write' };
  });
  rejectMutation(id + ' extra job environment', (workflow) => {
    const target = job(workflow, id);
    target.env = {
      ...(target.env === undefined ? {} : mapping(target.env)),
      NODE_OPTIONS: '--no-warnings',
    };
  });
  rejectMutation(id + ' extra step environment', (workflow) => {
    const target = step(workflow, id, 0);
    target.env = { ...(target.env === undefined ? {} : mapping(target.env)), CI: 'false' };
  });
  rejectMutation(id + ' extra step', (workflow) => {
    steps(workflow, id).push({ name: 'Unexpected executable step', run: 'echo unexpected' });
  });
  rejectMutation(id + ' extra step with field', (workflow) => {
    const target = step(workflow, id, 0);
    target.with = {
      ...(target.with === undefined ? {} : mapping(target.with)),
      unexpected: 'value',
    };
  });
  for (const [field, value] of [
    ['unexpected', true],
    ['strategy', { matrix: { shard: [1, 2] } }],
    ['matrix', { shard: [1, 2] }],
    ['container', 'node:24'],
    ['defaults', { run: { shell: 'sh' } }],
    ['shell', 'sh'],
    ['run-shell', 'sh'],
    ['environment', 'unreviewed'],
    ['services', { database: { image: 'postgres:18' } }],
    ['uses', './.github/workflows/unreviewed.yml'],
    ['retries', 1],
  ] as const) {
    rejectMutation(id + ' unexpected job field ' + field, (workflow) => {
      job(workflow, id)[field] = structuredClone(value);
    });
  }
  for (const [field, value] of [
    ['unexpected', true],
    ['defaults', { run: { shell: 'sh' } }],
    ['container', 'node:24'],
    ['matrix', { shard: [1, 2] }],
    ['run-shell', 'sh'],
    ['working-directory', '/tmp'],
    ['timeout-minutes', 1],
  ] as const) {
    rejectMutation(id + ' unexpected step field ' + field, (workflow) => {
      step(workflow, id, 0)[field] = structuredClone(value);
    });
  }
}

rejectMutation('an extra executable job', (workflow) => {
  mapping(workflow.jobs).unexpected = {
    'runs-on': 'ubuntu-latest',
    steps: [{ run: 'echo unexpected' }],
  };
});
rejectMutation('root permission escalation', (workflow) => {
  workflow.permissions = { contents: 'write' };
});
rejectMutation('an additional root permission', (workflow) => {
  mapping(workflow.permissions)['id-token'] = 'write';
});
rejectMutation('root permissions removed', (workflow) => {
  delete workflow.permissions;
});
rejectMutation('root write-all permissions', (workflow) => {
  workflow.permissions = 'write-all';
});
for (const [field, value] of [
  ['unexpected', true],
  ['env', { CI: 'false' }],
  ['defaults', { run: { shell: 'sh' } }],
  ['container', 'node:24'],
  ['strategy', { matrix: { shard: [1, 2] } }],
  ['matrix', { shard: [1, 2] }],
  ['shell', 'sh'],
  ['run-shell', 'sh'],
] as const) {
  rejectMutation('unexpected root field ' + field, (workflow) => {
    workflow[field] = structuredClone(value);
  });
}
for (const event of ['push', 'pull_request', 'workflow_dispatch']) {
  rejectMutation('missing root event ' + event, (workflow) => {
    delete mapping(workflow.on)[event];
  });
}
rejectMutation('filtered push event', (workflow) => {
  mapping(workflow.on).push = { paths: ['docs/**'] };
});
rejectMutation('a privileged pull_request_target event', (workflow) => {
  mapping(workflow.on).pull_request_target = null;
});
rejectMutation('changed concurrency group', (workflow) => {
  mapping(workflow.concurrency).group = 'persistence-static';
});
rejectMutation('disabled workflow cancellation', (workflow) => {
  mapping(workflow.concurrency)['cancel-in-progress'] = false;
});
rejectMutation('extra concurrency field', (workflow) => {
  mapping(workflow.concurrency).unexpected = true;
});

for (const id of [
  ...executionJobs.filter((value) => value !== 'regression'),
  'postgres',
  'workstation',
] as const) {
  rejectMutation(id + ' renamed explicit job name', (workflow) => {
    job(workflow, id).name = id + '-renamed';
  });
}
rejectMutation('a helper reusing the required postgres name', (workflow) => {
  job(workflow, 'postgres-run-a').name = 'postgres';
});
rejectMutation('a helper reusing the required workstation name', (workflow) => {
  job(workflow, 'workstation-baseline').name = 'workstation';
});

for (const { id, first } of [
  { id: 'postgres-run-b', first: 'postgres-run-a' },
  { id: 'workstation-repeat', first: 'workstation-baseline' },
] as const) {
  rejectMutation(id + ' missing sequential dependency', (workflow) => {
    delete job(workflow, id).needs;
  });
  rejectMutation(id + ' wrong sequential dependency', (workflow) => {
    job(workflow, id).needs = 'regression';
  });
  rejectMutation(id + ' extra sequential dependency', (workflow) => {
    job(workflow, id).needs = [first, 'regression'];
  });
}
for (const id of ['postgres-run-a', 'workstation-baseline', 'regression'] as const) {
  rejectMutation(id + ' unexpected dependency', (workflow) => {
    job(workflow, id).needs = 'postgres-run-b';
  });
}

for (const id of executionJobs) {
  rejectMutation(id + ' conditional execution job', (workflow) => {
    job(workflow, id).if = '$' + '{{ success() }}';
  });
  rejectMutation(id + ' changed CI environment', (workflow) => {
    mapping(job(workflow, id).env).CI = 'false';
  });
  rejectMutation(id + ' reordered steps', (workflow) => {
    const values = steps(workflow, id);
    [values[0], values[1]] = [values[1], values[0]];
  });
  rejectMutation(id + ' changed Node version', (workflow) => {
    mapping(step(workflow, id, 1).with)['node-version'] = '22';
  });
  rejectMutation(id + ' extra Node action option', (workflow) => {
    mapping(step(workflow, id, 1).with)['check-latest'] = true;
  });

  for (const [index, originalValue] of steps(validWorkflow, id).entries()) {
    const original = mapping(originalValue);
    if (typeof original.uses === 'string') {
      const action = original.uses;
      rejectMutation(id + ' changed action version at step ' + String(index), (workflow) => {
        step(workflow, id, index).uses = action.replace(/@.*$/, '@v0');
      });
      rejectMutation(
        id + ' action step also supplying a run body at step ' + String(index),
        (workflow) => {
          step(workflow, id, index).run = 'echo unexpected';
        },
      );
    }
    if (typeof original.run === 'string') {
      const command = original.run;
      const label = command.split('\n')[0] ?? command;
      rejectMutation(id + ' missing command step: ' + label, (workflow) => {
        steps(workflow, id).splice(index, 1);
      });
      rejectMutation(id + ' altered command: ' + label, (workflow) => {
        step(workflow, id, index).run = command + '\necho unexpected';
      });
      rejectMutation(id + ' conditional command: ' + label, (workflow) => {
        step(workflow, id, index).if = '$' + '{{ false }}';
      });
      rejectMutation(id + ' shell override: ' + label, (workflow) => {
        step(workflow, id, index).shell = 'sh';
      });
      rejectMutation(id + ' command tolerance: ' + label, (workflow) => {
        step(workflow, id, index)['continue-on-error'] = true;
      });
      rejectMutation(id + ' run step also supplying an action: ' + label, (workflow) => {
        step(workflow, id, index).uses = 'actions/checkout@v6';
      });
    }
  }
}

for (const { id, command, filtered } of [
  {
    id: 'postgres-run-a',
    command: 'npm run test:postgres',
    filtered: 'npm run test:postgres -- --test-name-pattern=smoke',
  },
  {
    id: 'postgres-run-b',
    command: 'npm run test:postgres',
    filtered: 'npm run test:postgres -- --test-name-pattern=smoke',
  },
  {
    id: 'workstation-baseline',
    command: 'npm run test:workflow-browser',
    filtered: 'npm run test:workflow-browser -- --project=chromium',
  },
  {
    id: 'workstation-repeat',
    command: 'npm run test:workflow-browser -- --repeat-each=2',
    filtered: 'npm run test:workflow-browser -- --repeat-each=2 --grep smoke',
  },
] as const) {
  rejectMutation(id + ' filtered verification command', (workflow) => {
    commandStep(workflow, id, command).run = filtered;
  });
  rejectMutation(id + ' doubled verification in one run body', (workflow) => {
    commandStep(workflow, id, command).run = command + '\n' + command;
  });
  rejectMutation(id + ' duplicate verification step', (workflow) => {
    steps(workflow, id).push(structuredClone(commandStep(workflow, id, command)));
  });
  rejectMutation(id + ' added verification retry flag', (workflow) => {
    commandStep(workflow, id, command).run = command + ' --retries=1';
  });
  rejectMutation(id + ' swallowed verification failure', (workflow) => {
    commandStep(workflow, id, command).run = command + ' || true';
  });
}
rejectMutation('workstation-repeat missing repeat-each=2', (workflow) => {
  commandStep(
    workflow,
    'workstation-repeat',
    'npm run test:workflow-browser -- --repeat-each=2',
  ).run = 'npm run test:workflow-browser';
});
rejectMutation('regression enabling legacy retries', (workflow) => {
  commandStep(workflow, 'regression', 'npm test -- --repeat-each=2 --retries=0').run =
    'npm test -- --repeat-each=2 --retries=1';
});
rejectMutation('regression filtering the complete validation gate', (workflow) => {
  commandStep(workflow, 'regression', 'npm run validate').run = 'npm run validate -- --grep smoke';
});

for (const id of ['workstation-baseline', 'workstation-repeat', 'regression'] as const) {
  rejectMutation(id + ' installing only two browser projects', (workflow) => {
    commandStep(workflow, id, 'npx playwright install --with-deps chromium firefox webkit').run =
      'npx playwright install --with-deps chromium firefox';
  });
}

for (const { id, first, second } of aggregateJobs) {
  for (const dependency of [first, second]) {
    rejectMutation(id + ' missing direct dependency ' + dependency, (workflow) => {
      job(workflow, id).needs = [first, second].filter((candidate) => candidate !== dependency);
    });
  }
  rejectMutation(id + ' extra direct dependency', (workflow) => {
    job(workflow, id).needs = [first, second, 'regression'];
  });
  rejectMutation(id + ' missing job always condition', (workflow) => {
    delete job(workflow, id).if;
  });
  rejectMutation(id + ' success-only job condition', (workflow) => {
    job(workflow, id).if = '$' + '{{ success() }}';
  });
  rejectMutation(id + ' dependency-success job condition', (workflow) => {
    job(workflow, id).if = '$' + "{{ needs['" + first + "'].result == 'success' }}";
  });
  rejectMutation(id + ' missing step always condition', (workflow) => {
    delete step(workflow, id, 0).if;
  });
  rejectMutation(id + ' changed step always condition', (workflow) => {
    step(workflow, id, 0).if = '$' + '{{ success() }}';
  });
  rejectMutation(id + ' changed Bash shell', (workflow) => {
    step(workflow, id, 0).shell = 'sh';
  });
  rejectMutation(id + ' missing empty aggregate permissions', (workflow) => {
    delete job(workflow, id).permissions;
  });
  rejectMutation(id + ' inherited aggregate read permissions', (workflow) => {
    job(workflow, id).permissions = { contents: 'read' };
  });
  rejectMutation(id + ' wrong first needs-result expression', (workflow) => {
    mapping(step(workflow, id, 0).env).FIRST_RESULT = '$' + "{{ needs['" + second + "'].result }}";
  });
  rejectMutation(id + ' wrong second needs-result expression', (workflow) => {
    mapping(step(workflow, id, 0).env).SECOND_RESULT = '$' + "{{ needs['" + first + "'].result }}";
  });
  rejectMutation(id + ' invalid cancelled() expression in step env', (workflow) => {
    mapping(step(workflow, id, 0).env).WORKFLOW_CANCELLED = '$' + '{{ cancelled() }}';
  });
  rejectMutation(id + ' invalid cancelled() expression in step run', (workflow) => {
    step(workflow, id, 0).run = 'echo "' + '$' + '{{ cancelled() }}' + '"';
  });
  rejectMutation(id + ' invalid cancelled() expression in step name', (workflow) => {
    step(workflow, id, 0).name = '$' + '{{ cancelled() }}';
  });
  rejectMutation(id + ' missing cancellation guard', (workflow) => {
    steps(workflow, id).splice(1, 1);
  });
  rejectMutation(id + ' modified cancellation guard condition', (workflow) => {
    step(workflow, id, 1).if = '$' + '{{ success() }}';
  });
  rejectMutation(id + ' removed cancellation guard condition', (workflow) => {
    delete step(workflow, id, 1).if;
  });
  rejectMutation(id + ' cancellation guard returns success', (workflow) => {
    step(workflow, id, 1).run = 'exit 0';
  });
  rejectMutation(id + ' cancellation guard has unexpected environment', (workflow) => {
    step(workflow, id, 1).env = { WORKFLOW_CANCELLED: '$' + '{{ cancelled() }}' };
  });
  for (const result of ['FIRST_RESULT', 'SECOND_RESULT']) {
    for (const accepted of ['skipped', 'failure']) {
      rejectMutation(id + ' Bash guard accepting ' + result + '=' + accepted, (workflow) => {
        replaceRun(
          workflow,
          id,
          'test "$' + result + "\" = 'success'",
          '[[ "$' + result + '" = \'success\' || "$' + result + '" = \'' + accepted + "' ]]",
        );
      });
    }
  }
  rejectMutation(id + ' swallowed aggregate failure', (workflow) => {
    replaceRun(
      workflow,
      id,
      'test "$SECOND_RESULT" = \'success\'',
      'test "$SECOND_RESULT" = \'success\' || true',
    );
  });
  rejectMutation(id + ' changed parsed final newline', (workflow) => {
    const target = step(workflow, id, 0);
    assert.equal(typeof target.run, 'string');
    target.run = (target.run as string).trimEnd();
  });
}

for (const { id } of aggregateJobs) {
  void test(id + ' independently rejects cancelled() in step env', () => {
    const candidate = structuredClone(validWorkflow);
    mapping(step(candidate, id, 0).env).WORKFLOW_CANCELLED = '$' + '{{ cancelled() }}';
    assert.throws(
      () => workflowValidation.validatePersistenceWorkflow(candidate),
      /Unsupported status-function expression context: jobs\./,
    );
  });
  void test(id + ' independently rejects cancelled() in step run', () => {
    const candidate = structuredClone(validWorkflow);
    step(candidate, id, 0).run = 'echo "' + '$' + '{{ cancelled() }}' + '"';
    assert.throws(
      () => workflowValidation.validatePersistenceWorkflow(candidate),
      /Unsupported status-function expression context: jobs\./,
    );
  });
  void test(id + ' independently rejects cancelled() in step name', () => {
    const candidate = structuredClone(validWorkflow);
    step(candidate, id, 0).name = '$' + '{{ cancelled() }}';
    assert.throws(
      () => workflowValidation.validatePersistenceWorkflow(candidate),
      /Unsupported status-function expression context: jobs\./,
    );
  });
}

function findBash(): string {
  const candidates =
    process.platform === 'win32'
      ? [
          ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
            .filter((value): value is string => value !== undefined)
            .flatMap((directory) => [
              join(directory, 'Git', 'bin', 'bash.exe'),
              join(directory, 'Git', 'usr', 'bin', 'bash.exe'),
            ]),
          ...(process.env.LOCALAPPDATA === undefined
            ? []
            : [join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')]),
        ]
      : ['/bin/bash', '/usr/bin/bash'];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try only existing Bash installations; missing Bash is a failure, never a skipped proof.
    }
  }
  assert.fail('A local Bash installation is required for the actual aggregate-script proof.');
}

const resultValues = ['success', 'failure', 'cancelled', 'skipped', '', 'unexpected'] as const;
const cancellationValues = ['false', 'true', ''] as const;
let bash: string | undefined;

for (const { id } of aggregateJobs) {
  for (const first of resultValues) {
    for (const second of resultValues) {
      for (const cancelled of cancellationValues) {
        const state =
          'first=' +
          JSON.stringify(first) +
          ' second=' +
          JSON.stringify(second) +
          ' cancelled=' +
          JSON.stringify(cancelled);
        void test(id + ' actual YAML Bash and cancellation policy: ' + state, () => {
          workflowValidation.validatePersistenceWorkflow(validWorkflow);
          const body = step(validWorkflow, id, 0).run;
          const cancellationStep = step(validWorkflow, id, 1);
          assert.equal(typeof body, 'string');
          assert.equal(cancellationStep.if, '$' + '{{ cancelled() }}');
          assert.equal(cancellationStep.shell, 'bash');
          assert.equal(typeof cancellationStep.run, 'string');
          bash ??= findBash();
          const child = spawnSync(bash, ['--noprofile', '--norc', '-c', body as string], {
            env: {
              PATH: process.env.PATH ?? '/usr/bin:/bin',
              SystemRoot: process.env.SystemRoot,
              WINDIR: process.env.WINDIR,
              LC_ALL: 'C',
              BASH_ENV: '',
              ENV: '',
              FIRST_RESULT: first,
              SECOND_RESULT: second,
            },
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
            timeout: 2_000,
            maxBuffer: 16_384,
          });
          assert.equal(child.error, undefined, state);
          assert.equal(child.signal, null, state);
          const expectedBashStatus = first === 'success' && second === 'success' ? 0 : 1;
          assert.equal(
            child.status,
            expectedBashStatus,
            state + '\n' + child.stdout + child.stderr,
          );

          // GitHub permits cancelled() in step.if, not step.env. This models its
          // true condition separately from the unconditional upstream-result step.
          if (cancelled === 'true') {
            const rejection = spawnSync(
              bash,
              ['--noprofile', '--norc', '-c', cancellationStep.run as string],
              {
                env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
                encoding: 'utf8',
                shell: false,
                windowsHide: true,
                timeout: 2_000,
                maxBuffer: 16_384,
              },
            );
            assert.equal(rejection.error, undefined, state);
            assert.equal(rejection.signal, null, state);
            assert.notEqual(
              rejection.status,
              0,
              'The cancellation step must reject workflow cancellation.',
            );
          }

          // Unknown cancellation status is NOT accepted as a release outcome.
          // This is an offline policy model, not GitHub scheduler attestation.
          const accepted = child.status === 0 && cancelled === 'false';
          assert.equal(
            accepted,
            first === 'success' && second === 'success' && cancelled === 'false',
            state,
          );
        });
      }
    }
  }
}
