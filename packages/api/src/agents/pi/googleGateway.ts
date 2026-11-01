import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { AddressInfo } from 'node:net';
import type { Dispatcher } from 'undici';
import type { Socket } from 'node:net';

export type PiGoogleProxy =
  | { readonly kind: 'direct' }
  | { readonly kind: 'proxy'; readonly url: string };

export interface PiGoogleTransport {
  readonly bodyTimeout: number;
  readonly headersTimeout: number;
  readonly proxy: PiGoogleProxy;
}

export interface PiGoogleGatewayOptions {
  readonly modelId: string;
  readonly serverAdminApiKey: string;
  readonly transport: PiGoogleTransport;
  /** Test seam: production always forwards to the fixed Google Generative Language origin. */
  readonly rewriteUpstreamUrlForTest?: (url: URL) => URL;
}

export interface PiGoogleGateway {
  readonly baseUrl: string;
  readonly apiKey: string;
  dispose(): Promise<void>;
}

const GOOGLE_API_ORIGIN = 'https://generativelanguage.googleapis.com';
export const PI_GOOGLE_MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;
const GOOGLE_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'user-agent',
  'x-goog-api-client',
  'content-type',
  'x-goog-api-key',
  'accept',
  'accept-language',
  'sec-fetch-mode',
  'accept-encoding',
  'content-length',
  'transfer-encoding',
]);
const GOOGLE_WIRE_BODY_KEYS = new Set([
  'contents',
  'generationConfig',
  'safetySettings',
  'systemInstruction',
  'tools',
  'toolConfig',
]);
const GOOGLE_GENERATION_CONFIG_KEYS = new Set([
  'maxOutputTokens',
  'temperature',
  'topP',
  'topK',
  'stopSequences',
  'thinkingConfig',
]);
const JSON_SCHEMA_KEYS = new Set([
  'type',
  'title',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'format',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
]);

class LocalRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'LocalRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function headerCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      count += 1;
    }
  }
  return count;
}

function validateRequestHeaders(
  request: IncomingMessage,
  expectedHost: string,
  apiKey: string,
): void {
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    if (
      name === undefined ||
      !GOOGLE_REQUEST_HEADERS.has(name) ||
      headerCount(request, name) !== 1
    ) {
      throw new LocalRequestError(400, 'invalid_headers');
    }
  }

  if (
    request.headers.host !== expectedHost ||
    request.headers['x-goog-api-key'] !== apiKey ||
    request.headers.authorization !== undefined ||
    request.headers['content-type']?.toLowerCase() !== 'application/json' ||
    request.headers.accept !== '*/*' ||
    (request.headers['accept-language'] !== undefined &&
      request.headers['accept-language'] !== '*') ||
    (request.headers['sec-fetch-mode'] !== undefined &&
      request.headers['sec-fetch-mode'] !== 'cors') ||
    (request.headers.connection !== undefined && request.headers.connection !== 'keep-alive') ||
    (request.headers['accept-encoding'] !== undefined &&
      !['gzip, deflate', 'gzip, deflate, br'].includes(request.headers['accept-encoding'])) ||
    (request.headers['user-agent'] !== undefined &&
      !request.headers['user-agent'].startsWith('pi/1.4.0 (')) ||
    (request.headers['x-goog-api-client'] !== undefined &&
      (typeof request.headers['x-goog-api-client'] !== 'string' ||
        !/^google-genai-sdk\/2\.21\.0 gl-node\/v\d+\.\d+\.\d+$/u.test(
          request.headers['x-goog-api-client'],
        )))
  ) {
    throw new LocalRequestError(401, 'invalid_local_request');
  }

  if (request.headers['content-length'] !== undefined) {
    const contentLength = Number(request.headers['content-length']);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new LocalRequestError(400, 'invalid_content_length');
    }
    if (contentLength > PI_GOOGLE_MAX_REQUEST_BODY_BYTES) {
      throw new LocalRequestError(413, 'request_too_large');
    }
  }
  if (
    request.headers['transfer-encoding'] !== undefined &&
    request.headers['transfer-encoding'] !== 'chunked'
  ) {
    throw new LocalRequestError(400, 'invalid_transfer_encoding');
  }
  if (
    request.headers['content-length'] !== undefined &&
    request.headers['transfer-encoding'] !== undefined
  ) {
    throw new LocalRequestError(400, 'ambiguous_request_length');
  }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > PI_GOOGLE_MAX_REQUEST_BODY_BYTES) {
      throw new LocalRequestError(413, 'request_too_large');
    }
    chunks.push(buffer);
  }
  if (request.headers['content-length'] !== undefined) {
    const contentLength = Number(request.headers['content-length']);
    if (size !== contentLength) {
      throw new LocalRequestError(400, 'incomplete_request_body');
    }
  }
  return Buffer.concat(chunks, size);
}

function validateGoogleWireBody(body: Buffer): void {
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    throw new LocalRequestError(400, 'invalid_json_body');
  }
  if (
    !isRecord(payload) ||
    !hasOnlyKeys(payload, GOOGLE_WIRE_BODY_KEYS) ||
    !Array.isArray(payload.contents) ||
    !isRecord(payload.generationConfig) ||
    !hasOnlyKeys(payload.generationConfig, GOOGLE_GENERATION_CONFIG_KEYS)
  ) {
    throw new LocalRequestError(400, 'invalid_google_request');
  }
  validateFunctionTools(payload.tools, payload.toolConfig);
  if (
    (payload.safetySettings !== undefined && !Array.isArray(payload.safetySettings)) ||
    (payload.systemInstruction !== undefined && !isRecord(payload.systemInstruction))
  ) {
    throw new LocalRequestError(400, 'invalid_google_request');
  }
}

function isSafeSchemaPropertyName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    !['__proto__', 'constructor', 'prototype'].includes(value)
  );
}

function validateJsonSchema(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): value is Record<string, unknown> {
  state.nodes += 1;
  if (
    !isRecord(value) ||
    depth > 32 ||
    state.nodes > 10_000 ||
    !hasOnlyKeys(value, JSON_SCHEMA_KEYS)
  ) {
    return false;
  }
  if (
    value.type !== undefined &&
    !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(
      String(value.type),
    )
  ) {
    return false;
  }
  if (
    (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 256)) ||
    (value.description !== undefined &&
      (typeof value.description !== 'string' || value.description.length > 4_096)) ||
    (value.format !== undefined &&
      (typeof value.format !== 'string' || value.format.length > 128)) ||
    (value.pattern !== undefined &&
      (typeof value.pattern !== 'string' || value.pattern.length > 2_048))
  ) {
    return false;
  }
  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) {
      return false;
    }
    const properties = Object.entries(value.properties);
    if (
      properties.length > 256 ||
      !properties.every(
        ([key, schema]) =>
          isSafeSchemaPropertyName(key) && validateJsonSchema(schema, state, depth + 1),
      )
    ) {
      return false;
    }
  }
  if (value.required !== undefined) {
    if (
      !Array.isArray(value.required) ||
      value.required.length > 256 ||
      !value.required.every(
        (entry) => typeof entry === 'string' && isSafeSchemaPropertyName(entry),
      ) ||
      new Set(value.required).size !== value.required.length
    ) {
      return false;
    }
  }
  if (
    value.additionalProperties !== undefined &&
    typeof value.additionalProperties !== 'boolean' &&
    !validateJsonSchema(value.additionalProperties, state, depth + 1)
  ) {
    return false;
  }
  if (value.items !== undefined && !validateJsonSchema(value.items, state, depth + 1)) {
    return false;
  }
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length > 256) {
      return false;
    }
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = value[keyword];
    if (variants !== undefined) {
      if (
        !Array.isArray(variants) ||
        variants.length === 0 ||
        variants.length > 64 ||
        !variants.every((variant) => validateJsonSchema(variant, state, depth + 1))
      ) {
        return false;
      }
    }
  }
  if (value.not !== undefined && !validateJsonSchema(value.not, state, depth + 1)) {
    return false;
  }
  for (const keyword of [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
  ] as const) {
    if (value[keyword] !== undefined && typeof value[keyword] !== 'number') {
      return false;
    }
  }
  for (const keyword of [
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
  ] as const) {
    if (
      value[keyword] !== undefined &&
      (!Number.isSafeInteger(value[keyword]) || Number(value[keyword]) < 0)
    ) {
      return false;
    }
  }
  if (value.uniqueItems !== undefined && typeof value.uniqueItems !== 'boolean') {
    return false;
  }
  return true;
}

function validateFunctionTools(tools: unknown, toolConfig: unknown): void {
  if (tools === undefined) {
    if (toolConfig !== undefined) {
      throw new LocalRequestError(400, 'invalid_tool_config');
    }
    return;
  }
  if (!Array.isArray(tools) || tools.length !== 1) {
    throw new LocalRequestError(400, 'unsupported_google_tools');
  }
  const toolGroup = tools[0];
  if (
    !isRecord(toolGroup) ||
    !hasOnlyKeys(toolGroup, new Set(['functionDeclarations'])) ||
    !Array.isArray(toolGroup.functionDeclarations) ||
    toolGroup.functionDeclarations.length === 0 ||
    toolGroup.functionDeclarations.length > 256
  ) {
    throw new LocalRequestError(400, 'unsupported_google_tools');
  }

  const names = new Set<string>();
  for (const declaration of toolGroup.functionDeclarations) {
    if (
      !isRecord(declaration) ||
      !hasOnlyKeys(declaration, new Set(['name', 'description', 'parametersJsonSchema'])) ||
      typeof declaration.name !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(declaration.name) ||
      names.has(declaration.name) ||
      typeof declaration.description !== 'string' ||
      declaration.description.length > 4_096 ||
      !validateJsonSchema(declaration.parametersJsonSchema, { nodes: 0 }) ||
      declaration.parametersJsonSchema.type !== 'object'
    ) {
      throw new LocalRequestError(400, 'unsupported_google_tools');
    }
    names.add(declaration.name);
  }

  if (toolConfig === undefined) {
    return;
  }
  if (
    !isRecord(toolConfig) ||
    !hasOnlyKeys(toolConfig, new Set(['functionCallingConfig'])) ||
    !isRecord(toolConfig.functionCallingConfig) ||
    !hasOnlyKeys(toolConfig.functionCallingConfig, new Set(['mode'])) ||
    !['AUTO', 'VALIDATED'].includes(String(toolConfig.functionCallingConfig.mode))
  ) {
    throw new LocalRequestError(400, 'invalid_tool_config');
  }
}

function writeError(response: ServerResponse, status: number, code: string): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    connection: 'close',
  });
  response.end(JSON.stringify({ error: { code } }));
}

function createDispatcher(transport: PiGoogleTransport): Dispatcher {
  const timeouts = {
    bodyTimeout: transport.bodyTimeout,
    headersTimeout: transport.headersTimeout,
  };
  return transport.proxy.kind === 'proxy'
    ? new ProxyAgent({ uri: transport.proxy.url, ...timeouts })
    : new Agent(timeouts);
}

function validateUpstreamContentType(contentType: string | null, success: boolean): boolean {
  if (contentType === null) {
    return false;
  }
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return success ? mediaType === 'text/event-stream' : mediaType === 'application/json';
}

/** Creates one loopback listener and one upstream dispatcher for a single Pi generation. */
export async function createPiGoogleGateway(
  options: PiGoogleGatewayOptions,
): Promise<PiGoogleGateway> {
  const apiKey = randomBytes(32).toString('base64url');
  const dispatcher = createDispatcher(options.transport);
  const activeRequests = new Set<AbortController>();
  const sockets = new Set<Socket>();
  let disposed = false;

  const expectedPath = `/v1beta/models/${options.modelId}:streamGenerateContent?alt=sse`;
  const server: Server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      writeError(response, 502, 'upstream_unavailable');
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    activeRequests.add(controller);
    let requestBodyRead = false;
    const abortUpstream = () => {
      if (!response.writableEnded) {
        controller.abort();
      }
    };
    request.once('aborted', abortUpstream);
    response.once('close', abortUpstream);

    try {
      if (disposed) {
        throw new LocalRequestError(503, 'gateway_disposed');
      }
      if (request.socket.remoteAddress !== '127.0.0.1') {
        throw new LocalRequestError(403, 'loopback_only');
      }
      if (request.method !== 'POST') {
        throw new LocalRequestError(405, 'method_not_allowed');
      }
      if (request.url !== expectedPath) {
        throw new LocalRequestError(404, 'route_not_found');
      }
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new LocalRequestError(503, 'gateway_unavailable');
      }
      const expectedHost = `127.0.0.1:${(address as AddressInfo).port}`;
      validateRequestHeaders(request, expectedHost, apiKey);
      const body = await readRequestBody(request);
      requestBodyRead = true;
      validateGoogleWireBody(body);
      if (controller.signal.aborted) {
        return;
      }

      const canonicalUrl = new URL(expectedPath, GOOGLE_API_ORIGIN);
      const upstreamUrl =
        options.rewriteUpstreamUrlForTest === undefined
          ? canonicalUrl
          : options.rewriteUpstreamUrlForTest(canonicalUrl);
      const upstreamResponse = await undiciFetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': options.serverAdminApiKey,
        },
        body,
        signal: controller.signal,
        redirect: 'error',
        dispatcher,
      });

      if (
        upstreamResponse.status !== 200 ||
        !validateUpstreamContentType(upstreamResponse.headers.get('content-type'), true)
      ) {
        await upstreamResponse.body?.cancel();
        writeError(response, 502, 'upstream_unavailable');
        return;
      }

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      if (upstreamResponse.body === null) {
        response.end();
        return;
      }

      const readable = Readable.fromWeb(
        upstreamResponse.body as unknown as NodeReadableStream<Uint8Array>,
      );
      await pipeline(readable, response);
    } catch (error) {
      if (
        controller.signal.aborted ||
        response.destroyed ||
        (!requestBodyRead && request.destroyed)
      ) {
        return;
      }
      if (error instanceof LocalRequestError) {
        if (!requestBodyRead) {
          request.resume();
        }
        writeError(response, error.status, error.code);
        return;
      }
      writeError(response, 502, 'upstream_unavailable');
    } finally {
      request.off('aborted', abortUpstream);
      response.off('close', abortUpstream);
      activeRequests.delete(controller);
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, '127.0.0.1');
    });
  } catch (error) {
    await dispatcher.close().catch(() => undefined);
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await dispatcher.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('The Pi Google loopback gateway did not bind to an IP address.');
  }

  let disposePromise: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1beta`,
    apiKey,
    async dispose() {
      disposePromise ??= (async () => {
        disposed = true;
        for (const controller of activeRequests) {
          controller.abort();
        }
        const closeServer = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        for (const socket of sockets) {
          socket.destroy();
        }
        await Promise.all([closeServer, dispatcher.close()]);
      })();
      await disposePromise;
    },
  };
}
