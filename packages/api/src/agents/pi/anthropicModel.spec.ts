import { channel } from 'node:diagnostics_channel';
import { createServer, type Server } from 'node:http';
import { connect as connectTcp, type AddressInfo } from 'node:net';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { Duplex } from 'node:stream';
import type { PiModelBinding } from './session';
import {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_MESSAGES_API,
  PI_ANTHROPIC_PROVIDER_ID,
  PiAnthropicModelBindingError,
  createPiAnthropicModelBinding,
  type AuthorizedPiAnthropicModelCandidate,
} from './anthropicModel';

const API_KEY = 'server-anthropic-admin-secret-that-must-not-leak';
const MODEL_ID = 'claude-sonnet-4-5';

const catalogModel: Model<Api> = {
  id: MODEL_ID,
  name: 'Claude Sonnet 4.5 test fixture',
  api: ANTHROPIC_MESSAGES_API,
  provider: 'anthropic',
  baseUrl: ANTHROPIC_BASE_URL,
  input: ['text'],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  reasoning: false,
  contextWindow: 200_000,
  maxTokens: 4_096,
};

function candidate(
  overrides: Partial<AuthorizedPiAnthropicModelCandidate> = {},
): AuthorizedPiAnthropicModelCandidate {
  return {
    source: 'server-admin-config',
    provider: 'anthropic',
    api: ANTHROPIC_MESSAGES_API,
    baseUrl: ANTHROPIC_BASE_URL,
    modelId: MODEL_ID,
    serverAdminApiKey: API_KEY,
    requestUserId: 'user-42',
    transport: {
      bodyTimeout: 2_000,
      headersTimeout: 2_000,
      proxy: { kind: 'direct' },
    },
    generation: {
      maxTokens: 1_024,
      thinking: { kind: 'disabled' },
      cacheRetention: 'none',
      anthropicBetaHeader: 'fine-grained-tool-streaming-2025-05-14',
    },
    ...overrides,
  };
}

interface AnthropicServerHarness {
  server: Server;
  url: string;
  paths: string[];
  requestHeaders: Array<Record<string, string | string[] | undefined>>;
  requestBodies: string[];
}

async function startAnthropicServer(
  responseMode: 'success' | 'body-timeout' | 'redirect',
): Promise<AnthropicServerHarness> {
  const paths: string[] = [];
  const requestHeaders: Array<Record<string, string | string[] | undefined>> = [];
  const requestBodies: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? '');
    requestHeaders.push(request.headers);
    request.setEncoding('utf8');
    let requestBody = '';
    request.on('data', (chunk: string) => {
      requestBody += chunk;
    });
    request.on('end', () => requestBodies.push(requestBody));

    if (responseMode === 'redirect') {
      response.writeHead(302, { Location: 'https://redirect.example.test/v1/messages' });
      response.end();
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.flushHeaders();
    if (responseMode === 'body-timeout') {
      const timer = setTimeout(
        () => response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'),
        1_500,
      );
      response.on('close', () => clearTimeout(timer));
      return;
    }

    response.end(
      [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_local","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
        '',
        'event: content_block_start',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        '',
        'event: content_block_delta',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
        '',
        'event: content_block_stop',
        'data: {"type":"content_block_stop","index":0}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
        '',
      ].join('\n'),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}`, paths, requestHeaders, requestBodies };
}

interface ConnectProxyHarness {
  server: Server;
  url: string;
  connects: string[];
  sockets: Set<Duplex>;
}

async function startConnectProxy(): Promise<ConnectProxyHarness> {
  const connects: string[] = [];
  const sockets = new Set<Duplex>();
  const server = createServer();
  server.on('connect', (request, socket, head) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const authority = request.url ?? '';
    connects.push(authority);
    const separator = authority.lastIndexOf(':');
    const hostname = authority.slice(0, separator);
    const port = Number(authority.slice(separator + 1));
    if (!hostname || !Number.isSafeInteger(port) || port < 1) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    const upstream = connectTcp(port, hostname);
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.once('error', () => socket.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}`, connects, sockets };
}

async function runLocalRequest(options: {
  proxy?: boolean;
  bodyTimeout?: number;
  responseMode?: 'success' | 'body-timeout' | 'redirect';
}) {
  const origin = await startAnthropicServer(
    options.responseMode ?? (options.bodyTimeout === undefined ? 'success' : 'body-timeout'),
  );
  const proxy = options.proxy === undefined ? undefined : await startConnectProxy();
  const canonicalRequestUrls: string[] = [];
  const errors: string[] = [];
  let binding: PiModelBinding | undefined;
  const streamErrors = channel('undici:request:error');
  const recordTransportError = (event: unknown) => {
    const code = (event as { error?: { code?: unknown } }).error?.code;
    if (typeof code === 'string' && code.startsWith('UND_ERR_')) errors.push(code);
  };
  streamErrors.subscribe(recordTransportError);

  let responseText = '';
  let streamFailure: unknown;
  try {
    binding = await createPiAnthropicModelBinding(
      candidate({
        transport: {
          bodyTimeout: options.bodyTimeout ?? 2_000,
          headersTimeout: 2_000,
          proxy: proxy === undefined ? { kind: 'direct' } : { kind: 'proxy', url: proxy.url },
        },
      }),
      {
        resolveCatalogModel: () => catalogModel,
        rewriteRequestUrlForTest(url) {
          if (url.origin !== ANTHROPIC_BASE_URL || url.pathname !== '/v1/messages') {
            throw new Error(`Pi used an unexpected Anthropic destination: ${url.href}`);
          }
          canonicalRequestUrls.push(url.href);
          return new URL(`${url.pathname}${url.search}`, origin.url);
        },
      },
    );
    const providerConfig =
      binding.modelRuntime.getRegisteredProviderConfig(PI_ANTHROPIC_PROVIDER_ID);
    if (providerConfig?.streamSimple === undefined) {
      throw new Error('The real Pi runtime did not register the Anthropic adapter.');
    }
    const stream = binding.modelRuntime.stream(
      binding.model,
      { messages: [{ role: 'user', content: 'local binding check', timestamp: Date.now() }] },
      { maxRetries: 0 },
    );
    for await (const event of stream) {
      if (event.type === 'text_delta') responseText += event.delta;
      if (event.type === 'error') streamFailure = event.error;
    }
  } finally {
    streamErrors.unsubscribe(recordTransportError);
    await binding?.dispose();
    for (const socket of proxy?.sockets ?? []) socket.destroy();
    proxy?.server.closeAllConnections();
    origin.server.closeAllConnections();
    await Promise.all(
      [origin.server, ...(proxy === undefined ? [] : [proxy.server])].map(
        (serverToClose) => new Promise<void>((resolve) => serverToClose.close(() => resolve())),
      ),
    );
  }

  return {
    canonicalRequestUrls,
    errors,
    origin,
    proxy,
    responseText,
    streamFailure,
  };
}

describe('createPiAnthropicModelBinding', () => {
  it('uses only the canonical Anthropic Messages destination and keeps the admin key out of the body', async () => {
    const result = await runLocalRequest({});

    expect(result.streamFailure).toBeUndefined();
    expect(result.responseText).toBe('hello');
    expect(result.canonicalRequestUrls).toEqual([`${ANTHROPIC_BASE_URL}/v1/messages?beta=true`]);
    expect(result.origin.paths).toEqual(['/v1/messages?beta=true']);
    expect(result.origin.requestHeaders[0]?.['x-api-key']).toBe(API_KEY);
    expect(result.origin.requestHeaders[0]?.['anthropic-beta']).toContain(
      'fine-grained-tool-streaming-2025-05-14',
    );
    expect(result.origin.requestBodies).toHaveLength(1);
    expect(JSON.parse(result.origin.requestBodies[0] ?? '{}')).toMatchObject({
      model: MODEL_ID,
      max_tokens: 1_024,
      stream: true,
      metadata: { user_id: 'user-42' },
      messages: [{ role: 'user', content: 'local binding check' }],
    });
    expect(result.origin.requestBodies[0]).not.toContain(API_KEY);
  });

  it('routes the request through its captured proxy and applies its request-scoped body timeout', async () => {
    const result = await runLocalRequest({ proxy: true, bodyTimeout: 500 });

    expect(result.streamFailure).toBeDefined();
    expect(result.errors).toContain('UND_ERR_BODY_TIMEOUT');
    expect(result.proxy?.connects).toEqual([new URL(result.origin.url).host]);
    expect(result.origin.requestHeaders[0]?.['x-api-key']).toBe(API_KEY);
    expect(result.canonicalRequestUrls).toEqual([`${ANTHROPIC_BASE_URL}/v1/messages?beta=true`]);
  });

  it('isolates credentials between runtimes and removes each credential during cleanup', async () => {
    const [first, second] = await Promise.all([
      createPiAnthropicModelBinding(candidate(), { resolveCatalogModel: () => catalogModel }),
      createPiAnthropicModelBinding(candidate({ serverAdminApiKey: 'second-generation-secret' }), {
        resolveCatalogModel: () => catalogModel,
      }),
    ]);

    expect(first.modelRuntime).not.toBe(second.modelRuntime);
    await expect(first.modelRuntime.getAuth(PI_ANTHROPIC_PROVIDER_ID)).resolves.toMatchObject({
      auth: { apiKey: API_KEY },
    });
    await expect(second.modelRuntime.getAuth(PI_ANTHROPIC_PROVIDER_ID)).resolves.toMatchObject({
      auth: { apiKey: 'second-generation-secret' },
    });

    await first.dispose();
    await expect(first.modelRuntime.getAuth(PI_ANTHROPIC_PROVIDER_ID)).resolves.toBeUndefined();
    await expect(second.modelRuntime.getAuth(PI_ANTHROPIC_PROVIDER_ID)).resolves.toMatchObject({
      auth: { apiKey: 'second-generation-secret' },
    });

    await second.dispose();
    await expect(second.modelRuntime.getAuth(PI_ANTHROPIC_PROVIDER_ID)).resolves.toBeUndefined();
    await first.dispose();
    await second.dispose();
  });

  it('requires a supported effort when an adaptive catalog model needs one', async () => {
    const adaptiveCatalog: Model<Api> = {
      ...catalogModel,
      reasoning: true,
      compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true },
    };
    const generation = {
      ...candidate().generation,
      thinking: { kind: 'adaptive' as const, effort: 'high' as const },
    };
    const binding = await createPiAnthropicModelBinding(candidate({ generation }), {
      resolveCatalogModel: () => adaptiveCatalog,
    });
    await binding.dispose();

    await expect(
      createPiAnthropicModelBinding(
        candidate({ generation: { ...generation, thinking: { kind: 'adaptive' } } }),
        { resolveCatalogModel: () => adaptiveCatalog },
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL' });
  });

  it('rejects an unsupported effort value before creating a Pi runtime', async () => {
    const createRuntime = jest.fn();
    const invalidCandidate = {
      ...candidate(),
      generation: {
        ...candidate().generation,
        thinking: { kind: 'adaptive', effort: 'ultra' },
      },
    };

    await expect(
      createPiAnthropicModelBinding(invalidCandidate, { createRuntime }),
    ).rejects.toMatchObject({ code: 'INVALID_CANDIDATE' });
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('fails closed on redirects without following them outside the canonical Anthropic request', async () => {
    const result = await runLocalRequest({ responseMode: 'redirect' });

    expect(result.streamFailure).toBeDefined();
    expect(result.origin.paths).toEqual(['/v1/messages?beta=true']);
    expect(result.canonicalRequestUrls).toEqual([`${ANTHROPIC_BASE_URL}/v1/messages?beta=true`]);
  });

  it.each([
    ['custom provider id', { provider: 'anthropic-custom' }],
    ['custom api', { api: 'messages' }],
    ['custom destination', { baseUrl: 'https://gateway.example.test' }],
  ])('rejects %s before runtime initialization', async (_name, override) => {
    const createRuntime = jest.fn();
    await expect(
      createPiAnthropicModelBinding({ ...candidate(), ...override }, { createRuntime }),
    ).rejects.toBeInstanceOf(PiAnthropicModelBindingError);
    expect(createRuntime).not.toHaveBeenCalled();
  });
});
