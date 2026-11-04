import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import fsPromises, { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import type { OwnedDescriptor } from '../../scripts/owned-postgres.js';
import { savePrivate, replacePrivate } from '../../scripts/private-state.js';

const scenarios = [
  ['recovery', 'confirmed Docker bind failure gets a fully cleaned fresh allocation'],
  ['recovery-linux-listen', 'Linux listen bind failure gets a fully cleaned fresh allocation'],
  [
    'recovery-linux-allocated',
    'Linux allocated-port bind failure gets a fully cleaned fresh allocation',
  ],
  ['exhausted', 'confirmed Docker bind failures stop after three cleaned allocations'],
  ['unexpected', 'unrelated Docker permission failure is sanitized and never retried'],
  ['wrong-exit', 'binding text with a different Docker exit status is never retried'],
  ['timeout', 'timed-out Docker run is never treated as a retryable bind failure'],
  ['signal', 'signal-terminated Docker run is never treated as a retryable bind failure'],
  ['generic-bind', 'generic bind permission text without loopback context is never retried'],
  ['owner-mismatch', 'container ownership mismatch prevents deletion and replacement'],
  ['volume-owner-mismatch', 'volume ownership mismatch prevents volume deletion and replacement'],
  ['cleanup-failure', 'failed owned cleanup prevents a replacement allocation'],
  ['volume-create-failure', 'uncertain volume creation is ownership-checked and cleaned'],
  ['cancel-run', 'cancellation awaits late daemon allocation before owned cleanup'],
  ['cancel-cleanup', 'cancellation during failed-allocation cleanup prevents retry'],
  ['native', 'native PostgreSQL keeps its loopback probe and private password file'],
  ['stable-restart', 'owned restart preserves identity, data and the original client endpoint'],
  ['minimum-port', 'daemon-confirmed minimum port is used by descriptor and clients'],
  ['maximum-port', 'daemon-confirmed maximum port is used by descriptor and clients'],
  ['port-wildcard', 'wildcard Docker published address is rejected and cleaned'],
  ['port-ipv6', 'IPv6 Docker published address is rejected and cleaned'],
  ['port-multiple', 'multiple Docker published address lines are rejected and cleaned'],
  ['port-zero', 'Docker published port zero is rejected and cleaned'],
  ['port-overflow', 'Docker published port above 65535 is rejected and cleaned'],
  ['port-negative', 'negative Docker published port is rejected and cleaned'],
  ['port-fraction', 'fractional Docker published port is rejected and cleaned'],
  ['port-missing', 'missing Docker published port is rejected and cleaned'],
  ['port-other-host', 'another IPv4 Docker published address is rejected and cleaned'],
  [
    'handoff-recovery',
    'confirmed fixed-port handoff collision cleans the whole allocation before retry',
  ],
  ['handoff-exhausted', 'fixed-port handoff collisions stop after three complete allocations'],
  ['handoff-unexpected', 'unrelated fixed-port handoff failure is sanitized without retry'],
  ['cancel-final-run', 'cancellation awaits late permanent daemon allocation before cleanup'],
  ['cancel-temp-ready', 'cancellation during temporary readiness prevents final allocation'],
  ['cancel-final-ready', 'cancellation during permanent readiness prevents descriptor publication'],
  ['cancel-temp-stop', 'cancellation during temporary graceful stop prevents final allocation'],
  ['cancel-temp-rm', 'cancellation after temporary removal prevents final allocation'],
  ['mount-mismatch', 'a different mounted volume fails closed and is never removed'],
  ['mount-malformed', 'malformed Docker mount metadata fails closed'],
  ['dirty-exit', 'a nonzero temporary PostgreSQL exit prevents handoff'],
  ['oom-exit', 'an OOM-killed temporary PostgreSQL instance prevents handoff'],
  ['temp-id-drift', 'temporary container identity drift prevents handoff'],
  ['volume-in-use', 'another container using the owned volume prevents handoff'],
  ['fixed-binding-mismatch', 'permanent wildcard host configuration fails closed'],
  ['fixed-binding-malformed', 'malformed permanent host configuration fails closed'],
  ['restart-callback', 'restart restores the original service before reporting callback failure'],
  ['restart-pre-aborted', 'pre-aborted restart does not stop the owned service'],
  [
    'restart-cancel-stopped',
    'cancellation while stopped restores the original endpoint before rejection',
  ],
  [
    'restart-cancel-start',
    'late cancellation waits for Docker start and restores the original endpoint',
  ],
  ['restart-callback-and-cancel', 'callback failure takes precedence over subsequent cancellation'],
  ['restart-binding-drift', 'unexpected restart binding change rejects without descriptor rewrite'],
  ['restart-start-error', 'Docker start failure is sanitized and never reprovisions'],
  ['restart-stop-error', 'Docker stop failure is sanitized and never reprovisions'],
  ['restart-id-drift', 'restart identity drift fails closed without starting a replacement'],
  ['restart-owner-drift', 'restart ownership drift fails closed without deleting the resource'],
  ['restart-volume-drift', 'restart volume ownership drift fails closed without deletion'],
  [
    'restart-stopped-resume',
    'a stopped owned instance resumes with the same identity data and original URL',
  ],
  [
    'cancel-descriptor-publication',
    'cancellation immediately after atomic descriptor publication cleans the allocation',
  ],
] as const;
type Scenario = (typeof scenarios)[number][0];
type CommandOptions = { env?: NodeJS.ProcessEnv; signal?: AbortSignal };
const worker = process.argv[2] === '--owned-port-worker';
const bindMessage =
  'Error response from daemon: Ports are not available: exposing port TCP 127.0.0.1:33107 -> 0.0.0.0:0: listen tcp 127.0.0.1:33107: bind: An attempt was made to access a socket in a way forbidden by its access permissions.';

type DockerState = {
  name: string;
  id: string;
  nonce: string;
  volume: string;
  publish: string;
  port: string;
  running: boolean;
  exitCode: number;
  oom: boolean;
  phase: 'temporary' | 'permanent' | 'foreign';
};
type VolumeData = { sentinel?: string; databases: Set<string>; marker?: string };

async function scenarioWorker(scenario: Scenario): Promise<void> {
  const recovery = ['recovery', 'recovery-linux-listen', 'recovery-linux-allocated'].includes(
    scenario,
  );
  const restartScenario = scenario === 'stable-restart' || scenario.startsWith('restart-');
  const originalCwd = process.cwd();
  const temporary = await mkdtemp(join(tmpdir(), 'tradeflow-owned-ports-'));
  const emptyBin = join(temporary, 'empty-bin');
  await mkdir(emptyBin, { mode: 0o700 });
  const originalPath = process.env.PATH;
  const journalPath = join(
    originalCwd,
    '.local',
    'owned-postgres-unit-journals',
    randomUUID() + '.json',
  );
  await savePrivate(journalPath, { version: 1, scenario, allocations: [] });
  const allocations: string[] = [];
  const owners: OwnedDescriptor[] = [];
  const cleanBeforeReplacement: boolean[] = [];
  const runs: string[][] = [];
  const containers = new Map<string, DockerState>();
  const volumes = new Map<string, string>();
  const volumeData = new Map<string, VolumeData>();
  const connections: string[] = [];
  const warnings: string[] = [];
  const output: string[] = [];
  const harnessFailures: unknown[] = [];
  const removedContainers: string[] = [];
  const removedVolumes: string[] = [];
  const nativeSpawns: string[][] = [];
  const nativeStops: string[][] = [];
  const controller = new AbortController();
  const cancellation = new Error('Synthetic cancellation');
  const callbackFailure = new Error('Synthetic callback rejection');
  const cancellationEvents: string[] = [];
  const observations = {
    temporaryReady: 0,
    permanentReady: 0,
    namedReady: 0,
    temporaryStops: 0,
    temporaryRemoved: 0,
    manualStops: 0,
    starts: 0,
    stops: 0,
    staleConnections: 0,
    originalPort: '',
    restartedPort: '',
    descriptorUnchanged: false,
    sentinelRecovered: false,
    publicationHookObserved: false,
    publicationPorts: [] as string[],
  };
  const foreign: DockerState = {
    name: 'unrelated-synthetic-container',
    id: 'f'.repeat(64),
    nonce: 'foreign-owner',
    volume: 'unrelated-synthetic-volume',
    publish: '127.0.0.1:43000:5432',
    port: '43000',
    running: true,
    exitCode: 0,
    oom: false,
    phase: 'foreign',
  };
  containers.set(foreign.name, { ...foreign });
  volumes.set(foreign.volume, foreign.nonce);
  volumeData.set(foreign.volume, {
    sentinel: 'unrelated-retained-row',
    databases: new Set(['postgres']),
  });
  const ownedContainers = () =>
    [...containers.values()].filter((state) => state.phase !== 'foreign');
  const ownedVolumes = () => [...volumes.keys()].filter((name) => name !== foreign.volume);
  const verifiedContainers = new Set<string>();
  const verifiedVolumes = new Set<string>();
  const originalExecFile = childProcess.execFile;
  const originalRename = fsPromises.rename;
  let owned: { path: string; stop: (destroy?: boolean) => Promise<void> } | undefined;
  let mockCommandCalls = 0;
  let probes = 0;
  let runReceivedSignal = false;
  let volumeInspections = 0;
  let passwordFileChecked = false;
  let modelClock = Date.now();
  let restartActive = false;
  let restartStopped = false;
  let manualStopping = false;
  let foreignConsumer: DockerState | undefined;
  let currentPhase: 'temporary' | 'permanent' = 'temporary';
  const argument = (args: string[], flag: string): string => {
    const index = args.indexOf(flag);
    assert(index >= 0, 'required command argument is present');
    const value = args[index + 1];
    assert(value);
    return value;
  };
  const stateFor = (target: string): DockerState => {
    const state =
      containers.get(target) ??
      [...containers.values()].find((candidate) => candidate.id === target);
    assert(state, 'command targets an existing modelled container');
    assert.notEqual(state.phase, 'foreign', 'unrelated container is never targeted');
    return state;
  };
  const assertProvisional = (): void => {
    if (scenario === 'native' || owned || allocations.length === 0) return;
    const path = allocations.at(-1)!;
    if (!existsSync(path)) return;
    const owner = JSON.parse(readFileSync(path, 'utf8')) as OwnedDescriptor;
    const value = new URL(owner.adminUrl).port;
    if (scenario === 'cancel-descriptor-publication' && observations.publicationHookObserved) {
      assert.equal(value, discoveredPort, 'cleanup reads the atomically published fixed endpoint');
      assert(controller.signal.aborted, 'the publication hook already delivered cancellation');
      return;
    }
    observations.publicationPorts.push(value);
    assert.equal(
      value,
      '0',
      'descriptor stays provisional until permanent named-database readiness',
    );
  };
  const retryBindMessage =
    scenario === 'recovery-linux-listen'
      ? 'Error response from daemon: driver failed programming external connectivity on endpoint synthetic: listen tcp4 127.0.0.1:33211: bind: address already in use'
      : scenario === 'recovery-linux-allocated'
        ? 'Error response from daemon: driver failed programming external connectivity on endpoint synthetic: Bind for 127.0.0.1:33211 failed: port is already allocated'
        : bindMessage;
  const commandFailure = (stderr = retryBindMessage, details: Record<string, unknown> = {}) =>
    Object.assign(new Error('synthetic-private-command-message'), {
      code: 125,
      stdout: 'synthetic-private-command-stdout',
      stderr,
      killed: false,
      signal: null,
      ...details,
    });
  const publishedPorts: Partial<Record<Scenario, string>> = {
    'minimum-port': '127.0.0.1:1',
    'maximum-port': '127.0.0.1:65535',
    'port-wildcard': '0.0.0.0:33212',
    'port-ipv6': '[::1]:33212',
    'port-multiple': '127.0.0.1:33212\n127.0.0.1:33213',
    'port-zero': '127.0.0.1:0',
    'port-overflow': '127.0.0.1:65536',
    'port-negative': '127.0.0.1:-1',
    'port-fraction': '127.0.0.1:1.5',
    'port-missing': '',
    'port-other-host': '127.0.0.2:33212',
  };
  const discoveredPort =
    scenario === 'minimum-port' ? '1' : scenario === 'maximum-port' ? '65535' : '33212';
  const handleCommand = (
    file: string,
    args: string[],
    options?: CommandOptions,
  ): Promise<{ stdout: string; stderr: string }> => {
    let stdout = '';
    if (scenario === 'native') {
      const owner = owners[0]!;
      if (file.endsWith('/postgres') && args[0] === '--version')
        stdout = 'postgres (PostgreSQL) 17.10';
      else if (file.endsWith('/initdb')) {
        passwordFileChecked =
          readFileSync(argument(args, '--pwfile'), 'utf8') ===
          new URL(owner.adminUrl).password + '\n';
        mkdirSync(argument(args, '-D'), { mode: 0o700 });
      } else if (file.endsWith('/pg_ctl')) nativeStops.push(args);
      else assert.fail('Unexpected native command in isolated port regression');
      return Promise.resolve({ stdout, stderr: '' });
    }
    assert.equal(file, 'docker', 'no real external command is permitted');
    assertProvisional();
    if (args[0] === 'pull') {
      // Image resolution is simulated; no Docker daemon or network is contacted.
    } else if (args[0] === 'volume' && args[1] === 'create') {
      const name = args.at(-1)!;
      assert.equal(name, owners.at(-1)!.volume);
      assert(!volumes.has(name), 'new allocation never reuses a volume');
      volumes.set(name, argument(args, '--label').replace('tradeflow.owner=', ''));
      volumeData.set(name, { databases: new Set(['postgres']) });
      if (scenario === 'volume-create-failure')
        return Promise.reject(commandFailure('synthetic-private-volume-create-outcome-unknown'));
      stdout = name;
    } else if (args[0] === 'run') {
      runs.push(args);
      const name = argument(args, '--name');
      const nonce = argument(args, '--label').replace('tradeflow.owner=', '');
      const publish = argument(args, '--publish');
      const explicit = publish.match(/^127\.0\.0\.1:([1-9][0-9]*):5432$/);
      currentPhase = publish === '127.0.0.1::5432' ? 'temporary' : 'permanent';
      assert(
        currentPhase === 'temporary' || explicit,
        'only loopback automatic discovery or fixed handoff is permitted',
      );
      const mount = argument(args, '--mount');
      assert.match(mount, /^source=[^,]+,target=\/var\/lib\/postgresql\/data$/);
      const volume = mount.slice('source='.length).split(',')[0]!;
      assert.equal(name, owners.at(-1)!.container);
      assert.equal(nonce, owners.at(-1)!.nonce);
      assert.equal(volume, owners.at(-1)!.volume);
      assert.equal(volumes.get(volume), nonce);
      assert(
        !containers.has(name),
        'handoff removes the temporary container before creating permanent identity',
      );
      runReceivedSignal ||= options?.signal === controller.signal;
      const password = options?.env?.POSTGRES_PASSWORD;
      assert(
        password === new URL(owners.at(-1)!.adminUrl).password,
        'daemon receives the private synthetic password',
      );
      assert(
        !args.some((value) => value.includes(password)),
        'password is absent from command args',
      );
      const state: DockerState = {
        name,
        id: runs.length.toString(16).padStart(64, '0'),
        nonce,
        volume,
        publish,
        port: explicit?.[1] ?? discoveredPort,
        running: true,
        exitCode: 0,
        oom: false,
        phase: currentPhase,
      };
      if (currentPhase === 'permanent') {
        assert.equal(explicit![1], discoveredPort, 'handoff pins the daemon-confirmed port');
        assert.equal(
          volumeData.get(volume)!.sentinel,
          'synthetic-temporary-row',
          'handoff keeps data in the same volume',
        );
        const temporaryRun = runs.find((previous) => argument(previous, '--name') === name)!;
        assert.equal(argument(temporaryRun, '--mount'), mount);
        assert.deepEqual(
          args.slice(args.indexOf('postgres') + 1),
          temporaryRun.slice(temporaryRun.indexOf('postgres') + 1),
          'both phases retain PostgreSQL settings',
        );
      }
      const lateCancellation =
        (scenario === 'cancel-run' && currentPhase === 'temporary') ||
        (scenario === 'cancel-final-run' && currentPhase === 'permanent');
      if (lateCancellation) {
        return new Promise((resolve) => {
          queueMicrotask(() => {
            controller.abort(cancellation);
            cancellationEvents.push('aborted');
            queueMicrotask(() => {
              containers.set(name, state);
              cancellationEvents.push('daemon-created', 'run-settled');
              resolve({ stdout: state.id, stderr: '' });
            });
          });
        });
      }
      containers.set(name, state);
      if (currentPhase === 'temporary') {
        if (scenario === 'unexpected')
          return Promise.reject(
            commandFailure('Error response from daemon: synthetic-private-file permission denied'),
          );
        if (scenario === 'wrong-exit')
          return Promise.reject(commandFailure(bindMessage, { code: 1 }));
        if (scenario === 'timeout')
          return Promise.reject(commandFailure(bindMessage, { killed: true }));
        if (scenario === 'signal')
          return Promise.reject(commandFailure(bindMessage, { signal: 'SIGTERM' }));
        if (scenario === 'generic-bind')
          return Promise.reject(commandFailure('permission denied: bind synthetic-private-socket'));
        if (scenario === 'volume-owner-mismatch') volumes.set(volume, 'another-owner');
        if (
          [
            'exhausted',
            'owner-mismatch',
            'volume-owner-mismatch',
            'cleanup-failure',
            'cancel-cleanup',
          ].includes(scenario) ||
          (recovery && allocations.length === 1)
        )
          return Promise.reject(commandFailure());
      } else {
        if (
          scenario === 'handoff-exhausted' ||
          (scenario === 'handoff-recovery' && allocations.length === 1)
        )
          return Promise.reject(commandFailure());
        if (scenario === 'handoff-unexpected')
          return Promise.reject(
            commandFailure(
              'Error response from daemon: synthetic-private-handoff permission denied',
            ),
          );
      }
      stdout = state.id;
    } else if (args[0] === 'port') {
      const state = stateFor(args[1]!);
      assert.equal(args[2], '5432/tcp');
      stdout = !state.running
        ? ''
        : state.phase === 'temporary' && publishedPorts[scenario] !== undefined
          ? publishedPorts[scenario]
          : `127.0.0.1:${state.port}`;
    } else if (args[0] === 'stop' || args[0] === 'start') {
      assert.equal(
        options?.signal,
        undefined,
        'mutating daemon requests settle without CLI cancellation',
      );
      const state = stateFor(args.at(-1)!);
      if (args[0] === 'stop') {
        if (restartActive && scenario === 'restart-stop-error')
          return Promise.reject(commandFailure('synthetic-private-stop-error'));
        assert(state.running, 'graceful stop targets a running owned instance');
        if (!manualStopping)
          assert.equal(args.at(-1), state.id, 'mutating stop targets the captured exact identity');
        state.running = false;
        if (manualStopping) observations.manualStops++;
        else if (restartActive) {
          observations.stops++;
          restartStopped = true;
        } else {
          assert.equal(state.phase, 'temporary');
          observations.temporaryStops++;
          if (scenario === 'dirty-exit') state.exitCode = 1;
          if (scenario === 'oom-exit') state.oom = true;
          if (scenario === 'cancel-temp-stop') controller.abort(cancellation);
        }
      } else {
        assert(restartActive, 'startup uses a new pinned permanent container');
        assert.equal(args.at(-1), state.id, 'restart targets the captured permanent identity');
        assert(!state.running);
        observations.starts++;
        if (scenario === 'restart-start-error')
          return Promise.reject(commandFailure('synthetic-private-start-error'));
        if (state.publish === '127.0.0.1::5432' || scenario === 'restart-binding-drift')
          state.port = '33213';
        if (scenario === 'restart-cancel-start') {
          return new Promise((resolve) => {
            queueMicrotask(() => {
              controller.abort(cancellation);
              cancellationEvents.push('aborted');
              queueMicrotask(() => {
                state.running = true;
                observations.restartedPort = state.port;
                cancellationEvents.push('daemon-started', 'start-settled');
                resolve({ stdout: state.id, stderr: '' });
              });
            });
          });
        }
        state.running = true;
        observations.restartedPort = state.port;
      }
      stdout = state.id;
    } else if (args[0] === 'ps') {
      const filter = argument(args, '--filter');
      if (filter.startsWith('volume=')) {
        const volume = filter.slice('volume='.length);
        stdout = [...containers.values()]
          .filter((state) => state.volume === volume)
          .map((state) => state.id)
          .join('\n');
        if (scenario === 'volume-in-use') {
          foreignConsumer = {
            ...foreign,
            name: 'unrelated-volume-consumer',
            id: 'd'.repeat(64),
            volume,
          };
          containers.set(foreignConsumer.name, { ...foreignConsumer });
          stdout = foreignConsumer.id;
        }
      } else {
        if (['cancel-run', 'cancel-final-run'].includes(scenario))
          cancellationEvents.push('cleanup-discovery');
        const name = filter.replace('name=^/', '').replace(/\$$/, '');
        stdout = containers.has(name) ? name : '';
      }
    } else if (args[0] === 'inspect') {
      const state = stateFor(args.at(-1)!);
      const format = argument(args, '--format');
      if (format.includes('.Config.Labels')) {
        stdout =
          scenario === 'owner-mismatch' ||
          (restartActive && restartStopped && scenario === 'restart-owner-drift')
            ? 'another-owner'
            : state.nonce;
        if (stdout === state.nonce) verifiedContainers.add(state.id);
      } else if (format === '{{.Id}}') {
        stdout =
          (scenario === 'temp-id-drift' && !state.running) ||
          (restartActive && restartStopped && scenario === 'restart-id-drift')
            ? 'e'.repeat(64)
            : state.id;
      } else if (format === '{{.State.Running}}') {
        stdout = String(state.running);
      } else if (format === '{{json .Mounts}}') {
        stdout =
          scenario === 'mount-malformed'
            ? '{synthetic-malformed'
            : JSON.stringify([
                {
                  Type: 'volume',
                  Name: scenario === 'mount-mismatch' ? foreign.volume : state.volume,
                  Destination: '/var/lib/postgresql/data',
                  RW: true,
                },
              ]);
      } else if (format === '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}') {
        stdout = `${state.running ? 'running' : 'exited'} ${state.exitCode} ${state.oom}`;
      } else if (format === '{{json .HostConfig.PortBindings}}') {
        stdout =
          scenario === 'fixed-binding-malformed'
            ? '{synthetic-malformed'
            : JSON.stringify({
                '5432/tcp': [
                  {
                    HostIp: scenario === 'fixed-binding-mismatch' ? '0.0.0.0' : '127.0.0.1',
                    HostPort:
                      state.publish === '127.0.0.1::5432' ? '' : state.publish.split(':')[1],
                  },
                ],
              });
      } else assert.fail(`Unexpected Docker inspect format: ${format}`);
    } else if (args[0] === 'rm') {
      if (scenario === 'cleanup-failure')
        return Promise.reject(commandFailure('synthetic-private-cleanup-failure'));
      const state = stateFor(args.at(-1)!);
      assert(
        verifiedContainers.has(state.id),
        'deletion follows verification of the exact container label',
      );
      if (!args.includes('--force')) {
        assert.equal(volumes.get(state.volume), state.nonce);
        assert.equal(
          args.at(-1),
          state.id,
          'handoff removes the exact verified temporary identity',
        );
        assert.equal(state.phase, 'temporary');
        assert.equal(state.running, false);
        assert.equal(state.exitCode, 0);
        assert.equal(state.oom, false);
        observations.temporaryRemoved++;
      }
      containers.delete(state.name);
      removedContainers.push(state.id);
      if (!args.includes('--force') && scenario === 'cancel-temp-rm')
        controller.abort(cancellation);
    } else if (args[0] === 'volume' && args[1] === 'ls') {
      const filter = argument(args, '--filter');
      if (filter.startsWith('name=^') && filter.endsWith('$')) {
        const name = filter.slice('name=^'.length, -1);
        stdout = volumes.has(name) ? name : '';
      } else {
        const nonce = filter.replace('label=tradeflow.owner=', '');
        stdout = [...volumes]
          .filter(([, label]) => label === nonce)
          .map(([name]) => name)
          .join('\n');
      }
    } else if (args[0] === 'volume' && args[1] === 'inspect') {
      volumeInspections++;
      const name = args.at(-1)!;
      assert.notEqual(
        name,
        foreign.volume,
        'foreign mounted volume is never targeted for inspection or removal',
      );
      stdout =
        scenario === 'volume-owner-mismatch' ||
        (restartActive && restartStopped && scenario === 'restart-volume-drift')
          ? 'another-owner'
          : (volumes.get(name) ?? '');
      if (stdout === volumes.get(name)) verifiedVolumes.add(name);
    } else if (args[0] === 'volume' && args[1] === 'rm') {
      const name = args.at(-1)!;
      assert.notEqual(name, foreign.volume);
      assert(verifiedVolumes.has(name), 'volume deletion follows verified ownership');
      if ([...containers.values()].some((state) => state.volume === name))
        return Promise.reject(commandFailure('synthetic-private-volume-still-in-use'));
      assert(volumes.delete(name), 'remove only a modelled owned volume');
      volumeData.delete(name);
      removedVolumes.push(name);
      if (scenario === 'cancel-cleanup') controller.abort(cancellation);
    } else assert.fail('Unexpected Docker operation in isolated port regression');
    return Promise.resolve({ stdout, stderr: '' });
  };
  const execute = (file: string, args: string[], options?: CommandOptions) => {
    mockCommandCalls++;
    try {
      return handleCommand(file, args, options);
    } catch (error) {
      // Production sanitizes command failures; fixture mistakes must remain visible.
      harnessFailures.push(error);
      return Promise.reject(
        error instanceof Error ? error : new Error('Isolated fixture command failed.'),
      );
    }
  };
  const fakeExecFile = Object.assign(
    () => {
      throw new Error('Expected promisified command operation');
    },
    { [promisify.custom]: execute },
  );
  // A mock.method Proxy retains execFile's original promisify.custom hook and can
  // bypass its replacement. Replace the export itself, including its hook.
  childProcess.execFile = fakeExecFile as unknown as typeof childProcess.execFile;
  assert.equal(promisify(childProcess.execFile), execute, 'the fake owns the promisified call');
  mock.method(childProcess, 'spawn', ((_file: string, args: string[]) => {
    assert.equal(scenario, 'native', 'no real child process is permitted');
    nativeSpawns.push(args);
    writeFileSync(join(owners[0]!.data!, 'postmaster.pid'), 'synthetic-pid\n', { mode: 0o600 });
    return Object.assign(new EventEmitter(), { unref: () => undefined });
  }) as unknown as typeof childProcess.spawn);
  mock.method(net, 'createServer', (() => {
    probes++;
    return Object.assign(new EventEmitter(), {
      listen: (_port: number, host: string, callback: () => void) => {
        assert.equal(host, '127.0.0.1');
        callback();
      },
      address: () => ({ address: '127.0.0.1', family: 'IPv4', port: 33107 }),
      close: (callback: () => void) => callback(),
    }) as unknown as net.Server;
  }) as typeof net.createServer);
  mock.method(console, 'warn', (...values: unknown[]) => {
    warnings.push(values.map(String).join(' '));
  });
  mock.method(console, 'log', (...values: unknown[]) => {
    output.push(values.map(String).join(' '));
  });
  mock.method(console, 'error', (...values: unknown[]) => {
    output.push(values.map(String).join(' '));
  });
  const originalClient = pg.Client;
  class FakeClient {
    readonly url: URL;
    connectedVolume: string | undefined;
    constructor(options: pg.ClientConfig) {
      assert(options.connectionString);
      connections.push(options.connectionString);
      this.url = new URL(options.connectionString);
    }
    connect(): Promise<void> {
      if (scenario === 'native') return Promise.resolve();
      assertProvisional();
      const state = ownedContainers().find(
        (candidate) => candidate.running && candidate.port === this.url.port,
      );
      if (!state || !volumeData.get(state.volume)!.databases.has(this.url.pathname.slice(1))) {
        observations.staleConnections++;
        // A stale endpoint exhausts the existing readiness deadline deterministically.
        // Production timeouts and the isolated worker execution bound stay intact.
        modelClock += 15001;
        return Promise.reject(new Error('Synthetic endpoint unavailable'));
      }
      this.connectedVolume = state.volume;
      if (!owned) {
        if (
          (state.phase === 'temporary' && scenario === 'cancel-temp-ready') ||
          (state.phase === 'permanent' && scenario === 'cancel-final-ready')
        )
          controller.abort(cancellation);
      }
      return Promise.resolve();
    }
    query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
      if (scenario !== 'native') {
        assert(this.connectedVolume, 'database operations follow a successful connection');
        const state = ownedContainers().find(
          (candidate) =>
            candidate.running &&
            candidate.port === this.url.port &&
            candidate.volume === this.connectedVolume,
        );
        assert(state, 'database operations reach the currently published endpoint');
        const data = volumeData.get(this.connectedVolume)!;
        if (sql === 'SELECT 1' && !owned) {
          if (state.phase === 'temporary') {
            observations.temporaryReady++;
            data.sentinel = 'synthetic-temporary-row';
          } else {
            observations.permanentReady++;
            if (this.url.pathname !== '/postgres') observations.namedReady++;
          }
        }
        if (sql.startsWith('CREATE DATABASE ')) {
          assert.equal(state.phase, 'permanent', 'database setup follows fixed-port handoff');
          data.databases.add(sql.slice('CREATE DATABASE '.length).replaceAll('"', ''));
        }
        if (sql.startsWith('COMMENT ON DATABASE ')) data.marker = state.nonce;
        if (sql === "INSERT INTO stable_endpoint_probe VALUES ('synthetic-retained-row')")
          data.sentinel = 'synthetic-retained-row';
        if (sql === 'SELECT value FROM stable_endpoint_probe')
          return Promise.resolve({ rows: [{ value: data.sentinel }] });
      }
      return Promise.resolve({
        rows: sql.includes('server_version') ? [{ version: '17.10' }] : [],
      });
    }
    end(): Promise<void> {
      return Promise.resolve();
    }
  }
  pg.Client = FakeClient as unknown as typeof pg.Client;
  mock.method(Date, 'now', () => modelClock);
  if (scenario === 'cancel-descriptor-publication') {
    fsPromises.rename = async (source, target) => {
      // Complete the real atomic write, including every private-state guard, before
      // delivering cancellation at this exact publication boundary.
      await originalRename(source, target);
      if (target === allocations.at(-1)) {
        const owner = JSON.parse(await readFile(target, 'utf8')) as OwnedDescriptor;
        if (new URL(owner.adminUrl).port !== '0') {
          observations.publicationHookObserved = true;
          controller.abort(cancellation);
        }
      }
    };
    assert.notEqual(
      fsPromises.rename,
      originalRename,
      'the publication hook owns the built-in export',
    );
  }
  syncBuiltinESMExports();
  let cleanupFailure: Error | undefined;
  process.chdir(temporary);
  // A broken mock cannot reach Docker through PATH. Native fake binaries also
  // have nonexistent absolute paths, so a bypass fails closed with ENOENT.
  process.env.PATH = emptyBin;
  try {
    const { startOwnedPostgres, restartOwnedPostgres } =
      await import('../../scripts/owned-postgres.js');
    let failure: unknown;
    try {
      owned = await startOwnedPostgres(
        scenario === 'native' ? join(temporary, 'native-bin') : undefined,
        {
          signal: controller.signal,
          onAllocated: async (path) => {
            cleanBeforeReplacement.push(
              allocations.every((previous) => !existsSync(dirname(previous))) &&
                ownedContainers().length === 0 &&
                ownedVolumes().length === 0,
            );
            allocations.push(path);
            const owner = JSON.parse(await readFile(path, 'utf8')) as OwnedDescriptor;
            owners.push(owner);
            assert.equal(
              new URL(owner.adminUrl).port,
              scenario === 'native' ? '33107' : '0',
              'allocation callback retains its provisional cleanup descriptor',
            );
            await replacePrivate(journalPath, {
              version: 1,
              scenario,
              allocations: [...allocations],
            });
          },
        },
      );
    } catch (error) {
      failure = error;
    }
    if (scenario === 'cancel-descriptor-publication')
      assert(
        observations.publicationHookObserved,
        'the hook observed the real final owner-file rename',
      );
    assert(mockCommandCalls > 0, 'the fake executor actually observed startup commands');
    if (scenario !== 'native' && scenario !== 'volume-create-failure')
      assert(runs.length > 0, 'the fake executor actually observed Docker run');
    assert.deepEqual(harnessFailures, [], 'all fixture commands obey the explicit model');
    const successful =
      recovery ||
      scenario === 'handoff-recovery' ||
      restartScenario ||
      ['native', 'minimum-port', 'maximum-port'].includes(scenario);
    if (successful) {
      assert.equal(failure, undefined, 'owned startup succeeds using only simulated dependencies');
      assert(owned);
      try {
        const expectedPort = scenario === 'native' ? '33107' : discoveredPort;
        const owner = JSON.parse(await readFile(owned.path, 'utf8')) as OwnedDescriptor;
        assert.equal(
          new URL(owner.adminUrl).port,
          expectedPort,
          'descriptor records the confirmed permanent endpoint',
        );
        assert(connections.length >= 2, 'readiness and setup use the simulated pg client');
        for (const value of connections) {
          assert.equal(new URL(value).hostname, '127.0.0.1');
          assert.equal(new URL(value).port, expectedPort);
        }
        if (scenario === 'native') {
          assert.equal(probes, 1);
          assert.equal(nativeSpawns.length, 1);
          assert.equal(argument(nativeSpawns[0]!, '-p'), '33107');
          assert(passwordFileChecked, 'initdb receives the private raw password file');
          assert(
            !existsSync(join(owner.directory, 'init-password')),
            'initialization password is removed',
          );
        } else {
          assert(observations.temporaryReady >= 1, 'temporary server was ready before handoff');
          assert(
            observations.permanentReady >= 2,
            'permanent postgres and named database are ready before publication',
          );
          assert.equal(
            observations.namedReady,
            1,
            'the created database is checked through its final endpoint',
          );
          assert.equal(ownedContainers().length, 1);
          const final = containers.get(owner.container!)!;
          assert.equal(final.phase, 'permanent');
          assert.equal(final.publish, `127.0.0.1:${expectedPort}:5432`);
          assert.equal(final.nonce, owner.nonce);
          assert.equal(final.volume, owner.volume);
          const temporaryRunIndex = runs.findIndex(
            (args) => argument(args, '--name') === owner.container,
          );
          assert.notEqual(
            final.id,
            (temporaryRunIndex + 1).toString(16).padStart(64, '0'),
            'permanent identity differs from temporary identity',
          );
          const sameAllocation = runs.filter(
            (args) => argument(args, '--name') === owner.container,
          );
          assert.equal(sameAllocation.length, 2);
          assert.equal(argument(sameAllocation[0]!, '--publish'), '127.0.0.1::5432');
          assert.equal(argument(sameAllocation[1]!, '--publish'), `127.0.0.1:${expectedPort}:5432`);
          assert.equal(volumeData.get(owner.volume!)!.marker, owner.nonce);
        }
        if (restartScenario) {
          const ownerPath = owned.path;
          const before = await readFile(ownerPath);
          const finalContainer = containers.get(owner.container!)!;
          const originalIdentity = { ...finalContainer };
          observations.originalPort = expectedPort;
          const writer = new pg.Client({ connectionString: owner.adminUrl });
          await writer.connect();
          await writer.query("INSERT INTO stable_endpoint_probe VALUES ('synthetic-retained-row')");
          await writer.end();
          // Construct before restart: this retained client cannot follow a rewritten descriptor.
          const retainedClient = new pg.Client({ connectionString: owner.adminUrl });
          if (scenario === 'restart-stopped-resume') {
            manualStopping = true;
            try {
              await owned.stop(false);
            } finally {
              manualStopping = false;
            }
            assert.equal(containers.get(owner.container!)!.running, false);
            assert(
              (await readFile(ownerPath)).equals(before),
              'restart preserves the private descriptor bytes',
            );
          }
          const removedBeforeRestart = removedContainers.length;
          const runsBeforeRestart = runs.length;
          const connectionsBeforeRestart = connections.length;
          if (scenario === 'restart-pre-aborted') controller.abort(cancellation);
          let restartFailure: unknown;
          restartActive = true;
          try {
            await restartOwnedPostgres(
              ownerPath,
              async () => {
                assert.equal(containers.get(owner.container!)!.running, false);
                assert(
                  (await readFile(ownerPath)).equals(before),
                  'restart preserves the private descriptor bytes',
                );
                if (['restart-cancel-stopped', 'restart-callback-and-cancel'].includes(scenario))
                  controller.abort(cancellation);
                if (['restart-callback', 'restart-callback-and-cancel'].includes(scenario))
                  throw callbackFailure;
              },
              controller.signal,
            );
          } catch (error) {
            restartFailure = error;
          } finally {
            restartActive = false;
          }
          observations.descriptorUnchanged = (await readFile(ownerPath)).equals(before);
          assert.deepEqual(harnessFailures, [], 'restart commands obey the explicit Docker model');
          assert(observations.descriptorUnchanged, 'restart never rewrites the owner descriptor');
          assert.equal(runs.length, runsBeforeRestart, 'restart never provisions a replacement');
          assert.equal(
            removedContainers.length,
            removedBeforeRestart,
            'restart never removes a container',
          );
          assert.equal(containers.get(owner.container!)!.id, originalIdentity.id);
          assert.equal(containers.get(owner.container!)!.nonce, originalIdentity.nonce);
          assert.equal(containers.get(owner.container!)!.volume, originalIdentity.volume);
          const restored = [
            'stable-restart',
            'restart-stopped-resume',
            'restart-callback',
            'restart-pre-aborted',
            'restart-cancel-stopped',
            'restart-cancel-start',
            'restart-callback-and-cancel',
          ].includes(scenario);
          if (['stable-restart', 'restart-stopped-resume'].includes(scenario))
            assert.equal(
              restartFailure,
              undefined,
              'owned restart reconnects through the original unchanged client endpoint',
            );
          else if (['restart-callback', 'restart-callback-and-cancel'].includes(scenario))
            assert.equal(
              restartFailure,
              callbackFailure,
              'restoration preserves the callback failure',
            );
          else if (
            ['restart-pre-aborted', 'restart-cancel-stopped', 'restart-cancel-start'].includes(
              scenario,
            )
          )
            assert.equal(
              restartFailure,
              cancellation,
              'restoration reports the original cancellation',
            );
          else {
            assert(restartFailure instanceof Error, 'unsafe or failed restart rejects');
            for (const privateValue of [
              'synthetic-private',
              'POSTGRES_PASSWORD',
              new URL(owner.adminUrl).password,
            ])
              assert(
                !String(restartFailure).includes(privateValue),
                'restart diagnostics omit private tool data',
              );
          }
          if (
            ['restart-pre-aborted', 'restart-stop-error', 'restart-stopped-resume'].includes(
              scenario,
            )
          ) {
            assert.equal(observations.stops, 0);
          } else {
            assert.equal(observations.stops, 1);
          }
          if (['restart-pre-aborted', 'restart-stop-error'].includes(scenario))
            assert.equal(observations.starts, 0);
          if (scenario === 'restart-stopped-resume') {
            assert.equal(observations.starts, 1);
            assert.equal(observations.manualStops, 1);
          }
          if (
            ['restart-id-drift', 'restart-owner-drift', 'restart-volume-drift'].includes(scenario)
          )
            assert.equal(observations.starts, 0, 'unknown stopped identity is never restarted');
          if (scenario === 'restart-binding-drift') {
            assert.equal(observations.starts, 1);
            assert.equal(
              connections.length,
              connectionsBeforeRestart,
              'unexpected binding is rejected before stale database readiness',
            );
          }
          if (restored) {
            try {
              await retainedClient.connect();
              const result = await retainedClient.query('SELECT value FROM stable_endpoint_probe');
              assert.deepEqual(result.rows, [{ value: 'synthetic-retained-row' }]);
              observations.sentinelRecovered = true;
            } finally {
              await retainedClient.end();
            }
            assert.equal(containers.get(owner.container!)!.port, expectedPort);
            assert.equal(observations.staleConnections, 0);
            assert.equal(containers.get(owner.container!)!.running, true);
          }
          assert.equal(
            volumeData.get(owner.volume!)!.sentinel,
            'synthetic-retained-row',
            'restart preserves volume data even when restoration fails',
          );
          if (scenario === 'restart-cancel-start')
            assert.deepEqual(cancellationEvents, ['aborted', 'daemon-started', 'start-settled']);
        }
      } finally {
        await owned.stop();
        await owned.stop();
      }
    } else {
      assert(failure instanceof Error, 'unsafe or unsuccessful allocation fails closed');
      assert.equal(owned, undefined);
      const reachesTemporaryReadiness =
        scenario === 'cancel-descriptor-publication' ||
        scenario.startsWith('handoff-') ||
        [
          'cancel-final-run',
          'cancel-temp-ready',
          'cancel-final-ready',
          'cancel-temp-stop',
          'cancel-temp-rm',
          'dirty-exit',
          'oom-exit',
          'temp-id-drift',
          'volume-in-use',
          'fixed-binding-mismatch',
          'fixed-binding-malformed',
        ].includes(scenario);
      if (!reachesTemporaryReadiness)
        assert.equal(connections.length, 0, 'failed discovery never reaches database readiness');
      else
        assert(
          connections.length > 0,
          'handoff failure follows actual temporary database readiness',
        );
      const publicDiagnostics = [
        String(failure),
        JSON.stringify(failure),
        ...warnings,
        ...output,
      ].join('\n');
      for (const secret of [
        'synthetic-private',
        'Ports are not available',
        'driver failed programming external connectivity',
        'POSTGRES_PASSWORD',
        ...owners.map((owner) => new URL(owner.adminUrl).password),
      ])
        assert(
          !publicDiagnostics.includes(secret),
          'public errors and diagnostics omit private tool data',
        );
    }
    if (scenario !== 'native') {
      assert.equal(probes, 0, 'Docker does not probe the unrelated WSL host namespace');
      for (const args of runs)
        assert.match(argument(args, '--publish'), /^127\.0\.0\.1:(?:|[1-9][0-9]{0,4}):5432$/);
      assert(
        observations.publicationPorts.every((value) => value === '0'),
        'no provisional endpoint becomes a client descriptor',
      );
    } else
      assert.equal(nativeStops.length, 1, 'repeated destroy stops native ownership exactly once');
    const publicLogs = [...warnings, ...output].join('\n');
    for (const secret of [
      'synthetic-private',
      'Ports are not available',
      'driver failed programming external connectivity',
      'POSTGRES_PASSWORD',
      ...owners.map((owner) => new URL(owner.adminUrl).password),
    ])
      assert(!publicLogs.includes(secret), 'all public logs omit private tool data');
    const expectedAttempts = ['exhausted', 'handoff-exhausted'].includes(scenario)
      ? 3
      : recovery || scenario === 'handoff-recovery'
        ? 2
        : 1;
    assert.equal(allocations.length, expectedAttempts, 'whole allocation attempts are bounded');
    let expectedRuns = 2;
    if (scenario === 'native' || scenario === 'volume-create-failure') expectedRuns = 0;
    else if (scenario === 'exhausted') expectedRuns = 3;
    else if (recovery) expectedRuns = 3;
    else if (scenario === 'handoff-recovery') expectedRuns = 4;
    else if (scenario === 'handoff-exhausted') expectedRuns = 6;
    else if (
      !successful &&
      ![
        'cancel-descriptor-publication',
        'handoff-unexpected',
        'cancel-final-run',
        'cancel-final-ready',
        'fixed-binding-mismatch',
        'fixed-binding-malformed',
      ].includes(scenario)
    )
      expectedRuns = 1;
    assert.equal(
      runs.length,
      expectedRuns,
      'Docker RUN count is distinct from allocation attempts',
    );
    assert(
      cleanBeforeReplacement.every(Boolean),
      'old owned resources and private directory are gone before a fresh allocation',
    );
    assert.equal(
      new Set(allocations).size,
      expectedAttempts,
      'each allocation has a fresh UUID directory',
    );
    assert.equal(
      new Set(owners.map((owner) => owner.nonce)).size,
      expectedAttempts,
      'each allocation has a fresh ownership nonce',
    );
    assert.equal(
      warnings.length,
      expectedAttempts - 1,
      'only clean replacement allocations emit a sanitized warning',
    );
    if (['cancel-run', 'cancel-final-run'].includes(scenario)) {
      assert.equal(
        runReceivedSignal,
        false,
        'mutating Docker run settles before cancellation cleanup',
      );
      assert.deepEqual(
        cancellationEvents,
        ['aborted', 'daemon-created', 'run-settled', 'cleanup-discovery'],
        'cleanup discovers the resource after its late daemon allocation settles',
      );
    }
    if (['cancel-temp-ready', 'cancel-temp-stop', 'cancel-temp-rm'].includes(scenario))
      assert.equal(runs.length, 1, 'temporary-phase cancellation never starts a final container');
    if (['owner-mismatch', 'cleanup-failure'].includes(scenario)) {
      assert.equal(
        removedContainers.length,
        0,
        'unsafe or failed cleanup never reports container deletion',
      );
      assert.equal(removedVolumes.length, 0);
      assert(
        existsSync(dirname(allocations[0]!)),
        'unresolved private recovery descriptor remains',
      );
    } else if (scenario === 'volume-owner-mismatch' || scenario === 'volume-in-use') {
      assert.equal(removedContainers.length, 1);
      assert.equal(removedVolumes.length, 0, 'unverified volume is never deleted');
      assert(existsSync(dirname(allocations[0]!)));
    } else {
      assert.equal(ownedContainers().length, 0);
      assert.equal(ownedVolumes().length, 0);
      for (const path of allocations)
        assert(!existsSync(dirname(path)), 'destroy removes the private instance directory');
    }
    if (scenario === 'volume-create-failure') {
      assert.equal(
        volumeInspections,
        1,
        'uncertain creation still verifies the owned volume label',
      );
      assert.equal(removedVolumes.length, 1);
    }
    assert.deepEqual(
      containers.get(foreign.name),
      foreign,
      'unrelated container identity and state remain untouched',
    );
    assert.equal(
      volumes.get(foreign.volume),
      foreign.nonce,
      'unrelated volume ownership remains untouched',
    );
    assert.equal(
      volumeData.get(foreign.volume)!.sentinel,
      'unrelated-retained-row',
      'unrelated data remains untouched',
    );
    if (foreignConsumer)
      assert.deepEqual(
        containers.get(foreignConsumer.name),
        foreignConsumer,
        'unrelated volume consumer is never modified or removed',
      );
    assert.deepEqual(harnessFailures, [], 'cleanup also obeys the explicit fixture model');
  } finally {
    let stopFailure: unknown;
    try {
      // Retain mocks and private files until an unexpectedly successful start is stopped.
      await owned?.stop();
    } catch (error) {
      stopFailure = error;
    }
    const unresolved = allocations.some((path) => existsSync(dirname(path)));
    try {
      await replacePrivate(journalPath, {
        version: 1,
        scenario,
        allocations: allocations.map((path) => ({ path, retained: existsSync(dirname(path)) })),
        cleanupFailed: Boolean(stopFailure),
        observedCommands: mockCommandCalls,
        observedDockerRuns: runs.length,
        observedNativeSpawns: nativeSpawns.length,
        loopbackProbes: probes,
        observations,
        remainingOwnedContainers: ownedContainers().map((state) => ({
          id: state.id,
          running: state.running,
          port: state.port,
        })),
        remainingOwnedVolumes: ownedVolumes().length,
        foreignUntouched:
          JSON.stringify(containers.get(foreign.name)) === JSON.stringify(foreign) &&
          volumes.get(foreign.volume) === foreign.nonce &&
          volumeData.get(foreign.volume)?.sentinel === 'unrelated-retained-row',
      });
    } finally {
      process.chdir(originalCwd);
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      pg.Client = originalClient;
      mock.restoreAll();
      childProcess.execFile = originalExecFile;
      fsPromises.rename = originalRename;
      syncBuiltinESMExports();
      // Preserve unresolved descriptors for human inspection and guarded recovery.
      if (!unresolved && !stopFailure) await rm(temporary, { recursive: true, force: true });
    }
    if (stopFailure)
      cleanupFailure = new Error(
        'Isolated unit cleanup failed; private recovery journal retained.',
      );
  }
  if (cleanupFailure) throw cleanupFailure;
}

if (worker) {
  const scenario = process.argv[3];
  assert(
    scenarios.some(([name]) => name === scenario),
    'known isolated worker scenario',
  );
  await scenarioWorker(scenario as Scenario);
} else if (process.platform === 'win32') {
  await test('owned PostgreSQL tooling explicitly requires POSIX', async () => {
    const { startOwnedPostgres } = await import('../../scripts/owned-postgres.js');
    await assert.rejects(startOwnedPostgres(), /requires POSIX; use Linux or WSL/);
  });
} else {
  for (const [scenario, description] of scenarios) {
    await test(description, () => {
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', fileURLToPath(import.meta.url), '--owned-port-worker', scenario],
        { encoding: 'utf8', timeout: 10_000 },
      );
      assert.equal(
        child.error,
        undefined,
        'isolated unit worker finishes within its execution bound',
      );
      assert.equal(child.status, 0, child.stderr || child.stdout);
    });
  }
}
