import type { APIRequestContext } from '@playwright/test';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
import { z } from 'zod';

const specificationSchema = z
  .object({
    openapi: z.string().startsWith('3.0.'),
    paths: z.record(z.string(), z.record(z.string(), z.unknown())),
    components: z.object({ schemas: z.record(z.string(), z.unknown()) }).passthrough(),
  })
  .passthrough();
const operationSchema = z
  .object({
    responses: z.record(z.string(), z.unknown()),
  })
  .passthrough();
const responseSchema = z
  .object({
    content: z
      .record(z.string(), z.object({ schema: z.record(z.string(), z.unknown()) }))
      .optional(),
  })
  .passthrough();

type Method = 'get' | 'post' | 'delete';

/** OpenAPI 3.0 uses draft-4 exclusive bounds and nullable; AJV uses draft-7. */
function jsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonSchema);
  if (value === null || typeof value !== 'object') return value;
  const schema: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, jsonSchema(entry)]),
  );
  for (const bound of ['Minimum', 'Maximum'] as const) {
    const exclusive = `exclusive${bound}`;
    const inclusive = bound.toLowerCase();
    if (schema[exclusive] === true && typeof schema[inclusive] === 'number') {
      schema[exclusive] = schema[inclusive];
      delete schema[inclusive];
    } else if (schema[exclusive] === false) {
      delete schema[exclusive];
    }
  }
  if (schema.nullable === true && typeof schema.type === 'string') {
    schema.type = [schema.type, 'null'];
  }
  delete schema.nullable;
  return schema;
}

/** Validates wire JSON against the live published specification, independently of app types. */
export class OpenApiContracts {
  private readonly ajv: Ajv;

  private constructor(private readonly document: z.infer<typeof specificationSchema>) {
    this.ajv = new Ajv({ allErrors: true, strict: false });
    addFormats.default(this.ajv);
  }

  static async load(request: APIRequestContext): Promise<OpenApiContracts> {
    const response = await request.get('/openapi.yaml');
    if (response.status() !== 200)
      throw new Error(`OpenAPI retrieval returned ${response.status()}`);
    return new OpenApiContracts(specificationSchema.parse(parse(await response.text())));
  }

  response(method: Method, path: string, status: number): ValidateFunction {
    const schema = this.responseObject(method, path, status).content?.['application/json']?.schema;
    if (!schema)
      throw new Error(`Missing response contract: ${method.toUpperCase()} ${path} ${status}`);
    // Compile in the component document so local #/components refs resolve correctly.
    const normalized = jsonSchema(schema) as Record<string, unknown>;
    return this.ajv.compile({ ...normalized, components: jsonSchema(this.document.components) });
  }

  noContentResponse(method: 'delete', path: string, status: number): boolean {
    return this.responseObject(method, path, status).content === undefined;
  }

  private responseObject(
    method: Method,
    path: string,
    status: number,
  ): z.infer<typeof responseSchema> {
    const operation = operationSchema.parse(this.document.paths[path]?.[method]);
    const response = operation.responses[String(status)];
    if (response === undefined) {
      throw new Error(`Missing response contract: ${method.toUpperCase()} ${path} ${status}`);
    }
    return responseSchema.parse(this.resolveResponseReference(response));
  }

  /** Resolve response-object references locally; schemas are resolved independently by AJV. */
  private resolveResponseReference(response: unknown): unknown {
    let current = response;
    const seen = new Set<string>();
    for (;;) {
      const object = z.record(z.string(), z.unknown()).parse(current);
      if (object.$ref === undefined) return current;
      const ref = z.string().parse(object.$ref);
      if (!ref.startsWith('#/'))
        throw new Error(`Only local OpenAPI references are supported: ${ref}`);
      if (seen.has(ref)) throw new Error(`Circular OpenAPI response reference: ${ref}`);
      seen.add(ref);
      current = this.document;
      const pointer = decodeURIComponent(ref.slice(2));
      for (const encodedToken of pointer.split('/')) {
        if (/~(?![01])/.test(encodedToken)) throw new Error(`Invalid OpenAPI JSON pointer: ${ref}`);
        const token = encodedToken.replace(/~1/g, '/').replace(/~0/g, '~');
        const container = z.record(z.string(), z.unknown()).parse(current);
        if (!Object.hasOwn(container, token))
          throw new Error(`Unresolved OpenAPI response reference: ${ref}`);
        current = container[token];
      }
    }
  }
}
