import { randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  capabilitySchema,
  keySchema,
  sandboxBodySchema,
} from '../app/domain/workflow/contracts.js';
import { loadPrivate, savePrivate } from './private-state.js';

const material = {
  sandbox_id: z.uuid(),
  read_capability: capabilitySchema,
  trade_capability: capabilitySchema,
  idempotency_key: keySchema,
};
export const journalSchema = z.discriminatedUnion('operation', [
  z.object({ version: z.literal(1), operation: z.literal('create'), ...material }).strict(),
  z
    .object({
      version: z.literal(1),
      operation: z.literal('rotate'),
      ...material,
      expected_generation: z.string().regex(/^[1-9][0-9]{0,8}$/),
      previous_trade_capability: capabilitySchema,
    })
    .strict(),
]);
type Journal = z.infer<typeof journalSchema>;
type Response = { status: number; body: unknown; replayed: boolean };
const root = '/api/fixed-income/v1';

export function localOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Client requires a loopback HTTP origin.');
  return url.origin;
}

async function send(
  origin: string,
  path: string,
  method: string,
  body?: unknown,
  token?: string,
  key?: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const call = request(
      origin + path,
      {
        method,
        headers: {
          ...(bytes
            ? { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) }
            : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65536) response.destroy();
          else chunks.push(chunk);
        });
        response.once('end', () => {
          clearTimeout(deadline);
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
              replayed: response.headers['idempotency-replayed'] === 'true',
            });
          } catch {
            reject(new Error('Invalid local response.'));
          }
        });
        response.once('error', () => {
          clearTimeout(deadline);
          reject(new Error('Local response interrupted; retained operation is unresolved.'));
        });
      },
    );
    const deadline = setTimeout(() => call.destroy(), 3000);
    call.once('error', () => {
      clearTimeout(deadline);
      reject(new Error('Local request unavailable; retain and retry the original journal.'));
    });
    call.end(bytes);
  });
}

function nextMaterial() {
  return {
    sandbox_id: randomUUID(),
    read_capability: randomBytes(32).toString('base64url'),
    trade_capability: randomBytes(32).toString('base64url'),
    idempotency_key: randomUUID(),
  };
}
async function existing(path: string): Promise<Journal | undefined> {
  try {
    await lstat(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
  return journalSchema.parse(await loadPrivate(path));
}
async function recover(origin: string, token: string, journal: Journal): Promise<void> {
  const current = await send(
    origin,
    `${root}/sandboxes/recover`,
    'POST',
    { sandbox_id: journal.sandbox_id, capability: journal.trade_capability, scope: 'trade' },
    token,
  );
  if (current.status === 200) return;
  if (current.status === 404 && journal.operation === 'rotate') {
    const old = await send(
      origin,
      `${root}/sandboxes/recover`,
      'POST',
      {
        sandbox_id: journal.sandbox_id,
        capability: journal.previous_trade_capability,
        scope: 'trade',
      },
      token,
    );
    if (old.status === 200) return;
  }
  throw new Error('Ownership recovery failed; retain the latest ownership journal.');
}
async function apply(origin: string, token: string, journal: Journal): Promise<Response> {
  let result: Response;
  if (journal.operation === 'create')
    result = await send(
      origin,
      `${root}/sandboxes`,
      'POST',
      {
        sandbox_id: journal.sandbox_id,
        read_capability: journal.read_capability,
        trade_capability: journal.trade_capability,
      },
      token,
      journal.idempotency_key,
    );
  else {
    await recover(origin, token, journal);
    result = await send(
      origin,
      `${root}/sandboxes/${journal.sandbox_id}/recovery-keys/rotate`,
      'POST',
      {
        expected_generation: journal.expected_generation,
        read_capability: journal.read_capability,
        trade_capability: journal.trade_capability,
      },
      token,
      journal.idempotency_key,
    );
  }
  if (result.status !== (journal.operation === 'create' ? 201 : 200))
    throw new Error('Operation not confirmed; retain and retry the original journal.');
  sandboxBodySchema.parse(result.body);
  return result;
}

export async function runClient(
  operation: 'create' | 'rotate',
  journalPath: string,
  originValue: string,
  sourcePath?: string,
) {
  const origin = localOrigin(originValue);
  let journal = await existing(journalPath);
  if (journal && journal.operation !== operation)
    throw new Error('Journal belongs to a different operation.');
  if (!journal && operation === 'create') {
    journal = { version: 1, operation: 'create', ...nextMaterial() };
    await savePrivate(journalPath, journal); // fsync completes before the first network request.
  }
  const login = await send(origin, '/api/session', 'POST', {
    username: 'qa.user',
    password: 'Password123!',
  });
  const token = z.object({ token: z.string() }).parse(login.body).token;
  try {
    if (!journal) {
      if (!sourcePath) throw new Error('Rotation requires the latest retained ownership journal.');
      const source = journalSchema.parse(await loadPrivate(sourcePath));
      await apply(origin, token, source);
      await recover(origin, token, source);
      const state = await send(
        origin,
        `${root}/sandboxes/${source.sandbox_id}`,
        'GET',
        undefined,
        token,
      );
      if (state.status !== 200) throw new Error('Current sandbox state unavailable.');
      const generation = sandboxBodySchema.parse(state.body).sandbox.generation;
      journal = {
        version: 1,
        operation: 'rotate',
        ...nextMaterial(),
        sandbox_id: source.sandbox_id,
        expected_generation: generation,
        previous_trade_capability: source.trade_capability,
      };
      await savePrivate(journalPath, journal); // retains old and new ownership before rotation.
    }
    const result = await apply(origin, token, journal);
    return {
      sandbox_id: journal.sandbox_id,
      operation: journal.operation,
      confirmed: true,
      replayed: result.replayed,
    };
  } finally {
    await send(origin, '/api/session', 'DELETE', undefined, token).catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, ...args] = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    if (
      !key ||
      !value ||
      options.has(key) ||
      !['--journal', '--base-url', '--source'].includes(key)
    )
      throw new Error('Invalid client options.');
    options.set(key, value);
  }
  const path = options.get('--journal'),
    origin = options.get('--base-url');
  if (!path || !origin || (operation !== 'create' && operation !== 'rotate'))
    throw new Error('Use create|rotate --journal PATH --base-url LOOPBACK [--source PATH].');
  void runClient(operation, path, origin, options.get('--source'))
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(
        'Sandbox operation not confirmed. Retain the original private journal and retry unchanged. No credentials are printed.',
      );
      process.exitCode = 1;
    });
}
