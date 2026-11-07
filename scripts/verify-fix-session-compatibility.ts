import { createHash } from 'node:crypto';
import { decodeFix44, Fix44Error } from '../app/protocol/fix44/index.js';

/** Inspect captured bytes directly. This verifier never produces replacement wire. */
export function inspectRuntimeFrames(input: unknown) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 512)
    throw new Error('COMPATIBILITY_CASES');
  const observed = new Set<string>();
  const results = input.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('COMPATIBILITY_INPUT');
    const frame = value as Record<string, unknown>;
    if (
      typeof frame.raw_hex !== 'string' ||
      !/^(?:[0-9a-f]{2}){1,8192}$/.test(frame.raw_hex) ||
      typeof frame.sha256 !== 'string' ||
      !['J_TO_G', 'G_TO_J'].includes(String(frame.direction))
    )
      throw new Error('COMPATIBILITY_INPUT');
    const wire = Buffer.from(frame.raw_hex, 'hex');
    const hash = createHash('sha256').update(wire).digest('hex');
    if (hash !== frame.sha256) throw new Error('COMPATIBILITY_HASH');
    const type = wire
      .toString('ascii')
      .split(String.fromCharCode(1))
      .find((part) => part.startsWith('35='))
      ?.slice(3);
    if (!type || !['D', '8', 'F', '9'].includes(type)) throw new Error('COMPATIBILITY_TYPE');
    observed.add(type);
    let outcome = 'ACCEPTED';
    try {
      decodeFix44(wire);
    } catch (error) {
      if (!(error instanceof Fix44Error)) throw error;
      outcome = error.code;
    }
    return { direction: frame.direction, type, sha256: hash, original_codec_result: outcome };
  });
  if (observed.size !== 4) throw new Error('COMPATIBILITY_DISCOVERY');
  return { financial_application_verified: false, wire_normalized: false, results };
}

if (process.argv[1]?.endsWith('verify-fix-session-compatibility.ts')) {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 8 * 1024 * 1024) throw new Error('COMPATIBILITY_BOUND');
    chunks.push(buffer);
  }
  console.log(
    JSON.stringify(inspectRuntimeFrames(JSON.parse(Buffer.concat(chunks).toString('utf8')))),
  );
}
