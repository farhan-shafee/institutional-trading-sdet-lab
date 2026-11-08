import type { IncomingMessage } from 'node:http';
import { DomainError } from '../../domain/errors.js';
const limit = 16384;
function validateKeys(text: string): void {
  let index = 0;
  const space = () => {
    while (/\s/.test(text[index] ?? '') && index < text.length) index++;
  };
  const string = (): string => {
    const start = index++;
    while (index < text.length) {
      const char = text[index++];
      if (char === '\\') index++;
      else if (char === '"') return JSON.parse(text.slice(start, index)) as string;
    }
    throw new DomainError(400, 'INVALID_JSON', 'Invalid JSON string.');
  };
  const value = (depth: number): void => {
    if (depth > 16)
      throw new DomainError(400, 'VALIDATION_ERROR', 'Post-trade JSON is too deeply nested.');
    space();
    if (text[index] === '{') {
      index++;
      space();
      const keys = new Set<string>();
      if (text[index] === '}') {
        index++;
        return;
      }
      while (index < text.length) {
        space();
        const key = string();
        if (keys.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key))
          throw new DomainError(400, 'VALIDATION_ERROR', 'Duplicate or reserved JSON field.');
        keys.add(key);
        space();
        index++;
        value(depth + 1);
        space();
        if (text[index++] === '}') return;
      }
    } else if (text[index] === '[') {
      index++;
      space();
      if (text[index] === ']') {
        index++;
        return;
      }
      while (index < text.length) {
        value(depth + 1);
        space();
        if (text[index++] === ']') return;
      }
    } else if (text[index] === '"') string();
    else while (index < text.length && !/[\s,\]}]/.test(text[index]!)) index++;
  };
  value(0);
  space();
  if (index !== text.length) throw new DomainError(400, 'INVALID_JSON', 'Invalid JSON body.');
}
/** Same16KiB admission as the existing server; additional strictness is scoped to new writers. */
export function readPostTradeJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    request.resume();
    return Promise.reject(new DomainError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.'));
  }
  if (Number(request.headers['content-length']) > limit) {
    request.resume();
    return Promise.reject(
      new DomainError(413, 'PAYLOAD_TOO_LARGE', 'JSON bodies are limited to16KiB.'),
    );
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0,
      oversized = false;
    request.on('data', (chunk: Buffer) => {
      if (oversized) return;
      size += chunk.length;
      if (size > limit) {
        oversized = true;
        chunks.length = 0;
        reject(new DomainError(413, 'PAYLOAD_TOO_LARGE', 'JSON bodies are limited to16KiB.'));
      } else chunks.push(chunk);
    });
    request.once('end', () => {
      if (oversized) return;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const parsed: unknown = JSON.parse(text);
        validateKeys(text);
        resolve(parsed);
      } catch (error) {
        reject(
          error instanceof DomainError
            ? error
            : new DomainError(400, 'INVALID_JSON', 'The request body must be valid JSON.'),
        );
      }
    });
    request.once('error', reject);
    request.once('aborted', () =>
      reject(new DomainError(400, 'INVALID_JSON', 'The request was interrupted.')),
    );
  });
}
