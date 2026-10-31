import { constants } from 'node:fs';
import { mkdir, open, realpath, lstat, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

async function syncAncestors(start: string): Promise<void> {
  let path = start;
  let device: number | undefined;
  for (;;) {
    const directory = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const info = await directory.stat();
      if (device !== undefined && info.dev !== device) return;
      device = info.dev;
      await directory.sync();
    } finally {
      await directory.close();
    }
    const next = dirname(path);
    if (next === path) return;
    path = next;
  }
}

async function parent(path: string): Promise<string> {
  if (process.platform === 'win32')
    throw new Error('The private ownership client requires a POSIX filesystem.');
  const target = resolve(path);
  const directory = dirname(target);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const inside = relative(root, target);
  if (!inside.startsWith(`..${sep}`) && inside !== '..' && !inside.startsWith(`.local${sep}`))
    throw new Error('Private state inside this checkout must be under ignored .local.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0 ||
    (await realpath(directory)) !== directory
  )
    throw new Error('Private state requires an owned, non-writable-by-others real directory.');
  return target;
}

export async function savePrivate(path: string, value: unknown): Promise<void> {
  const target = await parent(path);
  const file = await open(
    target,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  await syncAncestors(dirname(target));
}

export async function loadPrivate(path: string): Promise<unknown> {
  const target = await parent(path);
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.nlink !== 1 ||
      info.size > 32768
    )
      throw new Error('Private state has unsafe ownership, links, size or permissions.');
    const value = JSON.parse(await file.readFile('utf8')) as unknown;
    // A previous preparation may have written complete JSON without completing either sync.
    await file.sync();
    await syncAncestors(dirname(target));
    return value;
  } finally {
    await file.close();
  }
}

export async function replacePrivate(path: string, value: unknown): Promise<void> {
  await loadPrivate(path);
  const target = await parent(path);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await savePrivate(temporary, value);
    await rename(temporary, target);
    await syncAncestors(dirname(target));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
