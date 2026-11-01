import { EModelEndpoint } from 'librechat-data-provider';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { InitializeResultBase } from '~/types';
import {
  AZURE_OPENAI_RESPONSES_API,
  PI_AZURE_PROVIDER_ID,
  type AuthorizedPiAzureModelCandidate,
} from '~/agents/pi/azureModel';

const API_VERSION = 'v1' as const;
const MAX_MODEL_ID_LENGTH = 128;
const MAX_DEPLOYMENT_NAME_LENGTH = 128;
const MAX_TRANSPORT_TIMEOUT_MS = 86_400_000;

const SUPPORTED_MODEL_PARAMETER_KEYS = new Set(['model', 'useResponsesApi']);
const SUPPORTED_LLM_CONFIG_KEYS = new Set([
  'apiKey',
  'model',
  'user',
  'streaming',
  'useResponsesApi',
  'firstPartyEndpoint',
]);
const SUPPORTED_CONFIG_OPTION_KEYS = new Set([
  'baseURL',
  'defaultHeaders',
  'defaultQuery',
  'fetchOptions',
]);

let azureCatalogPromise: Promise<ReadonlyMap<string, Model<Api>>> | undefined;

type AzureCredentialSource = 'server-admin-environment' | 'server-admin-model-group' | 'user';

export interface CreateAuthorizedPiAzureModelCandidateInput {
  readonly endpoint: unknown;
  readonly credentialSource: AzureCredentialSource;
  readonly adminApiKey: unknown;
  readonly resolvedApiKey: unknown;
  readonly userProvidedBaseURL: boolean;
  /** Final Azure base URL handed to the existing host initializer, if configured. */
  readonly configuredBaseURL: unknown;
  readonly azureConfig: unknown;
  readonly allConfig: unknown;
  readonly mappedAzureConfig: unknown;
  readonly clientOptions: unknown;
  readonly modelParameters: unknown;
  readonly modelName: unknown;
  readonly initializeResult: InitializeResultBase;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function hasEntries(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
  });
}

function isSupportedAzureHostname(hostname: string): boolean {
  return ['.openai.azure.com', '.services.ai.azure.com'].some((suffix) => {
    if (!hostname.endsWith(suffix)) {
      return false;
    }
    const resourceLabels = hostname.slice(0, -suffix.length).split('.');
    return (
      resourceLabels.length > 0 &&
      resourceLabels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
    );
  });
}

function resolveCanonicalAzureBaseURL(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_048) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  const canonicalBaseURL = `${url.origin}/openai/v1`;
  if (
    url.protocol !== 'https:' ||
    !isSupportedAzureHostname(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.pathname !== '/openai/v1' ||
    url.search !== '' ||
    url.hash !== '' ||
    value !== canonicalBaseURL
  ) {
    return undefined;
  }

  return canonicalBaseURL;
}

function isValidModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_MODEL_ID_LENGTH &&
    /^[A-Za-z0-9._-]+$/u.test(value)
  );
}

function isValidDeploymentName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_DEPLOYMENT_NAME_LENGTH &&
    /^[A-Za-z0-9._-]+$/u.test(value) &&
    !containsControlCharacter(value)
  );
}

function isServerAdminKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    !/\s/u.test(value) &&
    value !== 'user_provided' &&
    !containsControlCharacter(value)
  );
}

function isValidTimeout(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_TRANSPORT_TIMEOUT_MS
  );
}

function resolveProxy(value: unknown): string | undefined | null {
  if (value == null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > 2_048) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (
    !['http:', 'https:', 'socks:', 'socks5:'].includes(url.protocol) ||
    url.hostname.length === 0 ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return null;
  }
  return value.trim();
}

async function isSupportedCatalogModel(modelId: string): Promise<boolean> {
  azureCatalogPromise ??= loadAzureCatalog();
  const model = (await azureCatalogPromise).get(modelId);
  return (
    model !== undefined &&
    model.id === modelId &&
    model.provider === PI_AZURE_PROVIDER_ID &&
    model.api === AZURE_OPENAI_RESPONSES_API &&
    (model.baseUrl === '' || model.baseUrl === undefined) &&
    Number.isSafeInteger(model.maxTokens) &&
    model.maxTokens > 0 &&
    !hasEntries(model.headers) &&
    !hasEntries(model.samplingParams) &&
    !hasEntries(model.samplingParamsByThinkingLevel)
  );
}

function isExpectedHostDefaultQuery(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 1 && value['api-version'] === 'preview';
}

/**
 * Creates a Pi candidate only when the existing Azure initializer resolved an
 * administrator-authenticated Responses route to Microsoft's canonical v1 root.
 * The existing host client's generated `api-version=preview` default is not
 * copied; Pi's own adapter fixes its request to `api-version=v1`.
 */
export async function createAuthorizedPiAzureModelCandidate(
  input: CreateAuthorizedPiAzureModelCandidateInput,
): Promise<AuthorizedPiAzureModelCandidate | undefined> {
  const {
    endpoint,
    credentialSource,
    adminApiKey,
    resolvedApiKey,
    userProvidedBaseURL,
    configuredBaseURL,
    azureConfig,
    allConfig,
    mappedAzureConfig,
    clientOptions: rawClientOptions,
    modelParameters,
    modelName,
    initializeResult,
  } = input;
  const rawLlmConfig: unknown = initializeResult.llmConfig;
  const rawConfigOptions: unknown = initializeResult.configOptions;
  const rawAzureOptions: unknown = initializeResult.azureOptions;
  const canonicalBaseURL = isRecord(rawConfigOptions)
    ? resolveCanonicalAzureBaseURL(rawConfigOptions.baseURL)
    : undefined;
  const hasInvalidConfiguredBaseURL =
    configuredBaseURL != null &&
    configuredBaseURL !== '' &&
    resolveCanonicalAzureBaseURL(configuredBaseURL) === undefined;
  const transportTimeouts = isRecord(rawClientOptions)
    ? rawClientOptions.transportTimeouts
    : undefined;
  const bodyTimeout = readProperty(transportTimeouts, 'bodyTimeout');
  const headersTimeout = readProperty(transportTimeouts, 'headersTimeout');
  const deploymentName =
    readProperty(readProperty(mappedAzureConfig, 'azureOptions'), 'azureOpenAIApiDeploymentName') ??
    readProperty(rawAzureOptions, 'azureOpenAIApiDeploymentName') ??
    modelName;
  if (
    !isRecord(rawLlmConfig) ||
    !isRecord(rawConfigOptions) ||
    !isRecord(rawAzureOptions) ||
    !isRecord(rawClientOptions) ||
    !isRecord(modelParameters) ||
    !hasOnlyKeys(modelParameters, SUPPORTED_MODEL_PARAMETER_KEYS) ||
    endpoint !== EModelEndpoint.azureOpenAI ||
    (credentialSource !== 'server-admin-environment' &&
      credentialSource !== 'server-admin-model-group') ||
    !isServerAdminKey(adminApiKey) ||
    !isTrustedCredentialSource(credentialSource, mappedAzureConfig, adminApiKey) ||
    resolvedApiKey !== adminApiKey ||
    userProvidedBaseURL ||
    !isValidModelId(modelName) ||
    modelParameters.model !== modelName ||
    (modelParameters.useResponsesApi !== undefined && modelParameters.useResponsesApi !== true) ||
    initializeResult.provider != null ||
    (Array.isArray(initializeResult.tools) && initializeResult.tools.length > 0) ||
    !hasOnlyKeys(rawLlmConfig, SUPPORTED_LLM_CONFIG_KEYS) ||
    rawLlmConfig.apiKey !== adminApiKey ||
    rawLlmConfig.model !== deploymentName ||
    !isValidDeploymentName(deploymentName) ||
    rawLlmConfig.streaming !== true ||
    rawLlmConfig.useResponsesApi !== true ||
    rawLlmConfig.firstPartyEndpoint !== true ||
    (rawLlmConfig.user !== undefined &&
      (typeof rawLlmConfig.user !== 'string' ||
        rawLlmConfig.user.length === 0 ||
        rawLlmConfig.user.length > 256 ||
        containsControlCharacter(rawLlmConfig.user))) ||
    !hasOnlyKeys(rawConfigOptions, SUPPORTED_CONFIG_OPTION_KEYS) ||
    hasConfiguredBaseURLQuery(configuredBaseURL) ||
    canonicalBaseURL === undefined ||
    hasInvalidConfiguredBaseURL ||
    !isExpectedHostDefaultQuery(rawConfigOptions.defaultQuery) ||
    !isExpectedAzureAuthHeader(rawConfigOptions.defaultHeaders, adminApiKey) ||
    !hasOnlyDispatcherFetchOptions(rawConfigOptions.fetchOptions) ||
    hasEntries(rawClientOptions.headers) ||
    hasEntries(rawClientOptions.defaultQuery) ||
    hasEntries(rawClientOptions.addParams) ||
    hasEntries(rawClientOptions.dropParams) ||
    hasEntries(rawClientOptions.customParams) ||
    rawClientOptions.directEndpoint === true ||
    rawClientOptions.baseURLIsUserProvided === true ||
    hasConfiguredProperty(azureConfig, 'baseURL') ||
    hasEntries(readProperty(azureConfig, 'headers')) ||
    hasConfiguredProperty(allConfig, 'baseURL') ||
    hasEntries(readProperty(allConfig, 'headers')) ||
    hasEntries(readProperty(mappedAzureConfig, 'headers')) ||
    readProperty(mappedAzureConfig, 'serverless') === true ||
    !isSupportedAzureGroupVersion(mappedAzureConfig, rawAzureOptions) ||
    rawAzureOptions.azureOpenAIApiKey !== adminApiKey ||
    !isValidTimeout(bodyTimeout) ||
    !isValidTimeout(headersTimeout)
  ) {
    return undefined;
  }

  if (!(await isSupportedCatalogModel(modelName))) {
    return undefined;
  }

  const proxy = resolveProxy(rawClientOptions.proxy);
  if (proxy === null) {
    return undefined;
  }

  const transport = {
    bodyTimeout,
    headersTimeout,
    ...(proxy === undefined ? {} : { proxy }),
  };

  return {
    source: 'server-admin-config',
    provider: PI_AZURE_PROVIDER_ID,
    api: AZURE_OPENAI_RESPONSES_API,
    baseUrl: canonicalBaseURL,
    modelId: modelName,
    deploymentName,
    apiVersion: API_VERSION,
    serverAdminApiKey: adminApiKey,
    transport,
  };
}

async function loadAzureCatalog(): Promise<ReadonlyMap<string, Model<Api>>> {
  const { InMemoryCredentialStore } = await import('@earendil-works/pi-ai');
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  return new Map(runtime.getModels(PI_AZURE_PROVIDER_ID).map((model) => [model.id, model]));
}

function hasConfiguredBaseURLQuery(value: unknown): boolean {
  if (value == null || value === '') {
    return false;
  }
  if (typeof value !== 'string') {
    return true;
  }
  try {
    return new URL(value).search !== '';
  } catch {
    return true;
  }
}

function hasConfiguredProperty(value: unknown, key: string): boolean {
  const property = readProperty(value, key);
  return property !== undefined && property !== null && property !== '';
}

function isExpectedAzureAuthHeader(value: unknown, apiKey: string): boolean {
  return isRecord(value) && Object.keys(value).length === 1 && value['api-key'] === apiKey;
}

function hasOnlyDispatcherFetchOptions(value: unknown): boolean {
  return (
    isRecord(value) && hasOnlyKeys(value, new Set(['dispatcher'])) && isRecord(value.dispatcher)
  );
}

function isSupportedAzureGroupVersion(mappedAzureConfig: unknown, azureOptions: unknown): boolean {
  const version =
    readProperty(readProperty(mappedAzureConfig, 'azureOptions'), 'azureOpenAIApiVersion') ??
    readProperty(azureOptions, 'azureOpenAIApiVersion');
  return version === undefined || version === API_VERSION;
}

function isTrustedCredentialSource(
  credentialSource: AzureCredentialSource,
  mappedAzureConfig: unknown,
  adminApiKey: string,
): boolean {
  if (credentialSource === 'server-admin-environment') {
    return mappedAzureConfig == null;
  }
  if (credentialSource === 'server-admin-model-group') {
    return (
      isRecord(mappedAzureConfig) &&
      readProperty(mappedAzureConfig, 'serverless') !== true &&
      readProperty(readProperty(mappedAzureConfig, 'azureOptions'), 'azureOpenAIApiKey') ===
        adminApiKey
    );
  }
  return false;
}

function readProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}
