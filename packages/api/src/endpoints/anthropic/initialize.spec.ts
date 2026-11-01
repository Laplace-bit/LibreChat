import { EModelEndpoint } from 'librechat-data-provider';
import type { AnthropicClientOptions } from '@librechat/agents';
import type { BaseInitializeParams, ServerRequest } from '~/types';
import { getInitializeResultPiModelBindingFactory } from '~/agents/pi/modelBindingFactory';
import { createAuthorizedPiAnthropicModelCandidate } from './piModel';
import { resolveModelTransportTimeouts } from '~/agents/config';
import { FINE_GRAINED_TOOL_STREAMING_BETA } from './helpers';
import { getProxyDispatcher } from '~/utils/proxy';
import { initializeAnthropic } from './initialize';

const ADMIN_API_KEY = 'sk-ant-test';
const DIRECT_PROXY_ENV = {
  PROXY: '',
  proxy: '',
  HTTP_PROXY: '',
  http_proxy: '',
  HTTPS_PROXY: '',
  https_proxy: '',
  NO_PROXY: '',
  no_proxy: '',
};

const getDefaultHeaders = (llmConfig: unknown): Record<string, string> =>
  ((llmConfig as AnthropicClientOptions).clientOptions?.defaultHeaders ?? {}) as Record<
    string,
    string
  >;

const getFetchDispatcher = (llmConfig: unknown): unknown => {
  if (typeof llmConfig !== 'object' || llmConfig === null || Array.isArray(llmConfig)) {
    return undefined;
  }
  const clientOptions = Reflect.get(llmConfig, 'clientOptions');
  if (typeof clientOptions !== 'object' || clientOptions === null || Array.isArray(clientOptions)) {
    return undefined;
  }
  const fetchOptions = Reflect.get(clientOptions, 'fetchOptions');
  if (typeof fetchOptions !== 'object' || fetchOptions === null || Array.isArray(fetchOptions)) {
    return undefined;
  }
  return Reflect.get(fetchOptions, 'dispatcher');
};

function createParams(
  endpointsConfig: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): { params: BaseInitializeParams; restore: () => void } {
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    savedEnv[key] = process.env[key];
  }
  Object.assign(process.env, env);

  const params: BaseInitializeParams = {
    req: {
      user: { id: 'user-42' },
      body: { conversationId: 'convo-xyz' },
      config: { endpoints: endpointsConfig },
    } as unknown as ServerRequest,
    endpoint: EModelEndpoint.anthropic,
    model_parameters: { model: 'claude-sonnet-4-5' },
    db: {
      getUserKey: jest.fn(),
      getUserKeyValues: jest.fn(),
    },
  };

  const restore = () => {
    for (const key of Object.keys(env)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  };

  return { params, restore };
}

describe('initializeAnthropic – custom headers', () => {
  it('threads configured headers into clientOptions.defaultHeaders without resolving placeholders', async () => {
    const { params, restore } = createParams(
      {
        [EModelEndpoint.anthropic]: {
          headers: { 'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}' },
        },
      },
      { ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_REVERSE_PROXY: 'https://gateway.example.com' },
    );

    try {
      const result = await initializeAnthropic(params);
      const defaultHeaders = getDefaultHeaders(result.llmConfig);
      /** Placeholder kept intact — resolved at request time, not init time */
      expect(defaultHeaders['X-Conversation-Id']).toBe('{{LIBRECHAT_BODY_CONVERSATIONID}}');
      /** Provider-managed beta header preserved alongside the custom header */
      expect(defaultHeaders['anthropic-beta']).toBe(FINE_GRAINED_TOOL_STREAMING_BETA);
      /** Reverse proxy still wired through native Anthropic config */
      expect(result.llmConfig).toHaveProperty('anthropicApiUrl', 'https://gateway.example.com');
      expect(getInitializeResultPiModelBindingFactory(result)).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('merges endpoints.all headers beneath endpoint-specific headers', async () => {
    const { params, restore } = createParams(
      {
        all: { headers: { 'X-Common': 'all', 'X-Override': 'all' } },
        [EModelEndpoint.anthropic]: { headers: { 'X-Override': 'anthropic' } },
      },
      { ANTHROPIC_API_KEY: 'sk-ant-test' },
    );

    try {
      const result = await initializeAnthropic(params);
      const defaultHeaders = getDefaultHeaders(result.llmConfig);
      expect(defaultHeaders['X-Common']).toBe('all');
      expect(defaultHeaders['X-Override']).toBe('anthropic');
      expect(getInitializeResultPiModelBindingFactory(result)).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('leaves defaultHeaders provider-managed when no custom headers are configured', async () => {
    const { params, restore } = createParams(
      { [EModelEndpoint.anthropic]: {} },
      { ...DIRECT_PROXY_ENV, ANTHROPIC_API_KEY: ADMIN_API_KEY },
    );

    try {
      const result = await initializeAnthropic(params);
      expect(getDefaultHeaders(result.llmConfig)).toEqual({
        'anthropic-beta': FINE_GRAINED_TOOL_STREAMING_BETA,
      });
      expect(getInitializeResultPiModelBindingFactory(result)).toEqual(expect.any(Function));
    } finally {
      restore();
    }
  });

  it('maps only validated adaptive effort and rejects unsupported model options', async () => {
    const { params, restore } = createParams(
      { [EModelEndpoint.anthropic]: {} },
      { ...DIRECT_PROXY_ENV, ANTHROPIC_API_KEY: ADMIN_API_KEY },
    );
    params.model_parameters = {
      model: 'claude-sonnet-4-6',
      thinking: true,
      effort: 'high',
    };

    try {
      const result = await initializeAnthropic(params);
      const candidate = createAuthorizedPiAnthropicModelCandidate({
        endpoint: EModelEndpoint.anthropic,
        adminApiKey: ADMIN_API_KEY,
        resolvedApiKey: ADMIN_API_KEY,
        userProvidedApiKey: false,
        useVertex: false,
        configuredBaseURL: undefined,
        reverseProxyURL: undefined,
        anthropicConfig: {},
        allConfig: undefined,
        modelParameters: params.model_parameters,
        requestUserId: 'user-42',
        expectedProxyDispatcher: undefined,
        transport: {
          ...resolveModelTransportTimeouts(undefined),
          proxy: { kind: 'direct' },
        },
        initializeResult: result,
      });

      expect(candidate?.generation.thinking).toMatchObject({ kind: 'adaptive', effort: 'high' });
      expect(getInitializeResultPiModelBindingFactory(result)).toEqual(expect.any(Function));

      params.model_parameters = {
        model: 'claude-sonnet-4-6',
        thinking: true,
        effort: 'ultra',
      };
      const unsupportedResult = await initializeAnthropic(params);
      expect(getInitializeResultPiModelBindingFactory(unsupportedResult)).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('leaves Pi binding unavailable for user credentials, custom routing, endpoint mismatch, and extra options', async () => {
    const { params, restore } = createParams(
      { [EModelEndpoint.anthropic]: {} },
      { ...DIRECT_PROXY_ENV, ANTHROPIC_API_KEY: ADMIN_API_KEY },
    );

    try {
      const adminResult = await initializeAnthropic(params);
      const resolverInput = {
        endpoint: EModelEndpoint.anthropic,
        adminApiKey: ADMIN_API_KEY,
        resolvedApiKey: ADMIN_API_KEY,
        userProvidedApiKey: false,
        useVertex: false,
        configuredBaseURL: undefined,
        reverseProxyURL: undefined,
        anthropicConfig: {},
        allConfig: undefined,
        modelParameters: params.model_parameters,
        requestUserId: 'user-42',
        expectedProxyDispatcher: undefined,
        transport: {
          ...resolveModelTransportTimeouts(undefined),
          proxy: { kind: 'direct' as const },
        },
        initializeResult: adminResult,
      };

      expect(createAuthorizedPiAnthropicModelCandidate(resolverInput)).toBeDefined();
      const defaultHeaders = getDefaultHeaders(adminResult.llmConfig);
      const expectedBetaHeader = defaultHeaders['anthropic-beta'];
      defaultHeaders['anthropic-beta'] = `${FINE_GRAINED_TOOL_STREAMING_BETA},unapproved-beta`;
      expect(createAuthorizedPiAnthropicModelCandidate(resolverInput)).toBeUndefined();
      defaultHeaders['anthropic-beta'] = expectedBetaHeader;
      expect(
        createAuthorizedPiAnthropicModelCandidate({
          ...resolverInput,
          endpoint: EModelEndpoint.openAI,
        }),
      ).toBeUndefined();
      expect(
        createAuthorizedPiAnthropicModelCandidate({
          ...resolverInput,
          userProvidedApiKey: true,
          resolvedApiKey: 'user-owned-key',
        }),
      ).toBeUndefined();
      expect(
        createAuthorizedPiAnthropicModelCandidate({
          ...resolverInput,
          configuredBaseURL: 'https://gateway.example.test',
        }),
      ).toBeUndefined();
      expect(
        createAuthorizedPiAnthropicModelCandidate({
          ...resolverInput,
          expectedProxyDispatcher: {},
        }),
      ).toBeUndefined();

      params.model_parameters = { model: 'claude-sonnet-4-5', customOption: true };
      const extraOptionResult = await initializeAnthropic(params);
      expect(getInitializeResultPiModelBindingFactory(extraOptionResult)).toBeUndefined();

      params.endpoint = EModelEndpoint.openAI;
      params.model_parameters = { model: 'claude-sonnet-4-5' };
      const wrongEndpointResult = await initializeAnthropic(params);
      expect(getInitializeResultPiModelBindingFactory(wrongEndpointResult)).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('does not bind when Anthropic credentials come from the user credential store', async () => {
    const { params, restore } = createParams(
      { [EModelEndpoint.anthropic]: {} },
      { ...DIRECT_PROXY_ENV, ANTHROPIC_API_KEY: 'user_provided' },
    );
    params.db.getUserKey = jest.fn().mockResolvedValue('user-owned-anthropic-key');

    try {
      const result = await initializeAnthropic(params);
      expect(getInitializeResultPiModelBindingFactory(result)).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('captures the same process-selected proxy dispatcher used by the legacy client', async () => {
    const proxyUrl = 'http://proxy.example.test:8080';
    const { params, restore } = createParams(
      { [EModelEndpoint.anthropic]: {} },
      { ...DIRECT_PROXY_ENV, PROXY: proxyUrl, ANTHROPIC_API_KEY: ADMIN_API_KEY },
    );

    try {
      const result = await initializeAnthropic(params);
      const expectedProxyDispatcher = getProxyDispatcher(proxyUrl);
      const candidate = createAuthorizedPiAnthropicModelCandidate({
        endpoint: EModelEndpoint.anthropic,
        adminApiKey: ADMIN_API_KEY,
        resolvedApiKey: ADMIN_API_KEY,
        userProvidedApiKey: false,
        useVertex: false,
        configuredBaseURL: undefined,
        reverseProxyURL: undefined,
        anthropicConfig: {},
        allConfig: undefined,
        modelParameters: params.model_parameters,
        requestUserId: 'user-42',
        expectedProxyDispatcher,
        transport: {
          ...resolveModelTransportTimeouts(undefined),
          proxy: { kind: 'proxy', url: proxyUrl },
        },
        initializeResult: result,
      });

      expect(getFetchDispatcher(result.llmConfig)).toBe(expectedProxyDispatcher);
      expect(candidate?.transport.proxy).toEqual({ kind: 'proxy', url: proxyUrl });
      expect(getInitializeResultPiModelBindingFactory(result)).toEqual(expect.any(Function));
    } finally {
      restore();
    }
  });
});
