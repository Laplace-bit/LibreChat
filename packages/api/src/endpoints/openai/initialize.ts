import {
  ErrorTypes,
  EModelEndpoint,
  ReasoningEffort,
  mapModelToAzureConfig,
} from 'librechat-data-provider';
import type {
  InitializeResultBase,
  OpenAIConfigOptions,
  ProviderInitializeParams,
  UserKeyValues,
} from '~/types';
import type { AuthorizedPiOpenAIModelCandidate, PiOpenAIReasoningEffort } from '~/agents/pi/model';
import {
  mergeHeaders,
  resolveHeaders,
  isUserProvided,
  checkUserKeyExpiry,
  getAzureCredentials,
} from '~/utils';
import { setInitializeResultPiModelBindingFactory } from '~/agents/pi/modelBindingFactory';
import { getDirectDispatcher, getProxyDispatcher } from '~/utils/proxy';
import { resolveModelTransportTimeouts } from '~/agents/config';
import { OPENAI_API, OPENAI_BASE_URL } from '~/agents/pi/model';
import { createPiOpenAIModelBinding } from '~/agents/pi/model';
import { getOpenAIEndpointParameters } from './parameters';
import { resolveEndpointRuntime } from '~/types';
import { validateEndpointURL } from '~/auth';
import { getOpenAIConfig } from './config';

const PI_SUPPORTED_MODEL_PARAMETER_KEYS = new Set([
  'model',
  'useResponsesApi',
  'reasoning_effort',
  'temperature',
  'top_p',
  'topP',
  'max_tokens',
  'maxTokens',
]);

const PI_SUPPORTED_LLM_CONFIG_KEYS = new Set([
  'apiKey',
  'model',
  'user',
  'streaming',
  'useResponsesApi',
  'reasoning',
  'temperature',
  'topP',
  'maxTokens',
  'firstPartyEndpoint',
]);

function readProperty(value: object, key: string): unknown {
  return Object.entries(value).find(([entryKey]) => entryKey === key)?.[1];
}

const PI_SUPPORTED_REASONING_EFFORTS = new Set<string>([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function isPiOpenAIReasoningEffort(value: unknown): value is PiOpenAIReasoningEffort {
  return typeof value === 'string' && PI_SUPPORTED_REASONING_EFFORTS.has(value);
}

function hasMatchingPiReasoningConfig(llmConfig: object, requestedEffort: unknown): boolean {
  const configuredReasoning = readProperty(llmConfig, 'reasoning');
  if (requestedEffort == null || requestedEffort === ReasoningEffort.unset) {
    return configuredReasoning == null;
  }
  if (!isPiOpenAIReasoningEffort(requestedEffort)) {
    return false;
  }
  if (
    typeof configuredReasoning !== 'object' ||
    configuredReasoning === null ||
    Array.isArray(configuredReasoning)
  ) {
    return false;
  }
  return (
    Object.keys(configuredReasoning).length === 1 &&
    readProperty(configuredReasoning, 'effort') === requestedEffort
  );
}

function hasOnlySupportedParameters(parameters: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(parameters).every(
    ([key, value]) =>
      PI_SUPPORTED_MODEL_PARAMETER_KEYS.has(key) && (key !== 'useResponsesApi' || value === true),
  );
}

function isValidPiSamplingValue(
  key: 'temperature' | 'top_p' | 'topP' | 'max_tokens' | 'maxTokens',
  value: unknown,
): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return false;
  }
  if (key === 'temperature') {
    return value >= 0 && value <= 2;
  }
  if (key === 'top_p' || key === 'topP') {
    return value > 0 && value <= 1;
  }
  return Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000;
}

function getPiSampling(
  parameters: Readonly<Record<string, unknown>>,
): AuthorizedPiOpenAIModelCandidate['sampling'] | undefined {
  const temperature = parameters.temperature;
  const topP = parameters.top_p ?? parameters.topP;
  const maxTokens = parameters.max_tokens ?? parameters.maxTokens;
  if (
    (temperature != null && !isValidPiSamplingValue('temperature', temperature)) ||
    (topP != null && !isValidPiSamplingValue('top_p', topP)) ||
    (maxTokens != null && !isValidPiSamplingValue('max_tokens', maxTokens)) ||
    (parameters.top_p != null && parameters.topP != null) ||
    (parameters.max_tokens != null && parameters.maxTokens != null)
  ) {
    return undefined;
  }
  const sampling = {
    ...(temperature == null ? {} : { temperature }),
    ...(topP == null ? {} : { topP }),
    ...(maxTokens == null ? {} : { maxTokens }),
  };
  return Object.keys(sampling).length > 0 ? sampling : undefined;
}

function hasEntries(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0;
}

function hasConfiguredProperty(value: object, key: string): boolean {
  const property = readProperty(value, key);
  return property !== undefined && property !== null;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
  });
}

function isPiModelTransportCompatible(
  clientOptions: OpenAIConfigOptions,
  configOptions: object | undefined,
  proxy: string | undefined,
  organization: string | undefined,
): boolean {
  const transportTimeouts = clientOptions.transportTimeouts;
  if (
    transportTimeouts == null ||
    !Number.isSafeInteger(transportTimeouts.bodyTimeout) ||
    transportTimeouts.bodyTimeout < 0 ||
    transportTimeouts.bodyTimeout > 86_400_000 ||
    !Number.isSafeInteger(transportTimeouts.headersTimeout) ||
    transportTimeouts.headersTimeout < 0 ||
    transportTimeouts.headersTimeout > 86_400_000
  ) {
    return false;
  }
  const proxyDispatcher = getProxyDispatcher(proxy, transportTimeouts);
  const expectedDispatcher = proxyDispatcher ?? getDirectDispatcher(transportTimeouts);
  if (
    clientOptions.directEndpoint === true ||
    hasEntries(clientOptions.defaultQuery) ||
    hasEntries(clientOptions.addParams) ||
    hasEntries(clientOptions.dropParams) ||
    hasEntries(clientOptions.customParams) ||
    (organization != null && organization.trim() !== '') ||
    hasConfiguredProperty(clientOptions, 'fetch') ||
    hasConfiguredProperty(configOptions ?? {}, 'fetch') ||
    hasConfiguredProperty(configOptions ?? {}, 'baseURL') ||
    hasEntries(readProperty(configOptions ?? {}, 'defaultQuery')) ||
    hasEntries(readProperty(configOptions ?? {}, 'defaultHeaders')) ||
    hasConfiguredProperty(configOptions ?? {}, 'organization')
  ) {
    return false;
  }

  const fetchOptions = readProperty(configOptions ?? {}, 'fetchOptions');
  if (fetchOptions == null) {
    return false;
  }
  if (typeof fetchOptions !== 'object' || Array.isArray(fetchOptions)) {
    return false;
  }
  return (
    Object.keys(fetchOptions).every((key) => key === 'dispatcher') &&
    readProperty(fetchOptions, 'dispatcher') === expectedDispatcher
  );
}

function createAuthorizedPiOpenAIModelCandidate({
  endpoint,
  adminApiKey,
  resolvedApiKey,
  userProvidesKey,
  userProvidesURL,
  configuredBaseURL,
  proxy,
  openAIConfig,
  allConfig,
  clientOptions,
  options,
  modelParameters,
  modelName,
  requestUserId,
}: {
  endpoint: string;
  adminApiKey: string | undefined;
  resolvedApiKey: string | undefined;
  userProvidesKey: boolean;
  userProvidesURL: boolean;
  configuredBaseURL: string | undefined;
  proxy: string | undefined;
  openAIConfig: object | undefined;
  allConfig: object | undefined;
  clientOptions: OpenAIConfigOptions;
  options: InitializeResultBase;
  modelParameters: Record<string, unknown> | undefined;
  modelName: string | undefined;
  requestUserId: string | undefined;
}): AuthorizedPiOpenAIModelCandidate | undefined {
  if (
    endpoint !== EModelEndpoint.openAI ||
    typeof adminApiKey !== 'string' ||
    adminApiKey.trim().length === 0 ||
    userProvidesKey ||
    userProvidesURL ||
    configuredBaseURL !== undefined ||
    resolvedApiKey !== adminApiKey ||
    requestUserId == null ||
    requestUserId.trim().length === 0 ||
    requestUserId.length > 256 ||
    containsControlCharacter(requestUserId) ||
    typeof modelName !== 'string' ||
    modelName.length === 0 ||
    modelName.length > 128 ||
    !/^[A-Za-z0-9._-]+$/u.test(modelName) ||
    modelParameters == null ||
    modelParameters.model !== modelName ||
    !hasOnlySupportedParameters(modelParameters) ||
    !hasMatchingPiReasoningConfig(options.llmConfig, modelParameters.reasoning_effort) ||
    hasEntries(options.tools) ||
    options.provider != null ||
    hasEntries(readProperty(options.llmConfig, 'modelKwargs')) ||
    !Object.keys(options.llmConfig).every((key) => PI_SUPPORTED_LLM_CONFIG_KEYS.has(key)) ||
    readProperty(options.llmConfig, 'apiKey') !== adminApiKey ||
    readProperty(options.llmConfig, 'model') !== modelName ||
    readProperty(options.llmConfig, 'user') !== requestUserId ||
    readProperty(options.llmConfig, 'streaming') !== true ||
    readProperty(options.llmConfig, 'useResponsesApi') !== true ||
    readProperty(options.llmConfig, 'firstPartyEndpoint') !== true ||
    hasEntries(readProperty(allConfig ?? {}, 'headers')) ||
    hasEntries(readProperty(openAIConfig ?? {}, 'headers')) ||
    hasConfiguredProperty(allConfig ?? {}, 'baseURL') ||
    hasConfiguredProperty(openAIConfig ?? {}, 'baseURL') ||
    hasEntries(readProperty(openAIConfig ?? {}, 'customParams')) ||
    hasEntries(readProperty(allConfig ?? {}, 'customParams')) ||
    hasEntries(clientOptions.headers) ||
    !isPiModelTransportCompatible(
      clientOptions,
      options.configOptions,
      proxy,
      process.env.OPENAI_ORGANIZATION,
    )
  ) {
    return undefined;
  }

  const sampling = getPiSampling(modelParameters);
  if (
    sampling === undefined &&
    ['temperature', 'top_p', 'topP', 'max_tokens', 'maxTokens'].some(
      (key) => modelParameters[key] != null,
    )
  ) {
    return undefined;
  }
  const transportTimeouts = clientOptions.transportTimeouts;
  if (transportTimeouts == null) {
    return undefined;
  }

  const reasoningEffort = isPiOpenAIReasoningEffort(modelParameters.reasoning_effort)
    ? modelParameters.reasoning_effort
    : undefined;

  return {
    source: 'server-admin-config',
    provider: 'openai',
    api: OPENAI_API,
    baseUrl: OPENAI_BASE_URL,
    modelId: modelName,
    serverAdminApiKey: adminApiKey,
    requestUserId,
    transport: {
      bodyTimeout: transportTimeouts.bodyTimeout,
      headersTimeout: transportTimeouts.headersTimeout,
      ...(typeof proxy === 'string' && proxy.trim() !== '' ? { proxy: proxy.trim() } : {}),
    },
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(sampling === undefined ? {} : { sampling }),
  };
}

/**
 * Admin-configured base URL for a built-in OpenAI-family endpoint, or `undefined`
 * when the endpoint is served by OpenAI/Azure directly.
 *
 * Read at call time rather than module load so environment changes apply, and
 * shared with callers that must know the endpoint a built-in provider actually
 * talks to before claiming its contract. May be the `user_provided` sentinel,
 * which resolves to a per-user value only after a database read.
 */
export function getBuiltInBaseURL(endpoint?: string | null): string | undefined {
  if (endpoint === EModelEndpoint.openAI) {
    return process.env.OPENAI_REVERSE_PROXY;
  }
  if (endpoint === EModelEndpoint.azureOpenAI) {
    return process.env.AZURE_OPENAI_BASEURL;
  }
  return undefined;
}

/**
 * Initializes OpenAI options for agent usage. This function always returns configuration
 * options and never creates a client instance (equivalent to optionsOnly=true behavior).
 *
 * @param params - Configuration parameters
 * @returns Promise resolving to OpenAI configuration options
 * @throws Error if API key is missing or user key has expired
 */
export async function initializeOpenAI(
  params: ProviderInitializeParams,
): Promise<InitializeResultBase> {
  const { endpoint, model_parameters, db } = params;
  const { appConfig, user, requestBody } = resolveEndpointRuntime(params);
  const openAIConfig = appConfig?.endpoints?.[EModelEndpoint.openAI];
  const allConfig = appConfig?.endpoints?.all;
  const { PROXY, OPENAI_API_KEY, AZURE_API_KEY } = process.env;

  const { key: expiresAt } = requestBody;
  const modelName =
    typeof model_parameters?.model === 'string' ? model_parameters.model : undefined;

  const credentials = {
    [EModelEndpoint.openAI]: OPENAI_API_KEY,
    [EModelEndpoint.azureOpenAI]: AZURE_API_KEY,
  };

  const configuredBaseURL = getBuiltInBaseURL(endpoint);

  const userProvidesKey = isUserProvided(credentials[endpoint as keyof typeof credentials]);
  const userProvidesURL = isUserProvided(configuredBaseURL);
  const isAzureOpenAI = endpoint === EModelEndpoint.azureOpenAI;
  const azureConfig = isAzureOpenAI && appConfig?.endpoints?.[EModelEndpoint.azureOpenAI];
  const mappedAzureConfig = azureConfig
    ? mapModelToAzureConfig({
        modelName: modelName || '',
        modelGroupMap: azureConfig.modelGroupMap,
        groupMap: azureConfig.groupMap,
      })
    : null;
  const needsUserKey = userProvidesKey && !mappedAzureConfig;
  const needsUserURL = userProvidesURL && !mappedAzureConfig?.baseURL;

  let userValues: UserKeyValues | null = null;
  if (expiresAt && (needsUserKey || needsUserURL)) {
    checkUserKeyExpiry(expiresAt, endpoint);
  }
  if (needsUserKey || needsUserURL) {
    userValues = await db.getUserKeyValues({ userId: user?.id ?? '', name: endpoint });
  }

  let apiKey = userProvidesKey
    ? userValues?.apiKey
    : credentials[endpoint as keyof typeof credentials];
  const baseURL = userProvidesURL ? userValues?.baseURL : configuredBaseURL;

  const clientOptions: OpenAIConfigOptions = {
    proxy: PROXY ?? undefined,
    reverseProxyUrl: baseURL || undefined,
    baseURLIsUserProvided: userProvidesURL,
    allowedAddresses: appConfig?.endpoints?.allowedAddresses,
    transportTimeouts: resolveModelTransportTimeouts(appConfig?.endpoints?.agents),
    streaming: true,
    ...getOpenAIEndpointParameters(appConfig, endpoint, modelName),
  };

  /**
   * Custom headers are forwarded only when the destination URL is admin-trusted.
   * When the user supplies the base URL, withhold them — they may carry
   * `${SECRET}` gateway values or user/OpenID token placeholders resolved later
   * by `resolveConfigHeaders`, which must not reach a user-controlled endpoint.
   */
  const trustedURL = !userProvidesURL;
  const globalHeaders = trustedURL ? allConfig?.headers : undefined;
  const openAIHeaders = trustedURL
    ? mergeHeaders(allConfig?.headers, openAIConfig?.headers)
    : undefined;

  let isServerless = false;

  if (isAzureOpenAI && azureConfig && mappedAzureConfig) {
    const { azureOptions, baseURL: configBaseURL, headers = {}, serverless } = mappedAzureConfig;
    isServerless = serverless === true;

    clientOptions.reverseProxyUrl = configBaseURL ?? clientOptions.reverseProxyUrl;
    if (configBaseURL) {
      clientOptions.baseURLIsUserProvided = false;
    }
    clientOptions.headers = resolveHeaders({
      headers: { ...headers, ...(clientOptions.headers ?? {}) },
      user,
    });
    /** `endpoints.all` headers apply globally, but stay unresolved here — they are
     *  resolved once at request time by `resolveConfigHeaders`. Resolving them now
     *  (in addition) would re-expand already-substituted user values, violating the
     *  env-before-user invariant. Azure-managed headers stay authoritative. */
    if (globalHeaders) {
      clientOptions.headers = mergeHeaders(globalHeaders, clientOptions.headers);
    }

    apiKey = azureOptions.azureOpenAIApiKey;
    clientOptions.azure = !isServerless ? azureOptions : undefined;

    if (isServerless) {
      clientOptions.defaultQuery = azureOptions.azureOpenAIApiVersion
        ? { 'api-version': azureOptions.azureOpenAIApiVersion }
        : undefined;

      if (!clientOptions.headers) {
        clientOptions.headers = {};
      }
      clientOptions.headers['api-key'] = apiKey;
    }
  } else if (isAzureOpenAI) {
    clientOptions.azure =
      userProvidesKey && userValues?.apiKey ? JSON.parse(userValues.apiKey) : getAzureCredentials();
    apiKey = clientOptions.azure ? clientOptions.azure.azureOpenAIApiKey : undefined;
    /** Env-var Azure path has no per-model headers; still honor global `all` headers. */
    if (globalHeaders) {
      clientOptions.headers = { ...globalHeaders };
    }
  } else {
    /**
     * Attach admin-configured custom headers for the built-in OpenAI endpoint
     * (endpoint over global `all`). Kept unresolved here so request-body
     * placeholders resolve at request time via `resolveConfigHeaders`.
     */
    if (openAIHeaders) {
      clientOptions.headers = openAIHeaders;
    }
  }

  if (clientOptions.baseURLIsUserProvided && clientOptions.reverseProxyUrl) {
    await validateEndpointURL(
      clientOptions.reverseProxyUrl,
      endpoint,
      appConfig?.endpoints?.allowedAddresses,
    );
  }

  if (userProvidesKey && !apiKey) {
    throw new Error(
      JSON.stringify({
        type: ErrorTypes.NO_USER_KEY,
      }),
    );
  }

  if (!apiKey) {
    throw new Error(`${endpoint} API Key not provided.`);
  }

  const modelOptions = {
    ...(model_parameters ?? {}),
    model: modelName,
    user: user?.id,
  };

  const finalClientOptions: OpenAIConfigOptions = {
    ...clientOptions,
    modelOptions,
  };

  const options: InitializeResultBase = getOpenAIConfig(apiKey, finalClientOptions, endpoint);
  if (clientOptions.azure) {
    options.azureOptions = { ...clientOptions.azure };
  }

  /** Set useLegacyContent for Azure serverless deployments */
  if (isServerless) {
    (options as InitializeResultBase).useLegacyContent = true;
  }

  let streamRate: number | undefined;

  if (isAzureOpenAI && azureConfig) {
    streamRate = azureConfig.streamRate;
  } else if (!isAzureOpenAI && openAIConfig) {
    streamRate = openAIConfig.streamRate;
  }

  if (allConfig?.streamRate != null) {
    streamRate = allConfig.streamRate;
  }

  if (streamRate != null) {
    options.llmConfig._lc_stream_delay = streamRate;
  }

  const piModelCandidate = createAuthorizedPiOpenAIModelCandidate({
    endpoint,
    adminApiKey: OPENAI_API_KEY,
    resolvedApiKey: apiKey,
    userProvidesKey,
    userProvidesURL,
    configuredBaseURL,
    proxy: PROXY,
    openAIConfig,
    allConfig,
    clientOptions,
    options,
    modelParameters: model_parameters,
    modelName,
    requestUserId: typeof user?.id === 'string' ? user.id : undefined,
  });
  if (piModelCandidate !== undefined) {
    setInitializeResultPiModelBindingFactory(options, () =>
      createPiOpenAIModelBinding(piModelCandidate),
    );
  }

  return options;
}
