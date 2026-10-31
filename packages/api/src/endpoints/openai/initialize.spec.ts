import { AuthType, EModelEndpoint, ReasoningEffort } from 'librechat-data-provider';
import type { BaseInitializeParams } from '~/types';
import {
  getAgentPiModelBindingFactory,
  getInitializeResultPiModelBindingFactory,
  transferPiModelBindingFactory,
} from '~/agents/pi/modelBindingFactory';

const mockValidateEndpointURL = jest.fn();
jest.mock('~/auth', () => ({
  ...jest.requireActual('~/auth'),
  validateEndpointURL: (...args: unknown[]) => mockValidateEndpointURL(...args),
}));

const mockGetOpenAIConfig = jest.fn().mockReturnValue({
  llmConfig: { model: 'gpt-4' },
  configOptions: {},
});
jest.mock('./config', () => ({
  getOpenAIConfig: (...args: unknown[]) => mockGetOpenAIConfig(...args),
}));

jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  getAzureCredentials: jest.fn(),
  resolveHeaders: jest.fn(() => ({})),
  isUserProvided: (val: string) => val === 'user_provided',
  checkUserKeyExpiry: jest.fn(),
}));

import { getAzureCredentials } from '~/utils';
import { initializeOpenAI } from './initialize';

const realGetOpenAIConfig =
  jest.requireActual<typeof import('./config')>('./config').getOpenAIConfig;

function createParams(env: Record<string, string | undefined>): BaseInitializeParams {
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    savedEnv[key] = process.env[key];
  }
  Object.assign(process.env, env);

  const db = {
    getUserKeyValues: jest.fn().mockResolvedValue({
      apiKey: 'sk-user-key',
      baseURL: 'https://user-proxy.example.com/v1',
    }),
  } as unknown as BaseInitializeParams['db'];

  const params: BaseInitializeParams = {
    req: {
      user: { id: 'user-1' },
      body: { key: '2099-01-01' },
      config: { endpoints: {} },
    } as unknown as BaseInitializeParams['req'],
    endpoint: EModelEndpoint.openAI,
    model_parameters: { model: 'gpt-4' },
    db,
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

  return Object.assign(params, { _restore: restore });
}

describe('initializeOpenAI – SSRF guard wiring', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should call validateEndpointURL when OPENAI_REVERSE_PROXY is user_provided', async () => {
    const params = createParams({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_REVERSE_PROXY: AuthType.USER_PROVIDED,
    });

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    expect(mockValidateEndpointURL).toHaveBeenCalledTimes(1);
    expect(mockValidateEndpointURL).toHaveBeenCalledWith(
      'https://user-proxy.example.com/v1',
      EModelEndpoint.openAI,
      undefined,
    );
    expect(mockGetOpenAIConfig).toHaveBeenCalledWith(
      'sk-test',
      expect.objectContaining({
        reverseProxyUrl: 'https://user-proxy.example.com/v1',
        baseURLIsUserProvided: true,
        allowedAddresses: undefined,
      }),
      EModelEndpoint.openAI,
    );
  });

  it('should NOT call validateEndpointURL when OPENAI_REVERSE_PROXY is a system URL', async () => {
    const params = createParams({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_REVERSE_PROXY: 'https://api.openai.com/v1',
    });

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    expect(mockValidateEndpointURL).not.toHaveBeenCalled();
  });

  it('should NOT call validateEndpointURL when baseURL is falsy', async () => {
    const params = createParams({
      OPENAI_API_KEY: 'sk-test',
    });

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    expect(mockValidateEndpointURL).not.toHaveBeenCalled();
  });

  it('should propagate SSRF rejection from validateEndpointURL', async () => {
    mockValidateEndpointURL.mockRejectedValueOnce(
      new Error('Base URL for openAI targets a restricted address.'),
    );

    const params = createParams({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_REVERSE_PROXY: AuthType.USER_PROVIDED,
    });

    try {
      await expect(initializeOpenAI(params)).rejects.toThrow('targets a restricted address');
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    expect(mockGetOpenAIConfig).not.toHaveBeenCalled();
  });

  it('should not load stale user Azure values when an admin model group config is selected', async () => {
    const params = createParams({
      AZURE_API_KEY: AuthType.USER_PROVIDED,
      AZURE_OPENAI_BASEURL: AuthType.USER_PROVIDED,
    });
    (params.db.getUserKeyValues as jest.Mock).mockResolvedValue(null);
    params.endpoint = EModelEndpoint.azureOpenAI;
    params.model_parameters = { model: 'gpt-4o' };
    params.req.config = {
      endpoints: {
        [EModelEndpoint.azureOpenAI]: {
          modelGroupMap: {
            'gpt-4o': { group: 'serverless-group' },
          },
          groupMap: {
            'serverless-group': {
              apiKey: 'az-admin-key',
              baseURL: 'https://admin-azure.example.com/openai/deployments/gpt-4o',
              version: '2024-10-21',
              serverless: true,
            },
          },
        },
      },
    } as unknown as BaseInitializeParams['req']['config'];

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    expect(params.db.getUserKeyValues).not.toHaveBeenCalled();
    expect(mockValidateEndpointURL).not.toHaveBeenCalled();
    expect(mockGetOpenAIConfig).toHaveBeenCalledWith(
      'az-admin-key',
      expect.objectContaining({
        reverseProxyUrl: 'https://admin-azure.example.com/openai/deployments/gpt-4o',
        baseURLIsUserProvided: false,
      }),
      EModelEndpoint.azureOpenAI,
    );
  });
});

describe('initializeOpenAI – user-provided credentials', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('loads the stored API key when a resumed request omits expiry metadata', async () => {
    const params = createParams({ OPENAI_API_KEY: AuthType.USER_PROVIDED });
    params.req.body = {};

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    expect(params.db.getUserKeyValues).toHaveBeenCalledWith({
      userId: 'user-1',
      name: EModelEndpoint.openAI,
    });
    expect(mockGetOpenAIConfig).toHaveBeenCalledWith(
      'sk-user-key',
      expect.any(Object),
      EModelEndpoint.openAI,
    );
  });
});

describe('initializeOpenAI – custom headers', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('forwards Agent model transport timeout policy to OpenAI configuration', async () => {
    const params = createParams({ OPENAI_API_KEY: 'sk-test' });
    (params.req.config as { endpoints: Record<string, unknown> }).endpoints = {
      agents: {
        modelResponseBodyTimeoutMs: 1_800_000,
        modelResponseHeadersTimeoutMs: 120_000,
      },
    };

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    const options = mockGetOpenAIConfig.mock.calls[0][1] as {
      transportTimeouts?: { bodyTimeout: number; headersTimeout: number };
    };
    expect(options.transportTimeouts).toEqual({
      bodyTimeout: 1_800_000,
      headersTimeout: 120_000,
    });
  });

  it('forwards configured endpoint headers (merged over endpoints.all) to getOpenAIConfig', async () => {
    const params = createParams({ OPENAI_API_KEY: 'sk-test' });
    (params.req.config as { endpoints: Record<string, unknown> }).endpoints = {
      all: { headers: { 'X-Common': 'all', 'X-Override': 'all' } },
      [EModelEndpoint.openAI]: {
        headers: { 'X-Override': 'openai', 'cf-aig-metadata': '{{LIBRECHAT_BODY_CONVERSATIONID}}' },
      },
    };

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    const options = mockGetOpenAIConfig.mock.calls[0][1] as { headers?: Record<string, string> };
    expect(options.headers).toEqual({
      'X-Common': 'all',
      'X-Override': 'openai',
      'cf-aig-metadata': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
    });
  });

  it('does not set headers when none are configured', async () => {
    const params = createParams({ OPENAI_API_KEY: 'sk-test' });

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    const options = mockGetOpenAIConfig.mock.calls[0][1] as { headers?: Record<string, string> };
    expect(options.headers).toBeUndefined();
  });

  it('withholds configured headers when the user supplies the base URL', async () => {
    const params = createParams({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_REVERSE_PROXY: AuthType.USER_PROVIDED,
    });
    (params.req.config as { endpoints: Record<string, unknown> }).endpoints = {
      [EModelEndpoint.openAI]: { headers: { 'X-Secret': '${GATEWAY_SECRET}' } },
    };

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    const options = mockGetOpenAIConfig.mock.calls[0][1] as { headers?: Record<string, string> };
    expect(options.headers).toBeUndefined();
  });

  it('applies endpoints.all headers to the env-based Azure path, unresolved at init', async () => {
    (getAzureCredentials as jest.Mock).mockReturnValueOnce({ azureOpenAIApiKey: 'az-key' });
    const params = createParams({ AZURE_API_KEY: 'az-key' });
    params.endpoint = EModelEndpoint.azureOpenAI;
    (params.req.config as { endpoints: Record<string, unknown> }).endpoints = {
      all: { headers: { 'X-Global': '{{LIBRECHAT_USER_ID}}' } },
    };

    try {
      await initializeOpenAI(params);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
    }

    const options = mockGetOpenAIConfig.mock.calls[0][1] as { headers?: Record<string, string> };
    // Left unresolved here; request-time resolveConfigHeaders resolves it once
    expect(options.headers).toEqual({ 'X-Global': '{{LIBRECHAT_USER_ID}}' });
  });
});

describe('initializeOpenAI – Pi provider authorization', () => {
  const isolatedEnvKeys = [
    'OPENAI_REVERSE_PROXY',
    'OPENAI_ORGANIZATION',
    'PROXY',
    'proxy',
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'NO_PROXY',
    'no_proxy',
  ];

  function isolateProviderEnvironment(): () => void {
    const saved = new Map(isolatedEnvKeys.map((key) => [key, process.env[key]]));
    for (const key of isolatedEnvKeys) {
      delete process.env[key];
    }
    return () => {
      for (const [key, value] of saved) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    };
  }

  function setRealOpenAIConfig(): void {
    mockGetOpenAIConfig.mockImplementation(realGetOpenAIConfig);
  }

  beforeEach(() => {
    setRealOpenAIConfig();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('creates a request-scoped admin-key factory and keeps it off enumerable state', async () => {
    const restoreIsolatedEnv = isolateProviderEnvironment();
    const params = createParams({ OPENAI_API_KEY: 'sk-server-admin' });
    params.model_parameters = { model: 'gpt-4o', useResponsesApi: true };

    try {
      const options = await initializeOpenAI(params);
      const factory = getInitializeResultPiModelBindingFactory(options);

      expect(factory).toBeDefined();
      expect(Object.keys(options)).not.toContain('createPiModelBinding');
      if (factory === undefined) {
        throw new Error('Expected the authorized OpenAI provider binding factory');
      }

      const binding = await factory();
      expect(binding.model).toMatchObject({
        id: 'gpt-4o',
        api: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        samplingParams: { user: 'user-1' },
      });
      await binding.dispose();

      const initializedAgent = { id: 'agent-1' };
      transferPiModelBindingFactory(options, initializedAgent);
      expect(getInitializeResultPiModelBindingFactory(options)).toBeUndefined();
      expect(getAgentPiModelBindingFactory(initializedAgent)).toBe(factory);
      expect(Object.keys(initializedAgent)).toEqual(['id']);
    } finally {
      (params as unknown as { _restore: () => void })._restore();
      restoreIsolatedEnv();
    }
  });

  it('creates a Pi factory when the authorized OpenAI Responses reasoning effort matches', async () => {
    const restoreIsolatedEnv = isolateProviderEnvironment();
    const params = createParams({ OPENAI_API_KEY: 'sk-server-admin' });
    params.model_parameters = {
      model: 'gpt-4o',
      useResponsesApi: true,
      reasoning_effort: ReasoningEffort.high,
    };

    try {
      const options = await initializeOpenAI(params);

      expect((options.llmConfig as Record<string, unknown>).reasoning).toEqual({
        effort: ReasoningEffort.high,
      });
      expect(getInitializeResultPiModelBindingFactory(options)).toBeDefined();
    } finally {
      (params as unknown as { _restore: () => void })._restore();
      restoreIsolatedEnv();
    }
  });

  it('does not create a Pi factory for reasoning effort `none`, which the binding cannot map', async () => {
    const restoreIsolatedEnv = isolateProviderEnvironment();
    const params = createParams({ OPENAI_API_KEY: 'sk-server-admin' });
    params.model_parameters = {
      model: 'gpt-4o',
      useResponsesApi: true,
      reasoning_effort: ReasoningEffort.none,
    };

    try {
      const options = await initializeOpenAI(params);
      expect(getInitializeResultPiModelBindingFactory(options)).toBeUndefined();
    } finally {
      (params as unknown as { _restore: () => void })._restore();
      restoreIsolatedEnv();
    }
  });

  it.each([
    ['user-provided API key', { OPENAI_API_KEY: AuthType.USER_PROVIDED }, undefined],
    [
      'user-provided base URL',
      { OPENAI_API_KEY: 'sk-server-admin', OPENAI_REVERSE_PROXY: AuthType.USER_PROVIDED },
      undefined,
    ],
    [
      'reverse proxy URL',
      { OPENAI_API_KEY: 'sk-server-admin', OPENAI_REVERSE_PROXY: 'https://gateway.example/v1' },
      undefined,
    ],
    ['organization mode', { OPENAI_API_KEY: 'sk-server-admin' }, 'organization'],
  ])('does not issue a factory for %s', async (_name, env, outputMode) => {
    const restoreIsolatedEnv = isolateProviderEnvironment();
    const params = createParams(env as Record<string, string | undefined>);
    params.model_parameters = { model: 'gpt-4o', useResponsesApi: true };
    if (outputMode === 'organization') {
      process.env.OPENAI_ORGANIZATION = 'org-1';
    }

    try {
      const options = await initializeOpenAI(params);
      expect(getInitializeResultPiModelBindingFactory(options)).toBeUndefined();
    } finally {
      (params as unknown as { _restore: () => void })._restore();
      restoreIsolatedEnv();
    }
  });

  it.each([
    ['configured PROXY', 'PROXY', 'http://proxy.example:8080'],
    ['HTTPS_PROXY environment route', 'HTTPS_PROXY', 'http://env-proxy.example:8080'],
  ])('preserves the %s only with its matching dispatcher', async (_name, variable, proxyURL) => {
    const restoreIsolatedEnv = isolateProviderEnvironment();
    const params = createParams({ OPENAI_API_KEY: 'sk-server-admin' });
    params.model_parameters = { model: 'gpt-4o', useResponsesApi: true };
    process.env[variable] = proxyURL;

    try {
      const options = await initializeOpenAI(params);
      const factory = getInitializeResultPiModelBindingFactory(options);
      expect(factory).toBeDefined();
      if (factory === undefined) {
        throw new Error('Expected a request-scoped factory for the configured transport');
      }

      const binding = await factory();
      expect(binding.model.id).toBe('gpt-4o');
      await binding.dispose();
    } finally {
      (params as unknown as { _restore: () => void })._restore();
      restoreIsolatedEnv();
    }
  });

  it.each([
    ['endpoints.all headers', { all: { headers: { 'X-Route': 'admin' } } }],
    ['OpenAI endpoint headers', { openAI: { headers: { 'X-Route': 'admin' } } }],
  ])('does not issue a factory for %s', async (_name, endpoints) => {
    const restoreIsolatedEnv = isolateProviderEnvironment();
    const params = createParams({ OPENAI_API_KEY: 'sk-server-admin' });
    params.req.config = { endpoints } as unknown as BaseInitializeParams['req']['config'];
    params.model_parameters = { model: 'gpt-4o', useResponsesApi: true };

    try {
      const options = await initializeOpenAI(params);
      expect(getInitializeResultPiModelBindingFactory(options)).toBeUndefined();
    } finally {
      (params as unknown as { _restore: () => void })._restore();
      restoreIsolatedEnv();
    }
  });

  it.each([
    [
      'native web-search tools',
      { model: 'gpt-4o', useResponsesApi: true, web_search: true },
      undefined,
    ],
    [
      'unsupported model parameter',
      { model: 'gpt-4o', useResponsesApi: true, presence_penalty: 0.5 },
      undefined,
    ],
    [
      'reasoning effort that does not match server configuration',
      { model: 'gpt-4o', useResponsesApi: true, reasoning_effort: ReasoningEffort.high },
      'reasoningMismatch',
    ],
    ['Chat Completions mode', { model: 'gpt-4o', useResponsesApi: false }, undefined],
    ['provider-native OpenRouter mode', { model: 'gpt-4o', useResponsesApi: true }, 'openrouter'],
    ['default query override', { model: 'gpt-4o', useResponsesApi: true }, 'defaultQuery'],
    ['custom dispatcher', { model: 'gpt-4o', useResponsesApi: true }, 'dispatcher'],
  ])('does not issue a factory for %s', async (_name, modelParameters, outputMode) => {
    const restoreIsolatedEnv = isolateProviderEnvironment();
    const params = createParams({ OPENAI_API_KEY: 'sk-server-admin' });
    params.model_parameters = modelParameters as Record<string, unknown>;
    if (outputMode != null) {
      const configOptions: Record<string, unknown> = {};
      if (outputMode === 'defaultQuery') {
        configOptions.defaultQuery = { custom: 'value' };
      } else if (outputMode === 'dispatcher') {
        configOptions.fetchOptions = { dispatcher: {} };
      }
      const serverOptions = {
        llmConfig: {
          apiKey: 'sk-server-admin',
          model: 'gpt-4o',
          user: 'user-1',
          streaming: true,
          useResponsesApi: true,
          ...(outputMode === 'reasoningMismatch' ? { reasoning: { effort: 'low' } } : {}),
          firstPartyEndpoint: true,
        },
        configOptions,
        ...(outputMode === 'openrouter' ? { provider: 'openrouter' } : {}),
      };
      mockGetOpenAIConfig.mockReturnValueOnce(serverOptions);
    }

    try {
      const options = await initializeOpenAI(params);
      expect(getInitializeResultPiModelBindingFactory(options)).toBeUndefined();
    } finally {
      (params as unknown as { _restore: () => void })._restore();
      restoreIsolatedEnv();
    }
  });

  it('leaves legacy initialization usable when the Responses API is not selected', async () => {
    const restoreIsolatedEnv = isolateProviderEnvironment();
    const params = createParams({ OPENAI_API_KEY: 'sk-server-admin' });

    try {
      const options = await initializeOpenAI(params);
      expect(options.llmConfig.model).toBe('gpt-4');
      expect(getInitializeResultPiModelBindingFactory(options)).toBeUndefined();
    } finally {
      (params as unknown as { _restore: () => void })._restore();
      restoreIsolatedEnv();
    }
  });
});
