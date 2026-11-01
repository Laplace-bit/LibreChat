import { Providers } from '@librechat/agents';
import { EModelEndpoint } from 'librechat-data-provider';
import type { PiGoogleProxy } from '~/agents/pi/googleGateway';
import type { InitializeResultBase } from '~/types';
import {
  GOOGLE_GENERATIVE_AI_API,
  GOOGLE_GENERATIVE_BASE_URL,
  type AuthorizedPiGoogleModelCandidate,
} from '~/agents/pi/googleModel';

const SUPPORTED_MODEL_PARAMETER_KEYS = new Set([
  'model',
  'temperature',
  'maxOutputTokens',
  'topP',
  'topK',
  'stopSequences',
  'thinking',
  'thinkingBudget',
  'thinkingLevel',
]);

const SUPPORTED_LLM_CONFIG_KEYS = new Set([
  'model',
  'maxRetries',
  'temperature',
  'maxOutputTokens',
  'topP',
  'topK',
  'stopSequences',
  'safetySettings',
  'thinkingConfig',
  'baseUrl',
  'customHeaders',
  '_lc_stream_delay',
]);
const UNSUPPORTED_USAGE_MODELS = new Set(['gemini-3-pro-preview']);

const GOOGLE_SAFETY_CATEGORIES = new Set([
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_CIVIC_INTEGRITY',
]);

const GOOGLE_SAFETY_THRESHOLDS = new Set([
  'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
  'BLOCK_LOW_AND_ABOVE',
  'BLOCK_MEDIUM_AND_ABOVE',
  'BLOCK_ONLY_HIGH',
  'BLOCK_NONE',
]);

interface PiGoogleTransportInput {
  readonly bodyTimeout: number;
  readonly headersTimeout: number;
  readonly proxy: unknown;
}

export interface CreateAuthorizedPiGoogleModelCandidateInput {
  readonly endpoint: unknown;
  readonly adminApiKey: string | undefined;
  readonly resolvedApiKey: unknown;
  readonly userProvidedApiKey: boolean;
  readonly resolvedProvider: unknown;
  readonly configuredBaseURL: unknown;
  readonly reverseProxyURL: string | undefined;
  readonly authHeader: boolean;
  readonly googleConfig: unknown;
  readonly allConfig: unknown;
  readonly modelParameters: Record<string, unknown> | undefined;
  readonly expectedProxyURL: unknown;
  readonly transport: PiGoogleTransportInput;
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

function isValidModelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._-]+$/u.test(value)
  );
}

function isValidPositiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function isValidSafetySettings(
  value: unknown,
): value is readonly { category: string; threshold: string }[] | undefined {
  if (value === undefined) {
    return true;
  }
  if (!Array.isArray(value) || value.length !== GOOGLE_SAFETY_CATEGORIES.size) {
    return false;
  }

  const categories = new Set<string>();
  return value.every((setting) => {
    if (
      !isRecord(setting) ||
      !hasOnlyKeys(setting, new Set(['category', 'threshold'])) ||
      typeof setting.category !== 'string' ||
      !GOOGLE_SAFETY_CATEGORIES.has(setting.category) ||
      categories.has(setting.category) ||
      typeof setting.threshold !== 'string' ||
      !GOOGLE_SAFETY_THRESHOLDS.has(setting.threshold)
    ) {
      return false;
    }
    categories.add(setting.category);
    return true;
  });
}

function isValidThinkingConfig(
  value: unknown,
): value is AuthorizedPiGoogleModelCandidate['generation']['thinkingConfig'] {
  if (value === undefined) {
    return true;
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(['includeThoughts', 'thinkingBudget', 'thinkingLevel'])) ||
    (value.includeThoughts !== undefined && typeof value.includeThoughts !== 'boolean')
  ) {
    return false;
  }

  const hasBudget = value.thinkingBudget !== undefined;
  const hasLevel = value.thinkingLevel !== undefined;
  if ((hasBudget && hasLevel) || (value.includeThoughts === undefined && !hasBudget && !hasLevel)) {
    return false;
  }
  if (
    hasBudget &&
    (typeof value.thinkingBudget !== 'number' ||
      !Number.isSafeInteger(value.thinkingBudget) ||
      value.thinkingBudget < -1 ||
      value.thinkingBudget > 65_536)
  ) {
    return false;
  }
  if (
    hasLevel &&
    !['THINKING_LEVEL_UNSPECIFIED', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(
      String(value.thinkingLevel),
    )
  ) {
    return false;
  }
  return true;
}

function resolveStopSequences(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 5 ||
    !value.every(
      (entry) =>
        typeof entry === 'string' &&
        entry.length > 0 &&
        entry.length <= 256 &&
        !containsControlCharacter(entry),
    )
  ) {
    return null;
  }
  return [...value];
}

function isAllowedEndpointModel(config: unknown, modelId: string): boolean {
  if (!isRecord(config) || config.models === undefined) {
    return true;
  }
  return Array.isArray(config.models) && config.models.every((model) => typeof model === 'string')
    ? config.models.includes(modelId)
    : false;
}

function resolveProxy(value: unknown): PiGoogleProxy | undefined {
  if (value === undefined) {
    return { kind: 'direct' };
  }
  if (typeof value !== 'string' || value.length > 2048) {
    return undefined;
  }
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.hostname.length === 0 ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return undefined;
  }
  return { kind: 'proxy', url: trimmed };
}

/**
 * Creates a Pi candidate only for a server-admin-authenticated direct Google request whose
 * resolved options can be represented by Pi's Google Generative AI adapter.
 */
export function createAuthorizedPiGoogleModelCandidate(
  input: CreateAuthorizedPiGoogleModelCandidateInput,
): AuthorizedPiGoogleModelCandidate | undefined {
  const {
    endpoint,
    adminApiKey,
    resolvedApiKey,
    userProvidedApiKey,
    resolvedProvider,
    configuredBaseURL,
    reverseProxyURL,
    authHeader,
    googleConfig,
    allConfig,
    modelParameters,
    expectedProxyURL,
    transport,
    initializeResult,
  } = input;
  const unparsedLlmConfig: unknown = initializeResult.llmConfig;
  if (!isRecord(unparsedLlmConfig)) {
    return undefined;
  }

  const llmConfig = unparsedLlmConfig;
  const endpointHeaders = isRecord(googleConfig) ? googleConfig.headers : undefined;
  const globalHeaders = isRecord(allConfig) ? allConfig.headers : undefined;
  const proxy = resolveProxy(expectedProxyURL);

  if (
    endpoint !== EModelEndpoint.google ||
    resolvedProvider !== Providers.GOOGLE ||
    typeof adminApiKey !== 'string' ||
    adminApiKey.trim().length === 0 ||
    adminApiKey.trim() !== adminApiKey ||
    /\s/u.test(adminApiKey) ||
    adminApiKey === 'user_provided' ||
    containsControlCharacter(adminApiKey) ||
    userProvidedApiKey ||
    resolvedApiKey !== adminApiKey ||
    !hasOnlyKeys(llmConfig, SUPPORTED_LLM_CONFIG_KEYS) ||
    llmConfig.baseUrl !== undefined ||
    llmConfig.customHeaders !== undefined ||
    llmConfig._lc_stream_delay !== undefined ||
    !isValidModelId(llmConfig.model) ||
    modelParameters?.model !== llmConfig.model ||
    (modelParameters != null && !hasOnlyKeys(modelParameters, SUPPORTED_MODEL_PARAMETER_KEYS)) ||
    (configuredBaseURL != null && configuredBaseURL !== '') ||
    (reverseProxyURL != null && reverseProxyURL !== '') ||
    authHeader ||
    hasEntries(endpointHeaders) ||
    hasEntries(globalHeaders) ||
    (isRecord(allConfig) && allConfig.baseURL != null) ||
    !isAllowedEndpointModel(googleConfig, llmConfig.model) ||
    UNSUPPORTED_USAGE_MODELS.has(llmConfig.model) ||
    hasArrayEntries(initializeResult.tools) ||
    hasArrayEntries(llmConfig.tools) ||
    llmConfig.maxRetries !== 2 ||
    !isValidPositiveInteger(llmConfig.maxOutputTokens, 1_000_000) ||
    !isValidSafetySettings(llmConfig.safetySettings) ||
    !isValidThinkingConfig(llmConfig.thinkingConfig) ||
    proxy === undefined ||
    !isRecord(transport) ||
    !hasOnlyKeys(transport, new Set(['bodyTimeout', 'headersTimeout', 'proxy'])) ||
    transport.proxy !== expectedProxyURL
  ) {
    return undefined;
  }

  const temperature = llmConfig.temperature;
  const topP = llmConfig.topP;
  const topK = llmConfig.topK;
  if (
    (temperature !== undefined &&
      (typeof temperature !== 'number' ||
        !Number.isFinite(temperature) ||
        temperature < 0 ||
        temperature > 2)) ||
    (topP !== undefined &&
      (typeof topP !== 'number' || !Number.isFinite(topP) || topP < 0 || topP > 1)) ||
    (topK !== undefined &&
      (typeof topK !== 'number' || !Number.isSafeInteger(topK) || topK < 0 || topK > 1_000))
  ) {
    return undefined;
  }

  const stopSequences = resolveStopSequences(llmConfig.stopSequences);
  if (stopSequences === null) {
    return undefined;
  }
  if (
    typeof transport.bodyTimeout !== 'number' ||
    !Number.isSafeInteger(transport.bodyTimeout) ||
    transport.bodyTimeout < 0 ||
    transport.bodyTimeout > 86_400_000 ||
    typeof transport.headersTimeout !== 'number' ||
    !Number.isSafeInteger(transport.headersTimeout) ||
    transport.headersTimeout < 0 ||
    transport.headersTimeout > 86_400_000
  ) {
    return undefined;
  }

  return {
    source: 'server-admin-config',
    provider: 'google',
    api: GOOGLE_GENERATIVE_AI_API,
    baseUrl: GOOGLE_GENERATIVE_BASE_URL,
    modelId: llmConfig.model,
    serverAdminApiKey: adminApiKey,
    transport: {
      bodyTimeout: transport.bodyTimeout,
      headersTimeout: transport.headersTimeout,
      proxy,
    },
    generation: {
      maxOutputTokens: llmConfig.maxOutputTokens,
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { topP }),
      ...(topK === undefined ? {} : { topK }),
      ...(stopSequences === undefined ? {} : { stopSequences }),
      ...(llmConfig.safetySettings === undefined
        ? {}
        : { safetySettings: llmConfig.safetySettings }),
      ...(llmConfig.thinkingConfig === undefined
        ? {}
        : { thinkingConfig: llmConfig.thinkingConfig }),
    },
  };
}
