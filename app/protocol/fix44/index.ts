import {
  HEADER,
  PROFILES,
  fail,
  validateProfile,
  type FixFields,
  type Direction,
  type MessageType,
} from './profile.js';
export { Fix44Error } from './profile.js';
export type { FixFields, ErrorCode } from './profile.js';
export const FIX44_LIMITS = Object.freeze({
  maxFrame: 8192,
  maxFields: 64,
  maxBuffer: 16384,
  maxBatch: 16,
  maxValue: 256,
});
export interface Fix44Message {
  readonly type: MessageType;
  readonly direction: Direction;
  readonly fields: FixFields;
}
const trusted = new WeakMap<Fix44Message, string>();
function ascii(bytes: Uint8Array): void {
  for (const byte of bytes) if (byte !== 1 && (byte < 32 || byte > 126)) fail('NON_ASCII');
}
/** Returns undefined only for a potentially valid incomplete prefix. No resynchronization. */
function frameLength(bytes: Buffer): number | undefined {
  if (!bytes.length) return undefined;
  ascii(bytes);
  const prefix = Buffer.from('8=FIX.4.4\x019=', 'ascii');
  const first = bytes.indexOf(1);
  if (first < 0) {
    if (
      bytes.includes(124) ||
      bytes.length > 32 ||
      !Buffer.from('8=FIX.4.4').subarray(0, bytes.length).equals(bytes)
    )
      fail('FRAMING');
    return undefined;
  }
  if (bytes.subarray(0, first).toString('ascii') !== '8=FIX.4.4') {
    if (bytes.subarray(0, 2).toString('ascii') === '8=') fail('VERSION');
    fail('FRAMING');
  }
  if (bytes.length < prefix.length) {
    if (!prefix.subarray(0, bytes.length).equals(bytes)) fail('FIELD_ORDER');
    return undefined;
  }
  if (!bytes.subarray(0, prefix.length).equals(prefix)) fail('FIELD_ORDER');
  const second = bytes.indexOf(1, prefix.length);
  if (second < 0) {
    const partial = bytes.subarray(prefix.length).toString('ascii');
    if (partial && !/^[1-9][0-9]{0,4}$/.test(partial)) fail('BODY_LENGTH');
    if (partial && prefix.length + partial.length + 1 + Number(partial) + 7 > FIX44_LIMITS.maxFrame)
      fail('FRAME_LIMIT');
    return undefined;
  }
  const value = bytes.subarray(prefix.length, second).toString('ascii');
  if (!/^[1-9][0-9]{0,4}$/.test(value)) fail('BODY_LENGTH');
  const length = Number(value),
    end = second + 1 + length,
    total = end + 7;
  if (total > FIX44_LIMITS.maxFrame) fail('FRAME_LIMIT');
  if (bytes.length >= end && bytes[end - 1] !== 1) fail('BODY_LENGTH');
  const availableTrailer = bytes.subarray(end, Math.min(bytes.length, total));
  const marker = Buffer.from('10=', 'ascii');
  if (
    !availableTrailer
      .subarray(0, 3)
      .equals(marker.subarray(0, Math.min(3, availableTrailer.length)))
  )
    fail('BODY_LENGTH');
  const digits = availableTrailer.subarray(3, 6).toString('ascii');
  if (digits && !/^[0-9]{1,3}$/.test(digits)) fail('CHECKSUM');
  if (availableTrailer.length === 7 && availableTrailer[6] !== 1) fail('CHECKSUM');
  if (bytes.length < total) {
    if (
      bytes
        .toString('ascii')
        .split(String.fromCharCode(1))
        .slice(1, -1)
        .some((field) => /^10=[0-9]{3}$/.test(field))
    )
      fail('BODY_LENGTH');
    if (bytes.subarray(end, end + 3).toString('ascii') === '10=' && bytes.at(-1) === 1)
      fail('CHECKSUM');
    return undefined;
  }
  if (bytes[end - 1] !== 1 || bytes.subarray(end, end + 3).toString('ascii') !== '10=')
    fail('BODY_LENGTH');
  const checksum = bytes.subarray(end + 3, total - 1).toString('ascii');
  if (!/^[0-9]{3}$/.test(checksum) || bytes[total - 1] !== 1) fail('CHECKSUM');
  let sum = 0;
  for (let i = 0; i < end; i++) sum = (sum + bytes[i]!) % 256;
  if (checksum !== String(sum).padStart(3, '0')) fail('CHECKSUM');
  return total;
}
function lex(bytes: Buffer): Record<string, string> {
  const parts = bytes.toString('ascii').split('\x01');
  parts.pop();
  if (parts.length > FIX44_LIMITS.maxFields) fail('FIELD_LIMIT');
  const f: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const field of parts) {
    const match = /^([1-9][0-9]{0,4})=([\x20-\x7e]+)$/.exec(field);
    if (!match) fail('FRAMING');
    const tag = match[1]!,
      value = match[2]!;
    if (Object.hasOwn(f, tag)) fail('DUPLICATE_FIELD');
    if (value.length > FIX44_LIMITS.maxValue) fail('FIELD_LENGTH');
    f[tag] = value;
  }
  const order = parts.map((p) => p.slice(0, p.indexOf('=')));
  const header = HEADER.filter((t) => f[t] !== undefined);
  if (
    order[0] !== '8' ||
    order[1] !== '9' ||
    order[2] !== '35' ||
    order.at(-1) !== '10' ||
    header.some((tag, i) => order[i + 2] !== tag)
  )
    fail('FIELD_ORDER');
  return f;
}
export function decodeFix44(input: Uint8Array): Fix44Message {
  if (!(input instanceof Uint8Array)) fail('FRAMING');
  if (input.length > FIX44_LIMITS.maxFrame) fail('FRAME_LIMIT');
  const bytes = Buffer.from(input);
  const total = frameLength(bytes);
  if (total === undefined) fail('TRUNCATED');
  if (total !== bytes.length) fail('TRAILING_BYTES');
  const fields = lex(bytes);
  const business = Object.fromEntries(
    Object.entries(fields).filter(([tag]) => !['8', '9', '10'].includes(tag)),
  );
  const identity = validateProfile(business);
  const message = Object.freeze({ ...identity, fields: Object.freeze(fields) });
  trusted.set(message, bytes.toString('ascii'));
  return message;
}
export function encodeFix44(fields: FixFields): Buffer {
  const entries = Object.entries(fields);
  if (entries.length + 3 > FIX44_LIMITS.maxFields) fail('FIELD_LIMIT');
  for (const [tag, value] of entries) {
    if (['8', '9', '10'].includes(tag)) fail('RESERVED_FIELD');
    if (typeof value !== 'string' || !/^[\x20-\x7e]+$/.test(value)) fail('INVALID_VALUE');
    if (value.length > FIX44_LIMITS.maxValue) fail('FIELD_LENGTH');
  }
  const { type } = validateProfile(fields);
  const tags = [...HEADER, ...PROFILES[type].order];
  const body = Buffer.from(
    tags
      .filter((t) => fields[t] !== undefined)
      .map((t) => `${t}=${fields[t]}\x01`)
      .join(''),
    'ascii',
  );
  const prefix = Buffer.concat([Buffer.from(`8=FIX.4.4\x019=${body.length}\x01`, 'ascii'), body]);
  let sum = 0;
  for (const byte of prefix) sum = (sum + byte) % 256;
  const result = Buffer.concat([
    prefix,
    Buffer.from(`10=${String(sum).padStart(3, '0')}\x01`, 'ascii'),
  ]);
  if (result.length > FIX44_LIMITS.maxFrame) fail('FRAME_LIMIT');
  return result;
}
/** Presentation only, gated by decode provenance. Never accepted as FIX input. */
export function renderFix44(message: Fix44Message): string {
  const wire = trusted.get(message);
  if (wire === undefined) fail('UNTRUSTED_MESSAGE');
  return wire.replaceAll('\x01', '|');
}
export interface FeedResult {
  readonly messages: readonly Fix44Message[];
  readonly status: 'ready' | 'incomplete' | 'backpressure';
  readonly bufferedBytes: number;
}
export class Fix44Stream {
  private retained = Buffer.alloc(0);
  private failed = false;
  private blocked = false;
  private readonly maxBatch: number;
  constructor(options: { maxBatch?: number } = {}) {
    this.maxBatch = options.maxBatch ?? FIX44_LIMITS.maxBatch;
    if (
      !Number.isInteger(this.maxBatch) ||
      this.maxBatch < 1 ||
      this.maxBatch > FIX44_LIMITS.maxBatch
    )
      fail('INVALID_LIMIT');
  }
  get bufferedBytes(): number {
    return this.retained.length;
  }
  push(chunk: Uint8Array): FeedResult {
    if (this.failed) fail('PARSER_FAILED');
    if (this.blocked && chunk.length) fail('BACKPRESSURE');
    try {
      if (!(chunk instanceof Uint8Array)) fail('FRAMING');
      if (this.retained.length + chunk.length > FIX44_LIMITS.maxBuffer) fail('BUFFER_LIMIT');
      this.retained = Buffer.concat([this.retained, chunk]);
      this.blocked = false;
      const messages: Fix44Message[] = [];
      while (this.retained.length && messages.length < this.maxBatch) {
        const total = frameLength(this.retained);
        if (total === undefined) break;
        messages.push(decodeFix44(this.retained.subarray(0, total)));
        this.retained = Buffer.from(this.retained.subarray(total));
      }
      this.blocked = messages.length === this.maxBatch && this.retained.length > 0;
      return {
        messages: Object.freeze(messages),
        status: this.blocked ? 'backpressure' : this.retained.length ? 'incomplete' : 'ready',
        bufferedBytes: this.retained.length,
      };
    } catch (e) {
      this.failed = true;
      this.retained = Buffer.alloc(0);
      throw e;
    }
  }
  finish(): void {
    if (this.failed) fail('PARSER_FAILED');
    if (this.retained.length) {
      this.failed = true;
      this.retained = Buffer.alloc(0);
      fail('TRUNCATED');
    }
  }
}
