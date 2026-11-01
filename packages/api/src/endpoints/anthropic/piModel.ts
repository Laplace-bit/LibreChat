import {
  EModelEndpoint,
  THINKING_BINDING_BETA,
  bindsThinkingBlocks,
} from 'librechat-data-provider';
import type { AnthropicEffort } from '@earendil-works/pi-ai';
import type {
  PiAnthropicThinking,
  PiAnthropicThinkingDisplay,
  PiAnthropicProxy,
} from '~/agents/pi/anthropicModel';
import type { AuthorizedPiAnthropicModelCandidate } from '~/agents/pi/anthropicModel';
import type { InitializeResultBase } from '~/types';
import {
  FINE_GRAINED_TOOL_STREAMING_BETA,
  appendAnthropicBetaHeader,
  checkPromptCacheSupport,
  getClaudeHeaders,
} from './helpers';
import { ANTHROPIC_BASE_URL, ANTHROPIC_MESSAGES_API } from '~/agents/pi/anthropicModel';

const SUPPORTED_MODEL_PARAMETER_KEYS = new Set([
  'model',
  'temperature',
  'topP',
  'topK',
  'maxOutputTokens',
  'stop',
  'thinking',
  'thinkingBudget',
  'effort',
  'thinkingDisplay',
  'promptCache',
  'promptCacheTtl',
  'web_search',
]);

const SUPPORTED_LLM_CONFIG_KEYS = new Set([
  'apiKey',
  'model',
  'stream',
  'temperature',
  'topP',
  'topK',
  'maxTokens',
  'stopSequences',
  'thinking',
  'promptCache',
  'promptCacheTtl',
  'outputConfig',
  'invocationKwargs',
  'clientOptions',
  'tools',
]);

const SUPPORTED_CLIENT_OPTION_KEYS = new Set(['defaultHeaders', 'fetchOptions']);
const SUPPORTED_INVOCATION_KWARG_KEYS = new Set(['metadata', 'output_config']);

interface PiAnthropicTransportInput {
  readonly bodyTimeout: number;
  readonly headersTimeout: number;
  readonly proxy: PiAnthropicProxy;
}

export interface CreateAuthorizedPiAnthropicModelCandidateInput {
  readonly endpoint: unknown;
  readonly adminApiKey: string | undefined;
  readonly resolvedApiKey: unknown;
  readonly userProvidedApiKey: boolean;
  readonly useVertex: boolean;
  readonly configuredBaseURL: string | undefined;
  readonly reverseProxyURL: string | undefined;
  readonly anthropicConfig: unknown;
  readonly allConfig: unknown;
  readonly modelParameters: Record<string, unknown> | undefined;
  readonly requestUserId: string | undefined;
  /** Independently resolved from the same process environment as the legacy client. */
  readonly expectedProxyDispatcher: unknown;
  readonly transport: PiAnthropicTransportInput;
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

function hasArrayEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
  });
}

function isPiEffort(value: unknown): value is AnthropicEffort {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  );
}

function isPiThinkingDisplay(value: unknown): value is PiAnthropicThinkingDisplay {
  return value === 'summarized' || value === 'omitted';
}

function resolveThinking(value: unknown, outputConfig: unknown): PiAnthropicThinking | undefined {
  if (value === undefined) {
    return outputConfig === undefined ? { kind: 'disabled' } : undefined;
  }
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(['type', 'budget_tokens', 'display']))) {
    return undefined;
  }
  const display = value.display;
  if (display !== undefined && !isPiThinkingDisplay(display)) {
    return undefined;
  }
  const displayOption: { display?: PiAnthropicThinkingDisplay } =
    display === undefined ? {} : { display };
  if (value.type === 'disabled') {
    if (value.budget_tokens !== undefined || display !== undefined || outputConfig !== undefined) {
      return undefined;
    }
    return { kind: 'disabled' };
  }
  if (value.type === 'enabled') {
    if (
      typeof value.budget_tokens !== 'number' ||
      !Number.isSafeInteger(value.budget_tokens) ||
      value.budget_tokens < 1_024 ||
      outputConfig !== undefined
    ) {
      return undefined;
    }
    return { kind: 'budget', budgetTokens: value.budget_tokens, ...displayOption };
  }
  if (value.type === 'adaptive' && value.budget_tokens === undefined) {
    if (outputConfig === undefined) {
      return { kind: 'adaptive', ...displayOption };
    }
    if (
      !isRecord(outputConfig) ||
      !hasOnlyKeys(outputConfig, new Set(['effort'])) ||
      !isPiEffort(outputConfig.effort)
    ) {
      return undefined;
    }
    return { kind: 'adaptive', ...displayOption, effort: outputConfig.effort };
  }
  return undefined;
}

function isValidModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

function resolveCacheRetention(
  llmConfig: Record<string, unknown>,
): 'none' | 'short' | 'long' | undefined {
  const enabled = llmConfig.promptCache === true;
  const ttl = llmConfig.promptCacheTtl;
  if (!enabled) {
    return ttl === undefined ? 'none' : undefined;
  }
  if (ttl === undefined || ttl === '1h') {
    return 'long';
  }
  if (ttl === '5m') {
    return 'short';
  }
  return undefined;
}

function resolveStopSequences(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 16 ||
    !value.every(
      (entry) =>
        typeof entry === 'string' &&
        entry.length > 0 &&
        entry.length <= 500 &&
        !containsControlCharacter(entry),
    )
  ) {
    return null;
  }
  return [...value];
}

function expectedProviderBetaHeader(modelId: string, cacheEnabled: boolean): string {
  const cacheHeaders = getClaudeHeaders(modelId, cacheEnabled && checkPromptCacheSupport(modelId));
  const providerHeaders = appendAnthropicBetaHeader(
    cacheHeaders,
    bindsThinkingBlocks(modelId) ? THINKING_BINDING_BETA : FINE_GRAINED_TOOL_STREAMING_BETA,
  );
  return providerHeaders['anthropic-beta'];
}

function isAllowedEndpointModel(config: unknown, modelId: string): boolean {
  if (!isRecord(config) || config.models === undefined) {
    return true;
  }
  return Array.isArray(config.models) && config.models.every((model) => typeof model === 'string')
    ? config.models.includes(modelId)
    : false;
}

/**
 * Creates a binding candidate only when the legacy initializer has resolved an unambiguous,
 * server-admin-authenticated request that maps to Pi's canonical Anthropic Messages API.
 */
export function createAuthorizedPiAnthropicModelCandidate(
  input: CreateAuthorizedPiAnthropicModelCandidateInput,
): AuthorizedPiAnthropicModelCandidate | undefined {
  const {
    endpoint,
    adminApiKey,
    resolvedApiKey,
    userProvidedApiKey,
    useVertex,
    configuredBaseURL,
    reverseProxyURL,
    anthropicConfig,
    allConfig,
    modelParameters,
    requestUserId,
    expectedProxyDispatcher,
    transport,
    initializeResult,
  } = input;
  const unparsedLlmConfig: unknown = initializeResult.llmConfig;
  if (!isRecord(unparsedLlmConfig)) {
    return undefined;
  }
  const llmConfig = unparsedLlmConfig;
  const anthropicHeaders = isRecord(anthropicConfig) ? anthropicConfig.headers : undefined;
  const globalHeaders = isRecord(allConfig) ? allConfig.headers : undefined;
  if (
    endpoint !== EModelEndpoint.anthropic ||
    typeof adminApiKey !== 'string' ||
    adminApiKey.trim().length === 0 ||
    containsControlCharacter(adminApiKey) ||
    userProvidedApiKey ||
    useVertex ||
    resolvedApiKey !== adminApiKey ||
    typeof requestUserId !== 'string' ||
    requestUserId.trim().length === 0 ||
    requestUserId.length > 256 ||
    containsControlCharacter(requestUserId) ||
    (configuredBaseURL != null && configuredBaseURL.trim() !== '') ||
    (reverseProxyURL != null && reverseProxyURL.trim() !== '') ||
    (modelParameters != null &&
      (!hasOnlyKeys(modelParameters, SUPPORTED_MODEL_PARAMETER_KEYS) ||
        modelParameters.web_search === true)) ||
    !hasOnlyKeys(llmConfig, SUPPORTED_LLM_CONFIG_KEYS) ||
    llmConfig.apiKey !== adminApiKey ||
    llmConfig.stream !== true ||
    !isValidModelId(llmConfig.model) ||
    modelParameters?.model !== llmConfig.model ||
    !isAllowedEndpointModel(anthropicConfig, llmConfig.model) ||
    hasEntries(anthropicHeaders) ||
    hasEntries(globalHeaders) ||
    (isRecord(allConfig) && allConfig.baseURL != null) ||
    hasArrayEntries(initializeResult.tools) ||
    llmConfig._lc_stream_delay !== undefined ||
    llmConfig.anthropicApiUrl !== undefined
  ) {
    return undefined;
  }

  if (
    (llmConfig.temperature !== undefined &&
      (typeof llmConfig.temperature !== 'number' ||
        !Number.isFinite(llmConfig.temperature) ||
        llmConfig.temperature < 0 ||
        llmConfig.temperature > 1)) ||
    (llmConfig.topP !== undefined &&
      (typeof llmConfig.topP !== 'number' ||
        !Number.isFinite(llmConfig.topP) ||
        llmConfig.topP <= 0 ||
        llmConfig.topP > 1)) ||
    (llmConfig.topK !== undefined &&
      (typeof llmConfig.topK !== 'number' ||
        !Number.isSafeInteger(llmConfig.topK) ||
        llmConfig.topK < 1 ||
        llmConfig.topK > 500)) ||
    typeof llmConfig.maxTokens !== 'number' ||
    !Number.isSafeInteger(llmConfig.maxTokens) ||
    llmConfig.maxTokens < 1 ||
    llmConfig.maxTokens > 1_000_000
  ) {
    return undefined;
  }

  const clientOptions = llmConfig.clientOptions;
  if (
    !isRecord(clientOptions) ||
    !hasOnlyKeys(clientOptions, SUPPORTED_CLIENT_OPTION_KEYS) ||
    (clientOptions.baseURL !== undefined && clientOptions.baseURL !== ANTHROPIC_BASE_URL)
  ) {
    return undefined;
  }
  const expectedBetaHeader = expectedProviderBetaHeader(
    llmConfig.model,
    llmConfig.promptCache === true,
  );
  const defaultHeaders = clientOptions.defaultHeaders;
  if (
    !isRecord(defaultHeaders) ||
    !hasOnlyKeys(defaultHeaders, new Set(['anthropic-beta'])) ||
    defaultHeaders['anthropic-beta'] !== expectedBetaHeader
  ) {
    return undefined;
  }
  const fetchOptions = clientOptions.fetchOptions;
  if (expectedProxyDispatcher === undefined) {
    if (fetchOptions !== undefined) {
      return undefined;
    }
  } else if (
    !isRecord(fetchOptions) ||
    !hasOnlyKeys(fetchOptions, new Set(['dispatcher'])) ||
    fetchOptions.dispatcher !== expectedProxyDispatcher
  ) {
    return undefined;
  }

  const invocationKwargs = llmConfig.invocationKwargs;
  if (
    !isRecord(invocationKwargs) ||
    !hasOnlyKeys(invocationKwargs, SUPPORTED_INVOCATION_KWARG_KEYS) ||
    !isRecord(invocationKwargs.metadata) ||
    !hasOnlyKeys(invocationKwargs.metadata, new Set(['user_id'])) ||
    invocationKwargs.metadata.user_id !== requestUserId
  ) {
    return undefined;
  }
  const invocationOutputConfig = invocationKwargs.output_config;
  if (JSON.stringify(llmConfig.outputConfig) !== JSON.stringify(invocationOutputConfig)) {
    return undefined;
  }

  const thinking = resolveThinking(llmConfig.thinking, invocationOutputConfig);
  const cacheRetention = resolveCacheRetention(llmConfig);
  const stopSequences = resolveStopSequences(llmConfig.stopSequences);
  if (thinking === undefined || cacheRetention === undefined || stopSequences === null) {
    return undefined;
  }
  if (
    hasEntries(llmConfig.tools) ||
    (thinking.kind === 'budget' && thinking.budgetTokens >= llmConfig.maxTokens)
  ) {
    return undefined;
  }

  const { bodyTimeout, headersTimeout, proxy } = transport;
  let validatedProxy: PiAnthropicProxy;
  if (!isRecord(proxy)) {
    return undefined;
  }
  if (proxy.kind === 'direct' && hasOnlyKeys(proxy, new Set(['kind']))) {
    validatedProxy = { kind: 'direct' };
  } else if (
    proxy.kind === 'proxy' &&
    hasOnlyKeys(proxy, new Set(['kind', 'url'])) &&
    typeof proxy.url === 'string' &&
    proxy.url.length <= 2048
  ) {
    const trimmedProxy = proxy.url.trim();
    let proxyUrl: URL;
    try {
      proxyUrl = new URL(trimmedProxy);
    } catch {
      return undefined;
    }
    if (
      !['http:', 'https:', 'socks:', 'socks5:'].includes(proxyUrl.protocol) ||
      proxyUrl.hostname.length === 0 ||
      (proxyUrl.pathname !== '' && proxyUrl.pathname !== '/') ||
      proxyUrl.search !== '' ||
      proxyUrl.hash !== ''
    ) {
      return undefined;
    }
    validatedProxy = { kind: 'proxy', url: trimmedProxy };
  } else {
    return undefined;
  }
  if (
    !Number.isSafeInteger(bodyTimeout) ||
    bodyTimeout < 0 ||
    bodyTimeout > 86_400_000 ||
    !Number.isSafeInteger(headersTimeout) ||
    headersTimeout < 0 ||
    headersTimeout > 86_400_000
  ) {
    return undefined;
  }

  return {
    source: 'server-admin-config',
    provider: 'anthropic',
    api: ANTHROPIC_MESSAGES_API,
    baseUrl: ANTHROPIC_BASE_URL,
    modelId: llmConfig.model,
    serverAdminApiKey: adminApiKey,
    requestUserId,
    transport: {
      bodyTimeout,
      headersTimeout,
      proxy: validatedProxy,
    },
    generation: {
      maxTokens: llmConfig.maxTokens,
      ...(llmConfig.temperature === undefined ? {} : { temperature: llmConfig.temperature }),
      ...(llmConfig.topP === undefined ? {} : { topP: llmConfig.topP }),
      ...(llmConfig.topK === undefined ? {} : { topK: llmConfig.topK }),
      ...(stopSequences === undefined ? {} : { stopSequences }),
      thinking,
      cacheRetention,
      anthropicBetaHeader: expectedBetaHeader,
    },
  };
}
