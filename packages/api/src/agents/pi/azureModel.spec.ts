import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { AddressInfo } from 'node:net';
import {
  AZURE_OPENAI_RESPONSES_API,
  createPiAzureModelBinding,
  PiAzureModelBindingError,
  PI_AZURE_PROVIDER_ID,
  type AuthorizedPiAzureModelCandidate,
} from './azureModel';

const MODEL_ID = 'gpt-4o';
const DEPLOYMENT_NAME = 'factory-gpt-4o';
const API_KEY = 'server-admin-azure-secret-that-must-not-leak';
const BASE_URL = 'https://fixture-resource.openai.azure.com/openai/v1';
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

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

interface LocalServer {
  readonly server: Server;
  readonly url: string;
  readonly requests: CapturedRequest[];
}

function candidate(
  overrides: Partial<AuthorizedPiAzureModelCandidate> = {},
): AuthorizedPiAzureModelCandidate {
  return {
    source: 'server-admin-config',
    provider: 'azure',
    api: AZURE_OPENAI_RESPONSES_API,
    baseUrl: BASE_URL,
    modelId: MODEL_ID,
    deploymentName: DEPLOYMENT_NAME,
    apiVersion: 'v1',
    serverAdminApiKey: API_KEY,
    transport: { bodyTimeout: 5_000, headersTimeout: 5_000 },
    ...overrides,
  };
}

function completedResponse(text: string): string {
  const outputItem = {
    id: 'msg-local-1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const response = {
    id: 'resp-local-1',
    object: 'response',
    status: 'completed',
    output: [outputItem],
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  };
  const events = [
    { type: 'response.created', response: { id: response.id } },
    { type: 'response.output_item.added', output_index: 0, item: { ...outputItem, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item: outputItem },
    { type: 'response.completed', response },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

async function startLocalServer(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<LocalServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
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

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function createLocalBinding(
  upstream: LocalServer,
  value = candidate(),
  canonicalUrls: string[] = [],
) {
  return createPiAzureModelBinding(value, {
    rewriteRequestUrlForTest(url) {
      const expectedUrl = new URL('/openai/v1/responses?api-version=v1', value.baseUrl);
      if (url.href !== expectedUrl.href) {
        throw new Error(`Unexpected Azure destination: ${url.href}`);
      }
      canonicalUrls.push(url.href);
      return new URL(`${url.pathname}${url.search}`, upstream.url);
    },
  });
}

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.AZURE_API_KEY;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.AZURE_OPENAI_BASE_URL;
  delete process.env.AZURE_OPENAI_RESOURCE_NAME;
  for (const key of proxyEnvKeys) {
    delete process.env[key];
  }
});

afterEach(() => {
  process.env = originalEnv;
});

describe('createPiAzureModelBinding', () => {
  it('rejects non-admin credentials, unsupported API variants, and non-canonical endpoints before runtime creation', async () => {
    const createRuntime = jest.fn(async () => {
      throw new Error('runtime should not be created for an invalid candidate');
    });
    const invalidCandidates: unknown[] = [
      { ...candidate(), source: 'user-config' },
      { ...candidate(), serverAdminApiKey: 'user_provided' },
      { ...candidate(), api: 'openai-completions' },
      { ...candidate(), apiVersion: '2025-04-01-preview' },
      { ...candidate(), baseUrl: 'https://resource.example.test/openai/v1' },
      { ...candidate(), baseUrl: 'https://resource.ai.azure.com/openai/v1' },
      { ...candidate(), baseUrl: 'https://resource.cognitiveservices.azure.com/openai/v1' },
      {
        ...candidate(),
        baseUrl: 'https://resource.openai.azure.com.attacker.test/openai/v1',
      },
      { ...candidate(), baseUrl: 'https://resource.openai.azure.com/models' },
      { ...candidate(), baseUrl: 'https://resource.openai.azure.com/openai/v1?route=x' },
      { ...candidate(), baseUrl: 'https://bad..resource.openai.azure.com/openai/v1' },
      { ...candidate(), baseUrl: 'http://resource.openai.azure.com/openai/v1' },
    ];

    for (const invalidCandidate of invalidCandidates) {
      await expect(
        createPiAzureModelBinding(invalidCandidate, { createRuntime }),
      ).rejects.toBeInstanceOf(PiAzureModelBindingError);
    }

    expect(createRuntime).not.toHaveBeenCalled();
  });

  it('uses the Azure server-admin key only for the fixed v1 Responses destination', async () => {
    let binding: Awaited<ReturnType<typeof createPiAzureModelBinding>> | undefined;
    const canonicalUrls: string[] = [];
    const upstream = await startLocalServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(completedResponse('azure-local-ok'));
    });

    try {
      binding = await createLocalBinding(upstream, candidate(), canonicalUrls);
      const response = await binding.modelRuntime.completeSimple(
        binding.model,
        { messages: [{ role: 'user', content: 'local Azure fixture', timestamp: Date.now() }] },
        {
          headers: { Authorization: 'Bearer injected', 'X-Injected': 'must-not-forward' },
          maxRetries: 0,
          onPayload: (payload) =>
            typeof payload === 'object' && payload !== null
              ? { ...payload, model: 'attacker-selected-deployment' }
              : payload,
        },
      );

      expect(response.content).toContainEqual(
        expect.objectContaining({ type: 'text', text: 'azure-local-ok' }),
      );
      expect(response.stopReason).toBe('stop');
      expect(canonicalUrls).toEqual([`${BASE_URL}/responses?api-version=v1`]);
      expect(upstream.requests).toHaveLength(1);
      const request = upstream.requests[0];
      expect(request?.method).toBe('POST');
      expect(request?.path).toBe('/openai/v1/responses?api-version=v1');
      expect(request?.headers['api-key']).toBe(API_KEY);
      expect(request?.headers.authorization).toBeUndefined();
      expect(request?.headers['x-injected']).toBeUndefined();
      expect(request?.body).not.toContain(API_KEY);
      expect(JSON.parse(request?.body ?? '{}')).toMatchObject({
        model: DEPLOYMENT_NAME,
        stream: true,
        store: false,
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'local Azure fixture' }] }],
      });
      expect(binding.modelRuntime.getRegisteredProviderConfig(PI_AZURE_PROVIDER_ID)).toMatchObject({
        api: AZURE_OPENAI_RESPONSES_API,
        baseUrl: BASE_URL,
        streamSimple: expect.any(Function),
      });
      expect(
        binding.modelRuntime.getRegisteredProviderConfig(PI_AZURE_PROVIDER_ID),
      ).not.toHaveProperty('apiKey');
      expect(binding.model).not.toHaveProperty('serverAdminApiKey');
      await expect(binding.modelRuntime.getAuth(PI_AZURE_PROVIDER_ID)).resolves.toMatchObject({
        auth: { apiKey: API_KEY },
      });
    } finally {
      await binding?.dispose();
      await closeServer(upstream.server);
    }

    await expect(binding?.modelRuntime.getAuth(PI_AZURE_PROVIDER_ID)).resolves.toBeUndefined();
  });

  it('accepts the documented Azure AI Foundry Models endpoint suffix and standard v1 root', async () => {
    const foundryCandidate = candidate({
      baseUrl: 'https://fixture-resource.services.ai.azure.com/openai/v1',
    });
    const runtime = {
      getModel: jest.fn(() => undefined),
      registerProvider: jest.fn(),
      unregisterProvider: jest.fn(),
      setRuntimeApiKey: jest.fn(),
      removeRuntimeApiKey: jest.fn(),
    } as unknown as ModelRuntime;
    await expect(
      createPiAzureModelBinding(foundryCandidate, {
        createRuntime: async () => runtime,
        resolveCatalogModel: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL' });
    expect(runtime.getModel).not.toHaveBeenCalled();
    expect(runtime.registerProvider).not.toHaveBeenCalled();
  });

  it('fails closed on redirects without forwarding the Azure credential to another host', async () => {
    const redirectTarget = await startLocalServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(completedResponse('should-not-be-called'));
    });
    const upstream = await startLocalServer((_request, response) => {
      response.writeHead(302, {
        location: `${redirectTarget.url}/credential-capture`,
      });
      response.end();
    });
    let binding: Awaited<ReturnType<typeof createPiAzureModelBinding>> | undefined;

    try {
      binding = await createLocalBinding(upstream);
      const response = await binding.modelRuntime.completeSimple(
        binding.model,
        { messages: [{ role: 'user', content: 'redirect must fail', timestamp: Date.now() }] },
        { maxRetries: 0 },
      );

      expect(response.stopReason).toBe('error');
      expect(upstream.requests).toHaveLength(1);
      expect(redirectTarget.requests).toHaveLength(0);
    } finally {
      await binding?.dispose();
      await closeServer(upstream.server);
      await closeServer(redirectTarget.server);
    }
  });

  it.each([
    {
      name: 'custom headers',
      baseUrl: '',
      headers: { Authorization: 'Bearer injected' },
    },
    {
      name: 'custom base URLs',
      baseUrl: 'https://attacker.example.test/openai/v1',
      headers: undefined,
    },
  ])(
    'rejects catalog model overrides with $name before registering an Azure provider',
    async (overrides) => {
      const catalogModel: Model<Api> = {
        id: MODEL_ID,
        name: 'GPT-4o override',
        api: AZURE_OPENAI_RESPONSES_API,
        provider: PI_AZURE_PROVIDER_ID,
        baseUrl: overrides.baseUrl ?? '',
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 16_384,
        ...(overrides.headers === undefined ? {} : { headers: overrides.headers }),
      };
      const registerProvider = jest.fn();
      const runtime = {
        getModel: jest.fn(() => catalogModel),
        registerProvider,
        unregisterProvider: jest.fn(),
        removeRuntimeApiKey: jest.fn(),
      } as unknown as ModelRuntime;

      await expect(
        createPiAzureModelBinding(candidate(), {
          createRuntime: async () => runtime,
          resolveCatalogModel: () => catalogModel,
        }),
      ).rejects.toMatchObject({ code: 'UNSUPPORTED_MODEL' });
      expect(registerProvider).not.toHaveBeenCalled();
    },
  );
});
