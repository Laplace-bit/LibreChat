import { channel } from 'node:diagnostics_channel';
import { connect as connectTcp, type AddressInfo } from 'node:net';
import { createServer, request as requestHttp, type Server } from 'node:http';
import type { Api, CredentialStore, Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Duplex } from 'node:stream';
import type { Dispatcher } from 'undici';
import {
  createPiOpenAIModelBinding,
  OPENAI_API,
  OPENAI_BASE_URL,
  PiOpenAIModelBindingError,
  PI_OPENAI_PROVIDER_ID,
  type AuthorizedPiOpenAIModelCandidate,
  type PiOpenAIModelBindingDependencies,
} from './model';
import { getDirectDispatcher, getProxyDispatcher } from '~/utils/proxy';

const API_KEY = 'server-admin-secret-that-must-not-leak';
const MODEL_ID = 'gpt-4o';
const proxyEnvKeys = [
  'PROXY',
  'proxy',
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
];
const originalEnv = process.env;
const transportDispatchers = new Set<Dispatcher>();

beforeEach(() => {
  process.env = { ...originalEnv };
  for (const key of proxyEnvKeys) delete process.env[key];
});

afterEach(() => {
  process.env = originalEnv;
});

afterAll(async () => {
  await Promise.all([...transportDispatchers].map((dispatcher) => dispatcher.destroy()));
});

const catalogModel: Model<Api> = {
  id: MODEL_ID,
  name: 'GPT-4o',
  api: OPENAI_API,
  provider: 'openai',
  baseUrl: OPENAI_BASE_URL,
  input: ['text', 'image'],
  cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
  reasoning: false,
  contextWindow: 128_000,
  maxTokens: 16_384,
  compat: { supportsStrictMode: true },
};

function candidate(
  overrides: Partial<AuthorizedPiOpenAIModelCandidate> = {},
): AuthorizedPiOpenAIModelCandidate {
  return {
    source: 'server-admin-config',
    provider: 'openai',
    api: OPENAI_API,
    baseUrl: OPENAI_BASE_URL,
    modelId: MODEL_ID,
    serverAdminApiKey: API_KEY,
    transport: { bodyTimeout: 900_000, headersTimeout: 300_000 },
    ...overrides,
  };
}

function createHarness(options: { catalogModel?: Model<Api>; boundModel?: Model<Api> } = {}) {
  let registeredModel = options.boundModel;
  const deleteCredential = jest.fn(async () => undefined);
  const credentialStore: CredentialStore = {
    async read() {
      return undefined;
    },
    async list() {
      return [];
    },
    async modify(_providerId, update) {
      return update(undefined);
    },
    delete: deleteCredential,
  };
  const registerProvider = jest.fn((providerId, config) => {
    const modelConfig = config.models?.[0];
    if (modelConfig == null || modelConfig.type === 'image' || modelConfig.type === 'classifier') {
      return;
    }
    registeredModel = {
      ...modelConfig,
      api: modelConfig.api ?? config.api ?? OPENAI_API,
      provider: providerId,
      baseUrl: modelConfig.baseUrl ?? config.baseUrl ?? OPENAI_BASE_URL,
    } as Model<Api>;
  });
  const runtime = {
    getModel: jest.fn((providerId: string, modelId: string) => {
      if (providerId === 'openai' && modelId === MODEL_ID) {
        return options.catalogModel ?? catalogModel;
      }
      if (providerId === PI_OPENAI_PROVIDER_ID && modelId === MODEL_ID) {
        return registeredModel;
      }
      return undefined;
    }),
    registerProvider,
    unregisterProvider: jest.fn(),
    setRuntimeApiKey: jest.fn(async () => undefined),
    removeRuntimeApiKey: jest.fn(async () => undefined),
  };
  const dependencies: PiOpenAIModelBindingDependencies = {
    createCredentialStore: jest.fn(() => credentialStore),
    createRuntime: jest.fn(async () => runtime as unknown as ModelRuntime),
    disposeRuntime: jest.fn(),
  };
  return { credentialStore, deleteCredential, dependencies, registerProvider, runtime };
}

type TransportProxyMode = 'direct' | 'explicit' | 'environment';
type TransportResponseMode = 'headers-timeout' | 'body-timeout';

interface TransportServerHarness {
  server: Server;
  url: string;
  paths: string[];
  requestHeaders: Array<Record<string, string | string[] | undefined>>;
}

async function startTransportServer(mode: TransportResponseMode): Promise<TransportServerHarness> {
  const paths: string[] = [];
  const requestHeaders: Array<Record<string, string | string[] | undefined>> = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? '');
    requestHeaders.push(request.headers);
    request.resume();
    if (mode === 'headers-timeout') {
      const timer = setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end('data: [DONE]\n\n');
      }, 3_000);
      response.on('close', () => clearTimeout(timer));
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.flushHeaders();
    const timer = setTimeout(() => response.end('data: [DONE]\n\n'), 3_000);
    response.on('close', () => clearTimeout(timer));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    paths,
    requestHeaders,
  };
}

interface TransportProxyHarness {
  server: Server;
  url: string;
  requests: string[];
  connects: string[];
  sockets: Set<Duplex>;
}

async function startForwardProxy(originUrl: string): Promise<TransportProxyHarness> {
  const origin = new URL(originUrl);
  const requests: string[] = [];
  const connects: string[] = [];
  const sockets = new Set<Duplex>();
  const server = createServer((incoming, response) => {
    requests.push(incoming.url ?? '');
    let target: URL;
    try {
      target = new URL(incoming.url ?? '');
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (target.origin !== origin.origin) {
      response.writeHead(502).end();
      return;
    }

    const upstream = requestHttp(
      {
        hostname: origin.hostname,
        port: origin.port,
        method: incoming.method,
        path: `${target.pathname}${target.search}`,
        headers: { ...incoming.headers, host: origin.host },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    incoming.pipe(upstream);
  });

  server.on('connect', (incoming, socket, head) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const authority = incoming.url ?? '';
    connects.push(authority);
    if (authority !== origin.host) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }

    const upstream = connectTcp(Number(origin.port), origin.hostname);
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
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    requests,
    connects,
    sockets,
  };
}

async function runPiTransportRequest({
  proxyMode,
  responseMode,
}: {
  proxyMode: TransportProxyMode;
  responseMode: TransportResponseMode;
}) {
  const bodyTimeout = responseMode === 'body-timeout' ? 1_000 : 5_000;
  const headersTimeout = responseMode === 'headers-timeout' ? 1_000 : 5_000;
  const origin = await startTransportServer(responseMode);
  const proxy = proxyMode === 'direct' ? undefined : await startForwardProxy(origin.url);
  const explicitProxy = proxyMode === 'explicit' ? proxy?.url : undefined;
  if (proxyMode === 'environment' && proxy !== undefined) process.env.PROXY = proxy.url;

  const dispatcherOptions = { bodyTimeout, headersTimeout };
  const dispatcher =
    getProxyDispatcher(explicitProxy, dispatcherOptions) ?? getDirectDispatcher(dispatcherOptions);
  transportDispatchers.add(dispatcher);

  let requestedCanonicalUrl: string | undefined;
  const binding = await createPiOpenAIModelBinding(
    candidate({
      transport: {
        ...dispatcherOptions,
        ...(explicitProxy === undefined ? {} : { proxy: explicitProxy }),
      },
    }),
    {
      rewriteRequestUrlForTest: (url) => {
        if (url.href !== `${OPENAI_BASE_URL}/responses`) {
          throw new Error('The Pi provider did not request the canonical OpenAI Responses URL.');
        }
        requestedCanonicalUrl = url.href;
        return new URL('/responses', origin.url);
      },
    },
  );
  let failure: unknown;
  const transportErrors: string[] = [];
  const undiciErrors = channel('undici:request:error');
  const listener = (event: unknown) => {
    const code = (event as { error?: { code?: unknown } }).error?.code;
    if (typeof code === 'string' && code.startsWith('UND_ERR_')) transportErrors.push(code);
  };
  undiciErrors.subscribe(listener);

  try {
    const originalProviderConfig =
      binding.modelRuntime.getRegisteredProviderConfig(PI_OPENAI_PROVIDER_ID);
    if (originalProviderConfig?.streamSimple === undefined) {
      throw new Error('The real Pi runtime did not register the OpenAI Responses adapter.');
    }
    const stream = binding.modelRuntime.stream(
      binding.model,
      { messages: [{ role: 'user', content: 'local transport check', timestamp: Date.now() }] },
      { maxRetries: 0 },
    );
    for await (const event of stream) {
      if (event.type === 'error') failure = event.error;
    }
  } finally {
    undiciErrors.unsubscribe(listener);
    await binding.dispose();
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
    failure,
    requestedCanonicalUrl,
    paths: origin.paths,
    requestHeaders: origin.requestHeaders,
    proxyTraffic: (proxy?.requests.length ?? 0) + (proxy?.connects.length ?? 0),
    transportErrors,
  };
}

describe('createPiOpenAIModelBinding', () => {
  it('registers, authenticates, and removes a custom provider with the real Pi runtime offline', async () => {
    const previousOpenAIKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'ambient-builtin-openai-key';
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('The model binding smoke test must not access the network.');
    });

    try {
      const binding = await createPiOpenAIModelBinding(candidate());

      expect(binding.model).toMatchObject({
        id: MODEL_ID,
        provider: PI_OPENAI_PROVIDER_ID,
        api: OPENAI_API,
        baseUrl: OPENAI_BASE_URL,
      });
      await expect(binding.modelRuntime.getAuth(PI_OPENAI_PROVIDER_ID)).resolves.toMatchObject({
        auth: { apiKey: API_KEY },
      });

      await binding.dispose();

      expect(binding.modelRuntime.getProvider(PI_OPENAI_PROVIDER_ID)).toBeUndefined();
      await expect(binding.modelRuntime.getAuth(PI_OPENAI_PROVIDER_ID)).resolves.toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (previousOpenAIKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAIKey;
      }
    }
  });

  it('keeps two live generation runtimes and credentials isolated', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('The model binding concurrency test must not access the network.');
    });

    try {
      const [first, second] = await Promise.all([
        createPiOpenAIModelBinding(candidate()),
        createPiOpenAIModelBinding(candidate({ serverAdminApiKey: 'second-generation-secret' })),
      ]);

      expect(first.modelRuntime).not.toBe(second.modelRuntime);
      await expect(first.modelRuntime.getAuth(PI_OPENAI_PROVIDER_ID)).resolves.toMatchObject({
        auth: { apiKey: API_KEY },
      });
      await expect(second.modelRuntime.getAuth(PI_OPENAI_PROVIDER_ID)).resolves.toMatchObject({
        auth: { apiKey: 'second-generation-secret' },
      });

      await first.dispose();

      await expect(first.modelRuntime.getAuth(PI_OPENAI_PROVIDER_ID)).resolves.toBeUndefined();
      await expect(second.modelRuntime.getAuth(PI_OPENAI_PROVIDER_ID)).resolves.toMatchObject({
        auth: { apiKey: 'second-generation-secret' },
      });
      await second.dispose();

      await expect(second.modelRuntime.getAuth(PI_OPENAI_PROVIDER_ID)).resolves.toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each([
    ['direct headers timeout', 'direct', 'headers-timeout', 'UND_ERR_HEADERS_TIMEOUT', 0],
    ['direct body timeout', 'direct', 'body-timeout', 'UND_ERR_BODY_TIMEOUT', 0],
    ['explicit proxy body timeout', 'explicit', 'body-timeout', 'UND_ERR_BODY_TIMEOUT', 1],
    [
      'environment proxy headers timeout',
      'environment',
      'headers-timeout',
      'UND_ERR_HEADERS_TIMEOUT',
      1,
    ],
  ] as const)(
    '%s reaches the real Pi OpenAI Responses stream',
    async (_name, proxyMode, responseMode, timeoutCode, expectedProxyTraffic) => {
      const result = await runPiTransportRequest({ proxyMode, responseMode });

      expect(result.failure).toBeDefined();
      expect(result.transportErrors).toContain(timeoutCode);
      expect(result.requestedCanonicalUrl).toBe(`${OPENAI_BASE_URL}/responses`);
      expect(result.paths).toEqual(['/responses']);
      if (expectedProxyTraffic === 0) {
        expect(result.proxyTraffic).toBe(0);
      } else {
        expect(result.proxyTraffic).toBeGreaterThan(0);
      }
      expect(result.requestHeaders[0]?.authorization).toBe(`Bearer ${API_KEY}`);
    },
  );

  it('registers one fixed OpenAI Responses catalog model with isolated credentials', async () => {
    const harness = createHarness();
    const binding = await createPiOpenAIModelBinding(
      candidate({
        requestUserId: 'auth-user-123',
        sampling: { temperature: 0.4, topP: 0.8, maxTokens: 4096 },
      }),
      harness.dependencies,
    );

    expect(harness.dependencies.createRuntime).toHaveBeenCalledWith({
      credentials: harness.credentialStore,
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    expect(harness.registerProvider).toHaveBeenCalledTimes(1);
    expect(harness.registerProvider).toHaveBeenCalledWith(PI_OPENAI_PROVIDER_ID, {
      name: 'OpenAI',
      api: OPENAI_API,
      baseUrl: OPENAI_BASE_URL,
      streamSimple: expect.any(Function),
      models: [
        expect.objectContaining({
          id: MODEL_ID,
          api: OPENAI_API,
          baseUrl: OPENAI_BASE_URL,
          maxTokens: 4096,
          samplingParams: { temperature: 0.4, top_p: 0.8, user: 'auth-user-123' },
        }),
      ],
    });
    expect(harness.registerProvider.mock.calls[0]?.[1]).not.toHaveProperty('apiKey');
    expect(harness.registerProvider.mock.calls[0]?.[1]).not.toHaveProperty('requestUserId');
    expect(binding).not.toHaveProperty('requestUserId');
    expect(harness.runtime.setRuntimeApiKey).toHaveBeenCalledWith(PI_OPENAI_PROVIDER_ID, API_KEY);
    expect(binding.model).toMatchObject({
      id: MODEL_ID,
      provider: PI_OPENAI_PROVIDER_ID,
      api: OPENAI_API,
      baseUrl: OPENAI_BASE_URL,
    });

    await binding.dispose();
    await binding.dispose();

    expect(harness.runtime.removeRuntimeApiKey).toHaveBeenCalledTimes(1);
    expect(harness.runtime.unregisterProvider).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.disposeRuntime).toHaveBeenCalledTimes(1);
    expect(harness.deleteCredential).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['request-style apiKey field', { apiKey: API_KEY }],
    ['custom base URL', { baseUrl: 'https://api.example.test/v1' }],
    ['alternate provider', { provider: 'azure' }],
    ['alternate API', { api: 'openai-completions' }],
    ['non-admin source', { source: 'user-config' }],
  ])('rejects %s before creating a runtime', async (_caseName, override) => {
    const harness = createHarness();

    await expect(
      createPiOpenAIModelBinding({ ...candidate(), ...override }, harness.dependencies),
    ).rejects.toMatchObject({ code: 'INVALID_CANDIDATE' });
    expect(harness.dependencies.createRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown sampling field', { sampling: { temperature: 0.5, top_k: 10 } }],
    ['out-of-range temperature', { sampling: { temperature: 2.1 } }],
    ['out-of-range topP', { sampling: { topP: 0 } }],
    ['invalid maxTokens', { sampling: { maxTokens: 0 } }],
    ['control character in request user id', { requestUserId: 'user\nforged' }],
    ['oversized request user id', { requestUserId: 'u'.repeat(257) }],
  ])('rejects %s', async (_caseName, override) => {
    const harness = createHarness();

    await expect(
      createPiOpenAIModelBinding({ ...candidate(), ...override }, harness.dependencies),
    ).rejects.toMatchObject({ code: 'INVALID_CANDIDATE' });
    expect(harness.dependencies.createRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ['negative body timeout', { bodyTimeout: -1, headersTimeout: 1 }],
    ['fractional header timeout', { bodyTimeout: 1, headersTimeout: 1.5 }],
    ['over-one-day timeout', { bodyTimeout: 86_400_001, headersTimeout: 1 }],
    [
      'unsupported proxy scheme',
      { bodyTimeout: 1, headersTimeout: 1, proxy: 'ftp://proxy.invalid' },
    ],
    ['proxy path', { bodyTimeout: 1, headersTimeout: 1, proxy: 'http://proxy.invalid/nested' }],
  ])('rejects %s without echoing transport configuration', async (_caseName, transport) => {
    const harness = createHarness();
    const failure = await createPiOpenAIModelBinding(
      { ...candidate(), transport },
      harness.dependencies,
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'INVALID_CANDIDATE' });
    if (!(failure instanceof Error)) {
      throw new Error('Expected transport validation to reject with an Error.');
    }
    expect(failure.message).not.toContain('proxy.invalid');
    expect(harness.dependencies.createRuntime).not.toHaveBeenCalled();
  });

  it('rejects catalog entries that are not the requested official Responses model', async () => {
    const harness = createHarness({
      catalogModel: { ...catalogModel, baseUrl: 'https://api.example.test/v1' },
    });

    await expect(
      createPiOpenAIModelBinding(candidate(), harness.dependencies),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_MODEL',
    });
    expect(harness.runtime.unregisterProvider).toHaveBeenCalledTimes(1);
    expect(harness.deleteCredential).toHaveBeenCalledTimes(1);
  });

  it('uses sanitized errors and cleans up a runtime when setup fails', async () => {
    const harness = createHarness();
    harness.runtime.setRuntimeApiKey.mockRejectedValueOnce(new Error(`failed for ${API_KEY}`));

    const failure = await createPiOpenAIModelBinding(candidate(), harness.dependencies).catch(
      (error) => error,
    );

    expect(failure).toBeInstanceOf(PiOpenAIModelBindingError);
    expect(failure).toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    expect(failure.message).not.toContain(API_KEY);
    expect(harness.runtime.removeRuntimeApiKey).toHaveBeenCalledTimes(1);
    expect(harness.runtime.unregisterProvider).toHaveBeenCalledTimes(1);
    expect(harness.deleteCredential).toHaveBeenCalledTimes(1);
  });

  it('surfaces cleanup failure when setup and credential cleanup both fail', async () => {
    const harness = createHarness();
    harness.runtime.setRuntimeApiKey.mockRejectedValueOnce(
      new Error(`setup failed for ${API_KEY}`),
    );
    harness.runtime.removeRuntimeApiKey.mockRejectedValueOnce(
      new Error(`cleanup failed for ${API_KEY}`),
    );
    harness.deleteCredential.mockRejectedValueOnce(
      new Error(`store cleanup failed for ${API_KEY}`),
    );

    const failure = await createPiOpenAIModelBinding(candidate(), harness.dependencies).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(PiOpenAIModelBindingError);
    expect(failure).toMatchObject({ code: 'CLEANUP_FAILED' });
    if (!(failure instanceof Error)) {
      throw new Error('Expected cleanup to reject with an Error.');
    }
    expect(failure.message).not.toContain(API_KEY);
    expect(harness.runtime.unregisterProvider).toHaveBeenCalledTimes(1);
    expect(harness.dependencies.disposeRuntime).toHaveBeenCalledTimes(1);
    expect(harness.deleteCredential).toHaveBeenCalledTimes(1);
  });

  it('reports cleanup failures without returning SDK error text', async () => {
    const harness = createHarness();
    harness.runtime.removeRuntimeApiKey.mockRejectedValueOnce(new Error(`failed for ${API_KEY}`));

    const binding = await createPiOpenAIModelBinding(candidate(), harness.dependencies);
    let failure: unknown;
    try {
      await binding.dispose();
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'CLEANUP_FAILED' });
    if (!(failure instanceof Error)) {
      throw new Error('Expected cleanup to reject with an Error.');
    }
    expect(failure.message).not.toContain(API_KEY);
    expect(harness.runtime.unregisterProvider).toHaveBeenCalledTimes(1);
    expect(harness.deleteCredential).toHaveBeenCalledTimes(1);
  });
});
