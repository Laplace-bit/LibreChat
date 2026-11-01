import { UsageEvents } from 'librechat-data-provider';
import { connect as connectTcp, type AddressInfo } from 'node:net';
import {
  Agent,
  createServer,
  request as requestHttp,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Duplex } from 'node:stream';
import {
  createPiGoogleModelBinding,
  GOOGLE_GENERATIVE_AI_API,
  GOOGLE_GENERATIVE_BASE_URL,
  PI_GOOGLE_PROVIDER_ID,
  type AuthorizedPiGoogleModelCandidate,
} from './googleModel';
import { createPiContentEventTranslator, type PiMessageStepIdentity } from './events';
import { PI_GOOGLE_MAX_REQUEST_BODY_BYTES } from './googleGateway';

const MODEL_ID = 'gemini-2.5-flash';
const FIRST_KEY = 'AIza-server-admin-first-key';
const SECOND_KEY = 'AIza-server-admin-second-key';
const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
];
const GOOGLE_UPSTREAM = 'https://generativelanguage.googleapis.com';

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

interface UpstreamHarness {
  readonly server: Server;
  readonly url: string;
  readonly requests: CapturedRequest[];
}

interface ProxyHarness {
  readonly server: Server;
  readonly url: string;
  readonly connects: string[];
  readonly sockets: Set<Duplex>;
}

function createCandidate(
  apiKey = FIRST_KEY,
  overrides: Partial<AuthorizedPiGoogleModelCandidate> = {},
): AuthorizedPiGoogleModelCandidate {
  return {
    source: 'server-admin-config',
    provider: 'google',
    api: GOOGLE_GENERATIVE_AI_API,
    baseUrl: GOOGLE_GENERATIVE_BASE_URL,
    modelId: MODEL_ID,
    serverAdminApiKey: apiKey,
    transport: {
      bodyTimeout: 2_000,
      headersTimeout: 2_000,
      proxy: { kind: 'direct' },
    },
    generation: {
      maxOutputTokens: 512,
      temperature: 0.25,
      topP: 0.8,
      topK: 40,
      stopSequences: ['DONE'],
      safetySettings: SAFETY_SETTINGS,
      thinkingConfig: { includeThoughts: true, thinkingBudget: 128 },
    },
    ...overrides,
  };
}

function googleResponse(text: string): string {
  return `data: ${JSON.stringify({
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text: 'reason', thought: true }, { text }],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      cachedContentTokenCount: 3,
      candidatesTokenCount: 2,
      thoughtsTokenCount: 1,
      totalTokenCount: 13,
    },
  })}\n\n`;
}

async function startUpstream(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
  captureBodies = true,
): Promise<UpstreamHarness> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      if (captureBodies) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    });
    request.on('end', () => {
      const body = captureBodies ? Buffer.concat(chunks).toString('utf8') : '';
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body,
      });
      handler(request, response, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}`, requests };
}

async function startConnectProxy(allowedTarget: string): Promise<ProxyHarness> {
  const connects: string[] = [];
  const sockets = new Set<Duplex>();
  const server = createServer();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (request, socket, head) => {
    sockets.add(socket);
    const authority = request.url ?? '';
    connects.push(authority);
    if (authority !== allowedTarget) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const separator = authority.lastIndexOf(':');
    const hostname = authority.slice(0, separator);
    const port = Number(authority.slice(separator + 1));
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
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}`, connects, sockets };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function createBinding(
  upstream: UpstreamHarness,
  candidate = createCandidate(),
  options: { proxyUrl?: string; rewriteUrls?: string[] } = {},
) {
  return createPiGoogleModelBinding(candidate, {
    rewriteUpstreamUrlForTest(url) {
      if (
        url.origin !== GOOGLE_UPSTREAM ||
        url.pathname !== `/v1beta/models/${MODEL_ID}:streamGenerateContent` ||
        url.search !== '?alt=sse'
      ) {
        throw new Error(`Unexpected Google destination: ${url.href}`);
      }
      options.rewriteUrls?.push(url.href);
      return new URL(`${url.pathname}${url.search}`, upstream.url);
    },
  });
}

async function getGatewayApiKey(runtime: ModelRuntime): Promise<string> {
  const auth = await runtime.getAuth(PI_GOOGLE_PROVIDER_ID);
  const key = auth?.auth.apiKey;
  if (typeof key !== 'string') {
    throw new Error('Pi Google runtime did not retain its loopback credential.');
  }
  return key;
}

function createHostUsageTranslator() {
  const identity: PiMessageStepIdentity = {
    id: 'step-1',
    index: 0,
    messageId: 'message-1',
    runId: 'run-1',
    agentId: 'agent-1',
  };
  return createPiContentEventTranslator({
    createStepIdentity: () => identity,
    usageAttribution: { provider: 'google', agentId: 'agent-1', runId: 'run-1' },
  });
}

function localGatewayHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-goog-api-key': apiKey,
    'x-goog-api-client': 'google-genai-sdk/2.21.0 gl-node/v22.22.1',
    'user-agent': 'pi/1.4.0 (darwin; node/v22.22.1; arm64)',
    accept: '*/*',
  };
}

function localRequestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contents: [{ role: 'user', parts: [{ text: 'gateway boundary test' }] }],
    generationConfig: { maxOutputTokens: 512 },
    ...overrides,
  };
}

interface LocalGatewayResponse {
  readonly status: number;
  text(): Promise<string>;
}

async function postLocalGateway(
  binding: Awaited<ReturnType<typeof createPiGoogleModelBinding>>,
  path = `/v1beta/models/${MODEL_ID}:streamGenerateContent?alt=sse`,
  overrides: {
    apiKey?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
    bodyText?: string;
  } = {},
): Promise<LocalGatewayResponse> {
  const apiKey = overrides.apiKey ?? (await getGatewayApiKey(binding.modelRuntime));
  const baseUrl = new URL(binding.model.baseUrl ?? '');
  const method = overrides.method ?? 'POST';
  const body =
    method === 'GET'
      ? undefined
      : (overrides.bodyText ?? JSON.stringify(overrides.body ?? localRequestBody()));
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  let responseBody: { status: number; body: string };
  let responseDeadline: ReturnType<typeof setTimeout> | undefined;
  try {
    responseBody = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = requestHttp(
        {
          hostname: '127.0.0.1',
          port: Number(baseUrl.port),
          path,
          method,
          agent,
          headers: {
            ...localGatewayHeaders(apiKey),
            ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
            ...overrides.headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.once('error', (error) => {
            if (responseDeadline !== undefined) clearTimeout(responseDeadline);
            reject(error);
          });
          response.once('end', () => {
            if (responseDeadline !== undefined) clearTimeout(responseDeadline);
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      responseDeadline = setTimeout(() => {
        request.destroy();
        reject(new Error(`Local gateway response timed out: ${method} ${path}`));
      }, 10_000);
      request.once('error', () => {
        // A rejecting gateway may close its side while the client is still uploading the body.
        // Keep waiting for the HTTP rejection response, bounded by responseDeadline.
      });
      request.end(body);
    });
  } finally {
    if (responseDeadline !== undefined) clearTimeout(responseDeadline);
    agent.destroy();
  }
  return { status: responseBody.status, text: async () => responseBody.body };
}

async function expectLocalGatewayClosed(baseUrl: string): Promise<void> {
  await expect(fetch(baseUrl)).rejects.toThrow();
}

async function expectBeforeTimeout(promise: Promise<unknown>, message: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 3_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe('createPiGoogleModelBinding', () => {
  jest.setTimeout(60_000);

  it.each([
    [
      'unknown safety category',
      SAFETY_SETTINGS.map((setting, index) =>
        index === 0 ? { ...setting, category: 'HARM_CATEGORY_OTHER' } : setting,
      ),
    ],
    [
      'duplicate safety category',
      SAFETY_SETTINGS.map((setting, index) =>
        index === 4 ? { ...setting, category: SAFETY_SETTINGS[0]?.category ?? '' } : setting,
      ),
    ],
    [
      'unknown safety threshold',
      SAFETY_SETTINGS.map((setting, index) =>
        index === 0 ? { ...setting, threshold: 'ALLOW_EVERYTHING' } : setting,
      ),
    ],
  ])('rejects a candidate with %s before creating runtime resources', async (_name, settings) => {
    const base = createCandidate();
    const candidate = {
      ...base,
      generation: { ...base.generation, safetySettings: settings },
    };
    const createRuntime = jest.fn();

    await expect(createPiGoogleModelBinding(candidate, { createRuntime })).rejects.toMatchObject({
      code: 'INVALID_CANDIDATE',
    });
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('streams through a private loopback endpoint, maps the configured body and restores cached usage', async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(googleResponse('gateway-ok'));
    });
    const canonicalUrls: string[] = [];
    let binding: Awaited<ReturnType<typeof createPiGoogleModelBinding>> | undefined;
    try {
      binding = await createBinding(upstream, createCandidate(), { rewriteUrls: canonicalUrls });
      const model = binding.model;
      const message = await binding.modelRuntime.completeSimple(model, {
        messages: [{ role: 'user', content: 'local Pi transport test', timestamp: Date.now() }],
      });

      expect(message.content).toContainEqual({ type: 'text', text: 'gateway-ok' });
      expect(message.usage).toMatchObject({
        input: 7,
        output: 3,
        cacheRead: 3,
        reasoning: 1,
        totalTokens: 13,
      });
      expect(canonicalUrls).toEqual([
        `${GOOGLE_UPSTREAM}/v1beta/models/${MODEL_ID}:streamGenerateContent?alt=sse`,
      ]);
      expect(upstream.requests).toHaveLength(1);
      const [request] = upstream.requests;
      expect(request?.method).toBe('POST');
      expect(request?.path).toBe(`/v1beta/models/${MODEL_ID}:streamGenerateContent?alt=sse`);
      expect(request?.headers['x-goog-api-key']).toBe(FIRST_KEY);
      expect(request?.headers.authorization).toBeUndefined();
      expect(request?.body).not.toContain(FIRST_KEY);
      expect(request?.body).not.toContain(await getGatewayApiKey(binding.modelRuntime));
      expect(JSON.parse(request?.body ?? '{}')).toMatchObject({
        generationConfig: {
          maxOutputTokens: 512,
          temperature: 0.25,
          topP: 0.8,
          topK: 40,
          stopSequences: ['DONE'],
          thinkingConfig: { includeThoughts: true, thinkingBudget: 128 },
        },
        safetySettings: SAFETY_SETTINGS,
      });

      const usageEvents = createHostUsageTranslator()({
        type: 'agent_end',
        messages: [message],
        willRetry: false,
      });
      expect(usageEvents).toContainEqual({
        event: UsageEvents.ON_TOKEN_USAGE,
        data: expect.objectContaining({
          input_tokens: 10,
          output_tokens: 3,
          total_tokens: 13,
          input_token_details: { cache_read: 3 },
        }),
      });
    } finally {
      const baseUrl = binding?.model.baseUrl;
      await binding?.dispose();
      if (baseUrl !== undefined) {
        await expectLocalGatewayClosed(baseUrl);
      }
      await closeServer(upstream.server);
    }
  });

  it('keeps overlapping generations isolated when one response is aborted', async () => {
    const pending: Array<{ response: ServerResponse; request: CapturedRequest }> = [];
    let resolveBothReceived: (() => void) | undefined;
    let resolveFirstClosed: (() => void) | undefined;
    const bothReceived = new Promise<void>((resolve) => {
      resolveBothReceived = resolve;
    });
    const firstClosed = new Promise<void>((resolve) => {
      resolveFirstClosed = resolve;
    });
    const upstream = await startUpstream((_request, response) => {
      const request = upstream.requests[upstream.requests.length - 1];
      if (request === undefined) {
        response.writeHead(500).end();
        return;
      }
      pending.push({ response, request });
      if (pending.length !== 2) {
        return;
      }
      const firstRequest = pending.find(
        (item) => item.request.headers['x-goog-api-key'] === FIRST_KEY,
      );
      const secondRequest = pending.find(
        (item) => item.request.headers['x-goog-api-key'] === SECOND_KEY,
      );
      if (firstRequest === undefined || secondRequest === undefined) {
        for (const item of pending) item.response.writeHead(500).end();
        resolveBothReceived?.();
        return;
      }
      firstRequest.response.writeHead(200, { 'content-type': 'text/event-stream' });
      firstRequest.response.flushHeaders();
      firstRequest.response.once('close', () => resolveFirstClosed?.());
      secondRequest.response.writeHead(200, { 'content-type': 'text/event-stream' });
      secondRequest.response.end(googleResponse('second-only'));
      resolveBothReceived?.();
    });
    const rewriteUrls: string[] = [];
    let first: Awaited<ReturnType<typeof createPiGoogleModelBinding>> | undefined;
    let second: Awaited<ReturnType<typeof createPiGoogleModelBinding>> | undefined;
    const firstController = new AbortController();
    try {
      [first, second] = await Promise.all([
        createBinding(upstream, createCandidate(FIRST_KEY), { rewriteUrls }),
        createBinding(upstream, createCandidate(SECOND_KEY), { rewriteUrls }),
      ]);
      const firstPort = new URL(first.model.baseUrl ?? '').port;
      const secondPort = new URL(second.model.baseUrl ?? '').port;
      const [firstToken, secondToken] = await Promise.all([
        getGatewayApiKey(first.modelRuntime),
        getGatewayApiKey(second.modelRuntime),
      ]);
      expect(firstPort).not.toBe(secondPort);
      expect(first.modelRuntime).not.toBe(second.modelRuntime);
      expect(firstToken).not.toBe(secondToken);
      expect(firstToken).not.toBe(FIRST_KEY);
      expect(secondToken).not.toBe(SECOND_KEY);

      const firstPromise = first.modelRuntime
        .completeSimple(
          first.model,
          { messages: [{ role: 'user', content: 'first request', timestamp: Date.now() }] },
          { signal: firstController.signal },
        )
        .catch(() => undefined);
      const secondPromise = second.modelRuntime.completeSimple(second.model, {
        messages: [{ role: 'user', content: 'second request', timestamp: Date.now() }],
      });
      await bothReceived;
      const secondMessage = await secondPromise;
      firstController.abort();
      const firstMessage = await firstPromise;
      expect(firstMessage).toMatchObject({ stopReason: 'aborted' });
      expect(secondMessage.content).toContainEqual({ type: 'text', text: 'second-only' });
      expect(upstream.requests.map((request) => request.headers['x-goog-api-key']).sort()).toEqual(
        [FIRST_KEY, SECOND_KEY].sort(),
      );
      await expectBeforeTimeout(
        firstClosed,
        'Aborting one binding did not close its upstream stream.',
      );
      expect(rewriteUrls).toHaveLength(2);
      await first.dispose();
      await expect(first.modelRuntime.getAuth(PI_GOOGLE_PROVIDER_ID)).resolves.toBeUndefined();
      await expect(second.modelRuntime.getAuth(PI_GOOGLE_PROVIDER_ID)).resolves.toMatchObject({
        auth: { apiKey: secondToken },
      });
    } finally {
      const baseUrls = [first?.model.baseUrl, second?.model.baseUrl].filter(
        (url): url is string => url !== undefined,
      );
      await Promise.all([first?.dispose(), second?.dispose()]);
      await Promise.all(baseUrls.map(expectLocalGatewayClosed));
      await closeServer(upstream.server);
    }
  });

  it('routes the configured proxy through a generation-owned dispatcher', async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(googleResponse('proxy-ok'));
    });
    const proxy = await startConnectProxy(new URL(upstream.url).host);
    let binding: Awaited<ReturnType<typeof createPiGoogleModelBinding>> | undefined;
    try {
      binding = await createBinding(
        upstream,
        createCandidate(FIRST_KEY, {
          transport: {
            bodyTimeout: 2_000,
            headersTimeout: 2_000,
            proxy: { kind: 'proxy', url: proxy.url },
          },
        }),
      );
      const message = await binding.modelRuntime.completeSimple(binding.model, {
        messages: [{ role: 'user', content: 'proxy request', timestamp: Date.now() }],
      });
      expect(message.content).toContainEqual({ type: 'text', text: 'proxy-ok' });
      expect(proxy.connects).toEqual([new URL(upstream.url).host]);
      expect(upstream.requests[0]?.headers['x-goog-api-key']).toBe(FIRST_KEY);
    } finally {
      await binding?.dispose();
      for (const socket of proxy.sockets) socket.destroy();
      await closeServer(proxy.server);
      await closeServer(upstream.server);
    }
  });

  it('stops the upstream request on caller abort and closes the listener on dispose', async () => {
    let resolveRequestReceived: (() => void) | undefined;
    let resolveUpstreamClosed: (() => void) | undefined;
    const requestReceived = new Promise<void>((resolve) => {
      resolveRequestReceived = resolve;
    });
    const upstreamClosed = new Promise<void>((resolve) => {
      resolveUpstreamClosed = resolve;
    });
    const upstream = await startUpstream((_request, response) => {
      response.on('close', () => resolveUpstreamClosed?.());
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      resolveRequestReceived?.();
    });
    let binding: Awaited<ReturnType<typeof createPiGoogleModelBinding>> | undefined;
    try {
      binding = await createBinding(upstream);
      const baseUrl = binding.model.baseUrl ?? '';
      const controller = new AbortController();
      const generation = binding.modelRuntime
        .completeSimple(
          binding.model,
          { messages: [{ role: 'user', content: 'abort this generation', timestamp: Date.now() }] },
          { signal: controller.signal },
        )
        .catch(() => undefined);

      await requestReceived;
      controller.abort();
      await generation;
      await expectBeforeTimeout(upstreamClosed, 'The gateway did not cancel its upstream request.');
      await binding.dispose();
      await expectLocalGatewayClosed(baseUrl);
      expect(upstream.requests).toHaveLength(1);
    } finally {
      await binding?.dispose();
      await closeServer(upstream.server);
    }
  });

  it('rejects endpoint, path, credential and native-tool bypasses before forwarding', async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(googleResponse('should-not-forward'));
    });
    let binding: Awaited<ReturnType<typeof createPiGoogleModelBinding>> | undefined;
    try {
      binding = await createBinding(upstream);
      const wrongToken = await postLocalGateway(binding, undefined, { apiKey: 'wrong-token' });
      expect(wrongToken.status).toBe(401);
      await wrongToken.text();

      const extraQuery = await postLocalGateway(
        binding,
        `/v1beta/models/${MODEL_ID}:streamGenerateContent?alt=sse&key=leaked`,
      );
      expect(extraQuery.status).toBe(404);
      await extraQuery.text();

      const encodedPath = await postLocalGateway(
        binding,
        `/v1beta/models/${MODEL_ID}%3AstreamGenerateContent?alt=sse`,
      );
      expect(encodedPath.status).toBe(404);
      await encodedPath.text();

      const trailingSlash = await postLocalGateway(
        binding,
        `/v1beta/models/${MODEL_ID}:streamGenerateContent/?alt=sse`,
      );
      expect(trailingSlash.status).toBe(404);
      await trailingSlash.text();

      const wrongMethod = await postLocalGateway(binding, undefined, { method: 'GET' });
      expect(wrongMethod.status).toBe(405);
      await wrongMethod.text();

      const customHeader = await postLocalGateway(binding, undefined, {
        headers: { 'x-custom-route': 'unexpected' },
      });
      expect(customHeader.status).toBe(400);
      await customHeader.text();

      const authorization = await postLocalGateway(binding, undefined, {
        headers: { authorization: 'Bearer local-admin' },
      });
      expect([400, 401]).toContain(authorization.status);
      await authorization.text();

      const nativeSearch = await postLocalGateway(binding, undefined, {
        body: localRequestBody({ tools: [{ googleSearch: {} }] }),
      });
      expect(nativeSearch.status).toBe(400);
      await nativeSearch.text();

      const nativeCodeExecution = await postLocalGateway(binding, undefined, {
        body: localRequestBody({ tools: [{ codeExecution: {} }] }),
      });
      expect(nativeCodeExecution.status).toBe(400);
      await nativeCodeExecution.text();

      const unsafeProperties = Object.create(null) as Record<string, unknown>;
      unsafeProperties['__proto__'] = { type: 'string' };
      const unsafeFunctionSchema = await postLocalGateway(binding, undefined, {
        body: localRequestBody({
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'search',
                  description: 'search',
                  parametersJsonSchema: {
                    type: 'object',
                    properties: unsafeProperties,
                  },
                },
              ],
            },
          ],
        }),
      });
      expect(unsafeFunctionSchema.status).toBe(400);
      await unsafeFunctionSchema.text();

      expect(upstream.requests).toHaveLength(0);
    } finally {
      const baseUrl = binding?.model.baseUrl;
      await binding?.dispose();
      if (baseUrl !== undefined) await expectLocalGatewayClosed(baseUrl);
      await closeServer(upstream.server);
    }
  });

  it('rejects upstream redirects without following the redirected destination', async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(302, { location: 'https://attacker.example.test/collect' });
      response.end();
    });
    let binding: Awaited<ReturnType<typeof createPiGoogleModelBinding>> | undefined;
    try {
      binding = await createBinding(upstream);
      const response = await postLocalGateway(binding);
      expect(response.status).toBe(502);
      await response.text();
      expect(upstream.requests).toHaveLength(1);
      expect(upstream.requests[0]?.path).toBe(
        `/v1beta/models/${MODEL_ID}:streamGenerateContent?alt=sse`,
      );
    } finally {
      await binding?.dispose();
      await closeServer(upstream.server);
    }
  });

  it('forwards Pi function declarations while rejecting Google built-in tools', async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(googleResponse('host-tool-only'));
    });
    let binding: Awaited<ReturnType<typeof createPiGoogleModelBinding>> | undefined;
    try {
      binding = await createBinding(upstream);
      const response = await postLocalGateway(binding, undefined, {
        body: localRequestBody({
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'file_search',
                  description: 'Search approved files',
                  parametersJsonSchema: {
                    type: 'object',
                    required: ['query'],
                    properties: { query: { type: 'string', description: 'Search query' } },
                    additionalProperties: false,
                  },
                },
              ],
            },
          ],
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(upstream.requests).toHaveLength(1);
      expect(JSON.parse(upstream.requests[0]?.body ?? '{}').tools).toEqual([
        expect.objectContaining({
          functionDeclarations: [expect.objectContaining({ name: 'file_search' })],
        }),
      ]);
    } finally {
      await binding?.dispose();
      await closeServer(upstream.server);
    }
  });

  it('accepts a 20 MiB request body and rejects the first byte above the bound', async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(googleResponse('size-ok'));
    }, false);
    let binding: Awaited<ReturnType<typeof createPiGoogleModelBinding>> | undefined;
    try {
      binding = await createBinding(upstream);
      const prefix =
        '{"contents":[],"generationConfig":{"maxOutputTokens":1},"systemInstruction":{"parts":[{"text":"';
      const suffix = '"}]}}';
      const exactBody =
        prefix +
        'a'.repeat(PI_GOOGLE_MAX_REQUEST_BODY_BYTES - prefix.length - suffix.length) +
        suffix;
      expect(Buffer.byteLength(exactBody)).toBe(PI_GOOGLE_MAX_REQUEST_BODY_BYTES);

      const exactResponse = await postLocalGateway(binding, undefined, {
        body: JSON.parse(exactBody) as Record<string, unknown>,
      });
      expect(exactResponse.status).toBe(200);
      await exactResponse.text();

      const oversizedContentLength = PI_GOOGLE_MAX_REQUEST_BODY_BYTES + 1;
      expect(oversizedContentLength).toBe(PI_GOOGLE_MAX_REQUEST_BODY_BYTES + 1);
      const oversizedResponse = await postLocalGateway(binding, undefined, {
        bodyText: 'x',
        headers: { 'content-length': String(oversizedContentLength) },
      });
      expect(oversizedResponse.status).toBe(413);
      await oversizedResponse.text();
      expect(upstream.requests).toHaveLength(1);
    } finally {
      await binding?.dispose();
      await closeServer(upstream.server);
    }
  });
});
