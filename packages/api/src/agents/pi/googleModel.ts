import type { CreateModelRuntimeOptions, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Api, CredentialStore, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { PiModelBinding } from './session';
import { createPiGoogleGateway, type PiGoogleProxy, type PiGoogleTransport } from './googleGateway';

export const PI_GOOGLE_PROVIDER_ID = 'librechat-google' as const;
export const GOOGLE_GENERATIVE_AI_API = 'google-generative-ai' as const;
export const GOOGLE_GENERATIVE_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta' as const;

const CANDIDATE_SOURCE = 'server-admin-config' as const;
const MAX_MODEL_ID_LENGTH = 128;
const MAX_TRANSPORT_TIMEOUT_MS = 86_400_000;
const MAX_OUTPUT_TOKENS = 1_000_000;
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

const ERROR_MESSAGES = {
  INVALID_CANDIDATE: 'The authorized Google model candidate is invalid.',
  UNSUPPORTED_MODEL: 'The selected Google model is not supported by this runtime.',
  RUNTIME_UNAVAILABLE: 'The Pi Google model runtime is unavailable.',
  CLEANUP_FAILED: 'The Pi Google model runtime could not be fully cleaned up.',
} as const;

export type PiGoogleModelBindingErrorCode = keyof typeof ERROR_MESSAGES;

export interface AuthorizedPiGoogleModelCandidate {
  readonly source: typeof CANDIDATE_SOURCE;
  readonly provider: 'google';
  readonly api: typeof GOOGLE_GENERATIVE_AI_API;
  readonly baseUrl: typeof GOOGLE_GENERATIVE_BASE_URL;
  readonly modelId: string;
  readonly serverAdminApiKey: string;
  readonly transport: PiGoogleTransport;
  readonly generation: {
    readonly maxOutputTokens: number;
    readonly temperature?: number;
    readonly topP?: number;
    readonly topK?: number;
    readonly stopSequences?: readonly string[];
    readonly safetySettings?: readonly { readonly category: string; readonly threshold: string }[];
    readonly thinkingConfig?: {
      readonly includeThoughts?: boolean;
      readonly thinkingBudget?: number;
      readonly thinkingLevel?: string;
    };
  };
}

export interface PiGoogleModelBindingDependencies {
  createCredentialStore?: () => CredentialStore | Promise<CredentialStore>;
  createRuntime?: (options: CreateModelRuntimeOptions) => Promise<ModelRuntime>;
  resolveCatalogModel?: (runtime: ModelRuntime, modelId: string) => Model<Api> | undefined;
  /** Test seam: the production gateway always targets the fixed Google API origin. */
  rewriteUpstreamUrlForTest?: (url: URL) => URL;
  disposeRuntime?: (runtime: ModelRuntime) => void | Promise<void>;
}

export class PiGoogleModelBindingError extends Error {
  readonly code: PiGoogleModelBindingErrorCode;

  constructor(code: PiGoogleModelBindingErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'PiGoogleModelBindingError';
    this.code = code;
  }
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

function validateProxy(value: unknown): PiGoogleProxy {
  if (!isRecord(value)) {
    throw new PiGoogleModelBindingError('INVALID_CANDIDATE');
  }
  if (value.kind === 'direct' && hasOnlyKeys(value, new Set(['kind']))) {
    return { kind: 'direct' };
  }
  if (
    value.kind !== 'proxy' ||
    !hasOnlyKeys(value, new Set(['kind', 'url'])) ||
    typeof value.url !== 'string' ||
    value.url.length > 2_048
  ) {
    throw new PiGoogleModelBindingError('INVALID_CANDIDATE');
  }

  const proxyUrl = value.url.trim();
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new PiGoogleModelBindingError('INVALID_CANDIDATE');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new PiGoogleModelBindingError('INVALID_CANDIDATE');
  }
  return { kind: 'proxy', url: proxyUrl };
}

function validateThinkingConfig(
  value: unknown,
): AuthorizedPiGoogleModelCandidate['generation']['thinkingConfig'] {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, new Set(['includeThoughts', 'thinkingBudget', 'thinkingLevel'])) ||
    (value.includeThoughts !== undefined && typeof value.includeThoughts !== 'boolean')
  ) {
    throw new PiGoogleModelBindingError('INVALID_CANDIDATE');
  }

  const hasBudget = value.thinkingBudget !== undefined;
  const hasLevel = value.thinkingLevel !== undefined;
  if (
    (hasBudget && hasLevel) ||
    (value.includeThoughts === undefined && !hasBudget && !hasLevel) ||
    (hasBudget &&
      (typeof value.thinkingBudget !== 'number' ||
        !Number.isSafeInteger(value.thinkingBudget) ||
        value.thinkingBudget < -1 ||
        value.thinkingBudget > 65_536)) ||
    (hasLevel &&
      !['THINKING_LEVEL_UNSPECIFIED', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH'].includes(
        String(value.thinkingLevel),
      ))
  ) {
    throw new PiGoogleModelBindingError('INVALID_CANDIDATE');
  }
  return {
    ...(value.includeThoughts === undefined ? {} : { includeThoughts: value.includeThoughts }),
    ...(hasBudget ? { thinkingBudget: value.thinkingBudget as number } : {}),
    ...(hasLevel ? { thinkingLevel: value.thinkingLevel as string } : {}),
  };
}

function validateCandidate(candidate: unknown): AuthorizedPiGoogleModelCandidate {
  if (
    !isRecord(candidate) ||
    !hasOnlyKeys(
      candidate,
      new Set([
        'source',
        'provider',
        'api',
        'baseUrl',
        'modelId',
        'serverAdminApiKey',
        'transport',
        'generation',
      ]),
    ) ||
    candidate.source !== CANDIDATE_SOURCE ||
    candidate.provider !== 'google' ||
    candidate.api !== GOOGLE_GENERATIVE_AI_API ||
    candidate.baseUrl !== GOOGLE_GENERATIVE_BASE_URL ||
    typeof candidate.modelId !== 'string' ||
    candidate.modelId.length === 0 ||
    candidate.modelId.length > MAX_MODEL_ID_LENGTH ||
    !/^[A-Za-z0-9._-]+$/u.test(candidate.modelId) ||
    typeof candidate.serverAdminApiKey !== 'string' ||
    candidate.serverAdminApiKey.trim().length === 0 ||
    candidate.serverAdminApiKey === 'user_provided' ||
    containsControlCharacter(candidate.serverAdminApiKey) ||
    !isRecord(candidate.transport) ||
    !hasOnlyKeys(candidate.transport, new Set(['bodyTimeout', 'headersTimeout', 'proxy'])) ||
    typeof candidate.transport.bodyTimeout !== 'number' ||
    !Number.isSafeInteger(candidate.transport.bodyTimeout) ||
    candidate.transport.bodyTimeout < 0 ||
    candidate.transport.bodyTimeout > MAX_TRANSPORT_TIMEOUT_MS ||
    typeof candidate.transport.headersTimeout !== 'number' ||
    !Number.isSafeInteger(candidate.transport.headersTimeout) ||
    candidate.transport.headersTimeout < 0 ||
    candidate.transport.headersTimeout > MAX_TRANSPORT_TIMEOUT_MS ||
    !isRecord(candidate.generation) ||
    !hasOnlyKeys(
      candidate.generation,
      new Set([
        'maxOutputTokens',
        'temperature',
        'topP',
        'topK',
        'stopSequences',
        'safetySettings',
        'thinkingConfig',
      ]),
    )
  ) {
    throw new PiGoogleModelBindingError('INVALID_CANDIDATE');
  }

  const proxy = validateProxy(candidate.transport.proxy);
  const generation = candidate.generation;
  const temperature = generation.temperature;
  const topP = generation.topP;
  const topK = generation.topK;
  if (
    typeof generation.maxOutputTokens !== 'number' ||
    !Number.isSafeInteger(generation.maxOutputTokens) ||
    generation.maxOutputTokens < 1 ||
    generation.maxOutputTokens > MAX_OUTPUT_TOKENS ||
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
    throw new PiGoogleModelBindingError('INVALID_CANDIDATE');
  }

  let stopSequences: readonly string[] | undefined;
  if (generation.stopSequences !== undefined) {
    if (
      !Array.isArray(generation.stopSequences) ||
      generation.stopSequences.length === 0 ||
      generation.stopSequences.length > 5 ||
      !generation.stopSequences.every(
        (entry) =>
          typeof entry === 'string' &&
          entry.length > 0 &&
          entry.length <= 256 &&
          !containsControlCharacter(entry),
      )
    ) {
      throw new PiGoogleModelBindingError('INVALID_CANDIDATE');
    }
    stopSequences = [...generation.stopSequences];
  }

  let safetySettings: AuthorizedPiGoogleModelCandidate['generation']['safetySettings'];
  if (generation.safetySettings !== undefined) {
    const categories = new Set<string>();
    if (
      !Array.isArray(generation.safetySettings) ||
      generation.safetySettings.length !== GOOGLE_SAFETY_CATEGORIES.size ||
      !generation.safetySettings.every((setting) => {
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
      })
    ) {
      throw new PiGoogleModelBindingError('INVALID_CANDIDATE');
    }
    safetySettings = generation.safetySettings.map((setting) => ({ ...setting }));
  }

  const thinkingConfig = validateThinkingConfig(generation.thinkingConfig);
  return {
    source: CANDIDATE_SOURCE,
    provider: 'google',
    api: GOOGLE_GENERATIVE_AI_API,
    baseUrl: GOOGLE_GENERATIVE_BASE_URL,
    modelId: candidate.modelId,
    serverAdminApiKey: candidate.serverAdminApiKey,
    transport: {
      bodyTimeout: candidate.transport.bodyTimeout,
      headersTimeout: candidate.transport.headersTimeout,
      proxy,
    },
    generation: {
      maxOutputTokens: generation.maxOutputTokens,
      ...(temperature === undefined ? {} : { temperature }),
      ...(topP === undefined ? {} : { topP }),
      ...(topK === undefined ? {} : { topK }),
      ...(stopSequences === undefined ? {} : { stopSequences }),
      ...(safetySettings === undefined ? {} : { safetySettings }),
      ...(thinkingConfig === undefined ? {} : { thinkingConfig }),
    },
  };
}

function isSupportedGoogleCatalogModel(
  model: Model<Api> | undefined,
  modelId: string,
): model is Model<typeof GOOGLE_GENERATIVE_AI_API> {
  return (
    model !== undefined &&
    model.id === modelId &&
    model.provider === 'google' &&
    model.api === GOOGLE_GENERATIVE_AI_API &&
    model.baseUrl === GOOGLE_GENERATIVE_BASE_URL &&
    model.input.includes('text') &&
    Number.isSafeInteger(model.contextWindow) &&
    model.contextWindow > 0 &&
    Number.isSafeInteger(model.maxTokens) &&
    model.maxTokens > 0
  );
}

function isBoundGoogleModel(
  model: Model<Api> | undefined,
  providerId: string,
  baseUrl: string,
): model is Model<typeof GOOGLE_GENERATIVE_AI_API> {
  return (
    model !== undefined &&
    model.api === GOOGLE_GENERATIVE_AI_API &&
    model.provider === providerId &&
    model.baseUrl === baseUrl
  );
}

const ALLOWED_STREAM_OPTION_KEYS = new Set([
  'apiKey',
  'headers',
  'env',
  'signal',
  'identity',
  'maxRetries',
  'maxRetryDelayMs',
  'temperature',
  'maxTokens',
  'reasoning',
  'thinkingBudgets',
  'toolChoice',
  'onPayload',
  'onResponse',
  'onProviderStreamEvent',
  'telemetry',
  'samplingParams',
  'transport',
  'cacheRetention',
  'sessionId',
  'timeoutMs',
  'websocketConnectTimeoutMs',
  'deferred',
  'metadata',
  'fetch',
]);

const ALLOWED_GOOGLE_PAYLOAD_KEYS = new Set(['model', 'contents', 'config']);
const ALLOWED_GOOGLE_CONFIG_KEYS = new Set([
  'maxOutputTokens',
  'temperature',
  'systemInstruction',
  'tools',
  'toolConfig',
  'thinkingConfig',
  'abortSignal',
]);

function validateRequestOptions(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  candidate: AuthorizedPiGoogleModelCandidate,
  gatewayApiKey: string,
  gatewayBaseUrl: string,
): asserts options is SimpleStreamOptions {
  if (options === undefined) {
    return;
  }
  const unparsedOptions: unknown = options;
  if (
    !isRecord(unparsedOptions) ||
    !hasOnlyKeys(unparsedOptions, ALLOWED_STREAM_OPTION_KEYS) ||
    options.apiKey !== gatewayApiKey ||
    hasEntries(options.headers) ||
    hasEntries(options.env) ||
    (options.samplingParams !== undefined && hasEntries(options.samplingParams)) ||
    options.transport !== undefined ||
    options.cacheRetention !== undefined ||
    options.sessionId !== undefined ||
    options.timeoutMs !== undefined ||
    options.websocketConnectTimeoutMs !== undefined ||
    options.deferred !== undefined ||
    hasEntries(options.metadata) ||
    options.fetch !== undefined ||
    options.onPayload !== undefined ||
    (options.maxRetries !== undefined && options.maxRetries !== 2) ||
    options.maxRetryDelayMs !== undefined ||
    (options.temperature !== undefined &&
      options.temperature !== candidate.generation.temperature) ||
    (options.maxTokens !== undefined &&
      (!Number.isSafeInteger(options.maxTokens) ||
        options.maxTokens < 1 ||
        options.maxTokens > candidate.generation.maxOutputTokens)) ||
    (options.reasoning !== undefined &&
      !isCompatibleReasoning(model, options.reasoning, candidate)) ||
    (options.thinkingBudgets !== undefined && hasEntries(options.thinkingBudgets)) ||
    (options.toolChoice !== undefined && options.toolChoice !== 'auto') ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal)) ||
    !isBoundGoogleModel(model, PI_GOOGLE_PROVIDER_ID, gatewayBaseUrl)
  ) {
    throw new PiGoogleModelBindingError('UNSUPPORTED_MODEL');
  }
}

function isCompatibleReasoning(
  model: Model<Api>,
  reasoning: NonNullable<SimpleStreamOptions['reasoning']>,
  candidate: AuthorizedPiGoogleModelCandidate,
): boolean {
  const expectedLevel = candidate.generation.thinkingConfig?.thinkingLevel;
  if (expectedLevel === undefined) {
    return false;
  }
  // Don't silently downgrade an unsupported level to a different model setting.
  const mappedLevel = model.thinkingLevelMap?.[reasoning] ?? reasoning;
  return (
    mappedLevel !== 'off' &&
    typeof mappedLevel === 'string' &&
    mappedLevel.toLowerCase() === expectedLevel.toLowerCase()
  );
}

function mapGooglePayload(
  payload: unknown,
  candidate: AuthorizedPiGoogleModelCandidate,
  signal: AbortSignal | undefined,
): unknown {
  if (
    !isRecord(payload) ||
    !hasOnlyKeys(payload, ALLOWED_GOOGLE_PAYLOAD_KEYS) ||
    payload.model !== candidate.modelId ||
    !Array.isArray(payload.contents) ||
    !isRecord(payload.config) ||
    !hasOnlyKeys(payload.config, ALLOWED_GOOGLE_CONFIG_KEYS) ||
    !Number.isSafeInteger(payload.config.maxOutputTokens) ||
    typeof payload.config.maxOutputTokens !== 'number' ||
    payload.config.maxOutputTokens < 1 ||
    payload.config.maxOutputTokens > candidate.generation.maxOutputTokens ||
    (candidate.generation.temperature === undefined
      ? payload.config.temperature !== undefined
      : payload.config.temperature !== candidate.generation.temperature) ||
    (signal === undefined
      ? payload.config.abortSignal !== undefined
      : payload.config.abortSignal !== signal)
  ) {
    throw new PiGoogleModelBindingError('UNSUPPORTED_MODEL');
  }

  const config: Record<string, unknown> = { ...payload.config };
  delete config.thinkingConfig;
  delete config.topP;
  delete config.topK;
  delete config.stopSequences;
  delete config.safetySettings;

  if (candidate.generation.thinkingConfig !== undefined) {
    config.thinkingConfig = { ...candidate.generation.thinkingConfig };
  }
  if (candidate.generation.topP !== undefined) {
    config.topP = candidate.generation.topP;
  }
  if (candidate.generation.topK !== undefined) {
    config.topK = candidate.generation.topK;
  }
  if (candidate.generation.stopSequences !== undefined) {
    config.stopSequences = [...candidate.generation.stopSequences];
  }
  if (candidate.generation.safetySettings !== undefined) {
    config.safetySettings = candidate.generation.safetySettings.map((setting) => ({ ...setting }));
  }
  return { model: candidate.modelId, contents: payload.contents, config };
}

async function createDefaultCredentialStore(): Promise<CredentialStore> {
  const { InMemoryCredentialStore } = await import('@earendil-works/pi-ai');
  return new InMemoryCredentialStore();
}

async function createDefaultRuntime(options: CreateModelRuntimeOptions): Promise<ModelRuntime> {
  const { ModelRuntime: PiModelRuntime } = await import('@earendil-works/pi-coding-agent');
  return PiModelRuntime.create(options);
}

async function cleanupRuntime(
  runtime: ModelRuntime | undefined,
  credentialStore: CredentialStore | undefined,
  disposeGateway: (() => Promise<void>) | undefined,
  dependencies: PiGoogleModelBindingDependencies,
): Promise<boolean> {
  let failed = false;
  if (runtime !== undefined) {
    try {
      await runtime.removeRuntimeApiKey(PI_GOOGLE_PROVIDER_ID);
    } catch {
      failed = true;
    }
    try {
      runtime.unregisterProvider(PI_GOOGLE_PROVIDER_ID);
    } catch {
      failed = true;
    }
    try {
      await dependencies.disposeRuntime?.(runtime);
    } catch {
      failed = true;
    }
  }
  if (credentialStore !== undefined) {
    try {
      await credentialStore.delete(PI_GOOGLE_PROVIDER_ID);
    } catch {
      failed = true;
    }
  }
  if (disposeGateway !== undefined) {
    try {
      await disposeGateway();
    } catch {
      failed = true;
    }
  }
  return failed;
}

/** Creates one loopback gateway, Pi runtime and credential scope for one generation. */
export async function createPiGoogleModelBinding(
  candidateInput: unknown,
  dependencies: PiGoogleModelBindingDependencies = {},
): Promise<PiModelBinding> {
  const candidate = validateCandidate(candidateInput);
  let credentialStore: CredentialStore | undefined;
  let runtime: ModelRuntime | undefined;
  let disposeGateway: (() => Promise<void>) | undefined;

  try {
    credentialStore = await (dependencies.createCredentialStore?.() ??
      createDefaultCredentialStore());
    runtime = await (dependencies.createRuntime?.({
      credentials: credentialStore,
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    }) ??
      createDefaultRuntime({
        credentials: credentialStore,
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
      }));

    const catalogModel = (
      dependencies.resolveCatalogModel ??
      ((targetRuntime, modelId) => targetRuntime.getModel('google', modelId))
    )(runtime, candidate.modelId);
    if (
      !isSupportedGoogleCatalogModel(catalogModel, candidate.modelId) ||
      candidate.generation.maxOutputTokens > catalogModel.maxTokens ||
      hasEntries(catalogModel.headers) ||
      hasEntries(catalogModel.samplingParams) ||
      hasEntries(catalogModel.samplingParamsByThinkingLevel) ||
      (candidate.generation.thinkingConfig !== undefined && !catalogModel.reasoning) ||
      candidate.modelId === 'gemini-3-pro-preview'
    ) {
      throw new PiGoogleModelBindingError('UNSUPPORTED_MODEL');
    }

    const gateway = await createPiGoogleGateway({
      modelId: candidate.modelId,
      serverAdminApiKey: candidate.serverAdminApiKey,
      transport: candidate.transport,
      rewriteUpstreamUrlForTest: dependencies.rewriteUpstreamUrlForTest,
    });
    disposeGateway = gateway.dispose;

    const boundModel = {
      id: catalogModel.id,
      name: catalogModel.name,
      api: GOOGLE_GENERATIVE_AI_API,
      provider: PI_GOOGLE_PROVIDER_ID,
      baseUrl: gateway.baseUrl,
      input: [...catalogModel.input],
      ...(catalogModel.inputLimits === undefined ? {} : { inputLimits: catalogModel.inputLimits }),
      cost: { ...catalogModel.cost },
      reasoning: catalogModel.reasoning,
      ...(catalogModel.thinkingLevelMap === undefined
        ? {}
        : { thinkingLevelMap: { ...catalogModel.thinkingLevelMap } }),
      contextWindow: catalogModel.contextWindow,
      maxTokens: candidate.generation.maxOutputTokens,
    } satisfies Model<typeof GOOGLE_GENERATIVE_AI_API>;

    const { streamSimple: googleStreamSimple } = await import(
      '@earendil-works/pi-ai/api/google-generative-ai'
    );
    runtime.registerProvider(PI_GOOGLE_PROVIDER_ID, {
      name: 'Google',
      api: GOOGLE_GENERATIVE_AI_API,
      baseUrl: gateway.baseUrl,
      streamSimple: (model, context, options) => {
        if (!isBoundGoogleModel(model, PI_GOOGLE_PROVIDER_ID, gateway.baseUrl)) {
          throw new PiGoogleModelBindingError('UNSUPPORTED_MODEL');
        }
        validateRequestOptions(model, options, candidate, gateway.apiKey, gateway.baseUrl);
        const incomingOptions = options ?? {};
        const requestOptions: SimpleStreamOptions = {
          apiKey: gateway.apiKey,
          maxTokens: candidate.generation.maxOutputTokens,
          ...(candidate.generation.temperature === undefined
            ? {}
            : { temperature: candidate.generation.temperature }),
          ...(incomingOptions.toolChoice === undefined
            ? {}
            : { toolChoice: incomingOptions.toolChoice }),
          ...(incomingOptions.signal === undefined ? {} : { signal: incomingOptions.signal }),
          ...(incomingOptions.identity === undefined ? {} : { identity: incomingOptions.identity }),
          ...(incomingOptions.telemetry === undefined
            ? {}
            : { telemetry: incomingOptions.telemetry }),
          ...(incomingOptions.onResponse === undefined
            ? {}
            : { onResponse: incomingOptions.onResponse }),
          ...(incomingOptions.onProviderStreamEvent === undefined
            ? {}
            : { onProviderStreamEvent: incomingOptions.onProviderStreamEvent }),
          maxRetries: 2,
          onPayload: async (payload, payloadModel) => {
            if (payloadModel.id !== candidate.modelId || payloadModel.baseUrl !== gateway.baseUrl) {
              throw new PiGoogleModelBindingError('UNSUPPORTED_MODEL');
            }
            return mapGooglePayload(payload, candidate, incomingOptions.signal);
          },
        };
        return googleStreamSimple(model, context, requestOptions);
      },
      models: [boundModel],
    });
    await runtime.setRuntimeApiKey(PI_GOOGLE_PROVIDER_ID, gateway.apiKey);

    const runtimeModel = runtime.getModel(PI_GOOGLE_PROVIDER_ID, candidate.modelId);
    if (!isBoundGoogleModel(runtimeModel, PI_GOOGLE_PROVIDER_ID, gateway.baseUrl)) {
      throw new PiGoogleModelBindingError('UNSUPPORTED_MODEL');
    }

    let disposed = false;
    return {
      model: runtimeModel,
      modelRuntime: runtime,
      async dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        if (await cleanupRuntime(runtime, credentialStore, disposeGateway, dependencies)) {
          throw new PiGoogleModelBindingError('CLEANUP_FAILED');
        }
      },
    };
  } catch (error) {
    if (await cleanupRuntime(runtime, credentialStore, disposeGateway, dependencies)) {
      throw new PiGoogleModelBindingError('CLEANUP_FAILED');
    }
    if (error instanceof PiGoogleModelBindingError) {
      throw error;
    }
    throw new PiGoogleModelBindingError('RUNTIME_UNAVAILABLE');
  }
}
