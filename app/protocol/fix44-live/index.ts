/** Selected live wire profile. No socket, database, legacy trust or financial side effect. */
import { createHash } from 'node:crypto';
import {
  Fix44Error,
  validateProfile,
  validTime,
  type Direction,
  type ErrorCode,
  type FixFields,
  type MessageType,
} from '../fix44/profile.js';

export class LiveFix44Error extends Error {
  constructor(public readonly code: ErrorCode) {
    super(`LIVE_FIX44 ${code}`);
    this.name = 'LiveFix44Error';
  }
}
function fail(code: ErrorCode): never {
  throw new LiveFix44Error(code);
}
export interface LiveFixFrame {
  readonly profile: 'live-fix-ingress-v1';
  readonly type: MessageType;
  readonly direction: Direction;
  readonly fields: FixFields;
  readonly sha256: string;
}
const original = new WeakMap<LiveFixFrame, Buffer>();

/** Copy original evidence only for a frame produced by this decoder. */
export function liveFix44Bytes(frame: LiveFixFrame): Buffer {
  const bytes = original.get(frame);
  if (bytes === undefined) fail('UNTRUSTED_MESSAGE');
  return Buffer.from(bytes);
}

/** Independent live framing; the legacy decoder's byte order and trust remain intact. */
export function decodeLiveFix44(input: Uint8Array): LiveFixFrame {
  if (!(input instanceof Uint8Array)) fail('FRAMING');
  if (input.length > 8192) fail('FRAME_LIMIT');
  if (!input.length) fail('TRUNCATED');
  const raw = Buffer.from(input);
  for (const byte of raw) if (byte !== 1 && (byte < 32 || byte > 126)) fail('NON_ASCII');
  if (raw.at(-1) !== 1) fail('TRUNCATED');
  const parts = raw.toString('ascii').slice(0, -1).split('\x01');
  if (parts.length > 64) fail('FIELD_LIMIT');
  if (parts[0] !== '8=FIX.4.4') fail('VERSION');
  if (!/^9=[1-9][0-9]{0,4}$/.test(parts[1] ?? '')) fail('BODY_LENGTH');
  if (!/^10=[0-9]{3}$/.test(parts.at(-1) ?? '')) fail('FRAMING');
  const bodyStart = raw.indexOf(1, raw.indexOf(1) + 1) + 1;
  const trailerStart = raw.length - 7;
  if (trailerStart < bodyStart || trailerStart - bodyStart !== Number(parts[1]!.slice(2)))
    fail('BODY_LENGTH');
  let checksum = 0;
  for (let i = 0; i < trailerStart; i++) checksum = (checksum + raw[i]!) % 256;
  if (checksum !== Number(parts.at(-1)!.slice(3))) fail('CHECKSUM');

  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  const order: string[] = [];
  for (const part of parts) {
    const match = /^([1-9][0-9]{0,4})=([\x20-\x7e]+)$/.exec(part);
    if (!match) fail('FRAMING');
    const tag = match[1]!,
      value = match[2]!;
    if (value.length > 256) fail('FIELD_LENGTH');
    if (Object.hasOwn(fields, tag)) fail('DUPLICATE_FIELD');
    fields[tag] = value;
    order.push(tag);
  }
  if (fields['43'] !== undefined && fields['43'] !== 'Y') fail('INVALID_VALUE');
  if (fields['43'] === 'Y' && fields['122'] === undefined) fail('MISSING_FIELD');
  if (fields['43'] === undefined && fields['122'] !== undefined) fail('INVALID_VALUE');
  const headers =
    fields['43'] === 'Y'
      ? ['8', '9', '35', '34', '43', '49', '52', '56', '122']
      : ['8', '9', '35', '34', '49', '52', '56'];
  if (headers.some((tag, index) => order[index] !== tag) || order.at(-1) !== '10')
    fail('FIELD_ORDER');
  for (const tag of ['52', ...(fields['43'] === 'Y' ? ['122'] : [])]) {
    if (
      !/^[0-9]{8}-[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}$/.test(fields[tag] ?? '') ||
      !validTime(fields[tag]!)
    )
      fail('INVALID_VALUE');
  }
  if (fields['122'] !== undefined && fields['122'] > fields['52']!) fail('INVALID_VALUE');
  const outbound = fields['35'] === 'D' || fields['35'] === 'F';
  if (
    fields['49'] !== (outbound ? 'TRADEFLOW' : 'ATLAS') ||
    fields['56'] !== (outbound ? 'ATLAS' : 'TRADEFLOW')
  )
    fail('INVALID_VALUE');
  if (fields['35'] === 'D') {
    if (fields['21'] === undefined) fail('MISSING_FIELD');
    if (fields['21'] !== '1') fail('UNSUPPORTED_VALUE');
  } else if (fields['21'] !== undefined) fail('UNSUPPORTED_FIELD');

  // A parsed-field projection reuses reviewed business rules. It is never encoded
  // into replacement wire or inserted into the legacy trusted-message registry.
  const business = Object.fromEntries(
    Object.entries(fields).filter(
      ([tag]) => !['8', '9', '10'].includes(tag) && !(fields['35'] === 'D' && tag === '21'),
    ),
  );
  let identity: { type: MessageType; direction: Direction };
  try {
    identity = validateProfile(business);
  } catch (error: unknown) {
    if (error instanceof Fix44Error) fail(error.code);
    throw error;
  }
  const frame: LiveFixFrame = Object.freeze({
    profile: 'live-fix-ingress-v1',
    ...identity,
    fields: Object.freeze(fields),
    sha256: createHash('sha256').update(raw).digest('hex'),
  });
  original.set(frame, raw);
  return frame;
}
