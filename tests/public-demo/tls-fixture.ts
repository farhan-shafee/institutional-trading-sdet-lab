import { createServer, connect, type Socket } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type pg from 'pg';

const execute = promisify(execFile);
const material = (async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tradeflow-private-test-pki-'));
  try {
    await execute('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(directory, 'ca.key'),
      '-out',
      join(directory, 'ca.pem'),
      '-days',
      '2',
      '-subj',
      '/CN=TradeFlow disposable test CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ]);
    await execute('openssl', [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(directory, 'server.key'),
      '-out',
      join(directory, 'server.csr'),
      '-subj',
      '/CN=public-postgres.railway.internal',
    ]);
    await writeFile(
      join(directory, 'extensions'),
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:public-postgres.railway.internal,IP:127.0.0.1\n',
      { mode: 0o600 },
    );
    await execute('openssl', [
      'x509',
      '-req',
      '-in',
      join(directory, 'server.csr'),
      '-CA',
      join(directory, 'ca.pem'),
      '-CAkey',
      join(directory, 'ca.key'),
      '-CAcreateserial',
      '-out',
      join(directory, 'server.pem'),
      '-days',
      '2',
      '-extfile',
      join(directory, 'extensions'),
    ]);
    return {
      ca: await readFile(join(directory, 'ca.pem'), 'utf8'),
      cert: await readFile(join(directory, 'server.pem'), 'utf8'),
      key: await readFile(join(directory, 'server.key'), 'utf8'),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();

/** Test-only TLS termination. The upstream is exclusively this invocation's owned loopback PG.
 * This proves client certificate/hostname enforcement and real SQL over TLS, not provider TLS.
 */
export async function postgresTlsProxy(upstreamUrl: string) {
  const upstream = new URL(upstreamUrl);
  if (
    upstream.hostname !== '127.0.0.1' ||
    !/^\/tradeflow_(local|ci)_[a-f0-9]{16}$/.test(upstream.pathname)
  )
    throw new Error('TLS fixture requires owned loopback PostgreSQL.');
  const certificates = await material;
  const secureContext = createSecureContext(certificates);
  const sockets = new Set<Socket>();
  const stats = { backendStarts: 0 };
  const retain = (socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  };
  const server = createServer((socket) => {
    retain(socket);
    let header = Buffer.alloc(0);
    const preface = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      if (header.length < 8) return;
      socket.off('data', preface);
      if (
        header.length !== 8 ||
        header.readInt32BE(0) !== 8 ||
        header.readInt32BE(4) !== 80877103
      ) {
        socket.destroy();
        return;
      }
      socket.write('S', () => {
        const tls = new TLSSocket(socket, { isServer: true, secureContext });
        retain(tls);
        tls.once('data', (startup: Buffer) => {
          tls.pause();
          stats.backendStarts++;
          const backend = connect(Number(upstream.port || 5432), '127.0.0.1');
          retain(backend);
          tls.once('close', () => backend.destroy());
          backend.once('close', () => tls.destroy());
          backend.once('connect', () => {
            backend.write(startup);
            tls.pipe(backend);
            backend.pipe(tls);
            tls.resume();
          });
        });
      });
    };
    socket.on('data', preface);
  });
  server.maxConnections = 16;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing TLS listener.');
  const port = address.port;
  function target(url: string): pg.PoolConfig {
    const parsed = new URL(url);
    if (parsed.host !== upstream.host || parsed.pathname !== upstream.pathname)
      throw new Error('TLS fixture target mismatch.');
    return {
      host: '127.0.0.1',
      port,
      user: parsed.username,
      password: decodeURIComponent(parsed.password),
      database: parsed.pathname.slice(1),
      ssl: {
        ca: certificates.ca,
        rejectUnauthorized: true,
        servername: 'public-postgres.railway.internal',
      },
    };
  }
  let closing: Promise<void> | undefined;
  return {
    target,
    stats,
    close() {
      return (closing ??= new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }));
    },
  };
}
