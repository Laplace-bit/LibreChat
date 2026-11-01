import { Agent, ProxyAgent } from 'undici';
import { fetch as undiciFetch } from 'undici';
import { THINKING_BINDING_BETA, bindsThinkingBlocks } from 'librechat-data-provider';
import type {
  AnthropicEffort,
  AnthropicOptions,
  Api,
  CredentialStore,
  Model,
} from '@earendil-works/pi-ai';
import type { CreateModelRuntimeOptions, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { PiModelBinding } from './session';
import {
  FINE_GRAINED_TOOL_STREAMING_BETA,
  appendAnthropicBetaHeader,
  checkPromptCacheSupport,
  getClaudeHeaders,
} from '~/endpoints/anthropic/helpers';

export const PI_ANTHROPIC_PROVIDER_ID = 'librechat-anthropic' as const;
export const ANTHROPIC_MESSAGES_API = 'anthropic-messages' as const;
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com' as const;

const CANDIDATE_SOURCE = 'server-admin-config' as const;
const MAX_MODEL_ID_LENGTH = 128;
const MAX_TRANSPORT_TIMEOUT_MS = 86_400_000;
const MAX_OUTPUT_TOKENS = 1_000_000;

const ERROR_MESSAGES = {
  INVALID_CANDIDATE: 'The authorized Anthropic model candidate is invalid.',
  UNSUPPORTED_MODEL: 'The selected Anthropic model is not supported by this runtime.',
  RUNTIME_UNAVAILABLE: 'The Pi Anthropic model runtime is unavailable.',
  CLEANUP_FAILED: 'The Pi Anthropic model runtime could not be fully cleaned up.',
} as const;

export type PiAnthropicModelBindingErrorCode = keyof typeof ERROR_MESSAGES;

export type PiAnthropicProxy =
  | { readonly kind: 'direct' }
  | { readonly kind: 'proxy'; readonly url: string };

export interface PiAnthropicTransport {
  readonly bodyTimeout: number;
  readonly headersTimeout: number;
  readonly proxy: PiAnthropicProxy;
}

export type PiAnthropicThinkingDisplay = 'summarized' | 'omitted';

export type PiAnthropicThinking =
  | { readonly kind: 'disabled' }
  | {
      readonly kind: 'budget';
      readonly budgetTokens: number;
      readonly display?: PiAnthropicThinkingDisplay;
    }
  | {
      readonly kind: 'adaptive';
      readonly effort?: AnthropicEffort;
      readonly display?: PiAnthropicThinkingDisplay;
    };

export type PiAnthropicCacheRetention = 'none' | 'short' | 'long';

export interface AuthorizedPiAnthropicModelCandidate {
  readonly source: typeof CANDIDATE_SOURCE;
  readonly provider: 'anthropic';
  readonly api: typeof ANTHROPIC_MESSAGES_API;
  readonly baseUrl: typeof ANTHROPIC_BASE_URL;
  readonly modelId: string;
  readonly serverAdminApiKey: string;
  readonly requestUserId: string;
  readonly transport: PiAnthropicTransport;
  readonly generation: {
    readonly maxTokens: number;
    readonly temperature?: number;
    readonly topP?: number;
    readonly topK?: number;
    readonly stopSequences?: readonly string[];
    readonly thinking: PiAnthropicThinking;
    readonly cacheRetention: PiAnthropicCacheRetention;
    readonly anthropicBetaHeader?: string;
  };
}

export interface PiAnthropicModelBindingDependencies {
  createCredentialStore?: () => CredentialStore | Promise<CredentialStore>;
  createRuntime?: (options: CreateModelRuntimeOptions) => Promise<ModelRuntime>;
  resolveCatalogModel?: (runtime: ModelRuntime, modelId: string) => Model<Api> | undefined;
  /** Test seam that may rewrite a previously verified canonical URL to a local HTTP server. */
  rewriteRequestUrlForTest?: (url: URL) => URL;
  disposeRuntime?: (runtime: ModelRuntime) => void | Promise<void>;
}

export class PiAnthropicModelBindingError extends Error {
  readonly code: PiAnthropicModelBindingErrorCode;

  constructor(code: PiAnthropicModelBindingErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'PiAnthropicModelBindingError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
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

function isThinkingDisplay(value: unknown): value is PiAnthropicThinkingDisplay {
  return value === 'summarized' || value === 'omitted';
}

function isAnthropicEffort(value: unknown): value is AnthropicEffort {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  );
}

function expectedAnthropicBetaHeader(
  modelId: string,
  cacheRetention: PiAnthropicCacheRetention,
): string {
  const cacheHeaders = getClaudeHeaders(
    modelId,
    cacheRetention !== 'none' && checkPromptCacheSupport(modelId),
  );
  const providerHeaders = appendAnthropicBetaHeader(
    cacheHeaders,
    bindsThinkingBlocks(modelId) ? THINKING_BINDING_BETA : FINE_GRAINED_TOOL_STREAMING_BETA,
  );
  return providerHeaders['anthropic-beta'];
}

function validateTransport(value: unknown): PiAnthropicTransport {
  if (!isRecord(value) || !hasOnlyKeys(value, ['bodyTimeout', 'headersTimeout', 'proxy'])) {
    throw new PiAnthropicModelBindingError('INVALID_CANDIDATE');
  }
  const { bodyTimeout, headersTimeout, proxy } = value;
  if (
    typeof bodyTimeout !== 'number' ||
    !Number.isSafeInteger(bodyTimeout) ||
    bodyTimeout < 0 ||
    bodyTimeout > MAX_TRANSPORT_TIMEOUT_MS ||
    typeof headersTimeout !== 'number' ||
    !Number.isSafeInteger(headersTimeout) ||
    headersTimeout < 0 ||
    headersTimeout > MAX_TRANSPORT_TIMEOUT_MS
  ) {
    throw new PiAnthropicModelBindingError('INVALID_CANDIDATE');
  }

  if (!isRecord(proxy)) {
    throw new PiAnthropicModelBindingError('INVALID_CANDIDATE');
  }
  let validatedProxy: PiAnthropicProxy;
  if (proxy.kind === 'direct' && hasOnlyKeys(proxy, ['kind'])) {
    validatedProxy = { kind: 'direct' };
  } else if (
    proxy.kind === 'proxy' &&
    hasOnlyKeys(proxy, ['kind', 'url']) &&
    typeof proxy.url === 'string' &&
    proxy.url.length <= 2048
  ) {
    const trimmedProxy = proxy.url.trim();
    let parsedProxy: URL;
    try {
      parsedProxy = new URL(trimmedProxy);
    } catch {
      throw new PiAnthropicModelBindingError('INVALID_CANDIDATE');
    }
    if (
      !['http:', 'https:', 'socks:', 'socks5:'].includes(parsedProxy.protocol) ||
      !parsedProxy.hostname ||
      (parsedProxy.pathname !== '' && parsedProxy.pathname !== '/') ||
      parsedProxy.search !== '' ||
      parsedProxy.hash !== ''
    ) {
      throw new PiAnthropicModelBindingError('INVALID_CANDIDATE');
    }
    validatedProxy = { kind: 'proxy', url: trimmedProxy };
  } else {
    throw new PiAnthropicModelBindingError('INVALID_CANDIDATE');
  }

  return {
    bodyTimeout,
    headersTimeout,
    proxy: validatedProxy,
  };
}

function validateThinking(value: unknown): PiAnthropicThinking {
  if (!isRecord(value)) {
    throw new PiAnthropicModelBindingError('INVALID_CANDIDATE');
  }
  const display = value.display;
  if (display !== undefined && !isThinkingDisplay(display)) {
    throw new PiAnthropicModelBindingError('INVALID_CANDIDATE');
  }
  const displayOption = display === undefined ? {} : { display };
  if (value.effort !== undefined && !isAnthropicEffort(value.effort)) {
    throw new PiAnthropicModelBindingError('INVALID_CANDIDATE');
  }

  if (value.kind === 'disabled' && hasOnlyKeys(value, ['kind'])) {
    return { kind: 'disabled' };
  }
  if (value.kind === 'budget' && hasOnlyKeys(value, ['kind', 'budgetTokens', 'display'])) {
    if (
      typeof value.budgetTokens !== 'number' ||
      !Number.isSafeInteger(value.budgetTokens) ||
      value.budgetTokens < 1_024 ||
      value.budgetTokens > MAX_OUTPUT_TOKENS
    ) {
      throw new PiAnthropicModelBindingError('INVALID_CANDIDATE');
    }
    return { kind: 'budget', budgetTokens: value.budgetTokens, ...displayOption };
  }
  if (value.kind === 'adaptive' && hasOnlyKeys(value, ['kind', 'effort', 'display'])) {
    return {
      kind: 'adaptive',
      ...displayOption,
      ...(value.effort === undefined ? {} : { effort: value.effort }),
    };
  }
  throw new PiAnthropicModelBindingError('INVALID_CANDIDATE');
}

function validateCandidate(value: unknown): AuthorizedPiAnthropicModelCandidate {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'source',
      'provider',
      'api',
      'baseUrl',
      'modelId',
      'serverAdminApiKey',
      'requestUserId',
      'transport',
      'generation',
    ])
  ) {
    throw new PiAnthropicModelBindingError('INVALID_CANDIDATE');
  }
  const { source, provider, api, baseUrl, modelId, serverAdminApiKey, requestUserId } = value;
  if (
    source !== CANDIDATE_SOURCE ||
    provider !== 'anthropic' ||
    api !== ANTHROPIC_MESSAGES_API ||
    baseUrl !== ANTHROPIC_BASE_URL ||
    typeof modelId !== 'string' ||
    modelId.length === 0 ||
    modelId.length > MAX_MODEL_ID_LENGTH ||
    !/^[A-Za-z0-9._:-]+$/u.test(modelId) ||
    typeof serverAdminApiKey !== 'string' ||
    serverAdminApiKey.trim().length === 0 ||
    containsControlCharacter(serverAdminApiKey) ||
    typeof requestUserId !== 'string' ||
    requestUserId.trim().length === 0 ||
    requestUserId.length > 256 ||
    containsControlCharacter(requestUserId)
  ) {
    throw new PiAnthropicModelBindingError('INVALID_CANDIDATE');
  }

  const transport = validateTransport(value.transport);
  if (
    !isRecord(value.generation) ||
    !hasOnlyKeys(value.generation, [
      'maxTokens',
      'temperature',
      'topP',
      'topK',
      'stopSequences',
      'thinking',
      'cacheRetention',
      'anthropicBetaHeader',
    ])
  ) {
    throw new PiAnthropicModelBindingError('INVALID_CANDIDATE');
  }
  const generation = value.generation;
  if (
    typeof generation.maxTokens !== 'number' ||
    !Number.isSafeInteger(generation.maxTokens) ||
    generation.maxTokens < 1 ||
    generation.maxTokens > MAX_OUTPUT_TOKENS ||
    (generation.temperature !== undefined &&
      (typeof generation.temperature !== 'number' ||
        !Number.isFinite(generation.temperature) ||
        generation.temperature < 0 ||
        generation.temperature > 1)) ||
    (generation.topP !== undefined &&
      (typeof generation.topP !== 'number' ||
        !Number.isFinite(generation.topP) ||
        generation.topP <= 0 ||
        generation.topP > 1)) ||
    (generation.topK !== undefined &&
      (typeof generation.topK !== 'number' ||
        !Number.isSafeInteger(generation.topK) ||
        generation.topK < 1 ||
        generation.topK > 500)) ||
    (generation.cacheRetention !== 'none' &&
      generation.cacheRetention !== 'short' &&
      generation.cacheRetention !== 'long')
  ) {
    throw new PiAnthropicModelBindingError('INVALID_CANDIDATE');
  }

  let stopSequences: readonly string[] | undefined;
  if (generation.stopSequences !== undefined) {
    if (
      !Array.isArray(generation.stopSequences) ||
      generation.stopSequences.length === 0 ||
      generation.stopSequences.length > 16 ||
      !generation.stopSequences.every(
        (stopSequence) =>
          typeof stopSequence === 'string' &&
          stopSequence.length > 0 &&
          stopSequence.length <= 500 &&
          !containsControlCharacter(stopSequence),
      )
    ) {
      throw new PiAnthropicModelBindingError('INVALID_CANDIDATE');
    }
    stopSequences = [...generation.stopSequences];
  }

  const thinking = validateThinking(generation.thinking);
  const anthropicBetaHeader = expectedAnthropicBetaHeader(modelId, generation.cacheRetention);
  if (generation.anthropicBetaHeader !== anthropicBetaHeader) {
    throw new PiAnthropicModelBindingError('INVALID_CANDIDATE');
  }

  return {
    source,
    provider,
    api,
    baseUrl,
    modelId,
    serverAdminApiKey,
    requestUserId,
    transport,
    generation: {
      maxTokens: generation.maxTokens,
      ...(generation.temperature === undefined ? {} : { temperature: generation.temperature }),
      ...(generation.topP === undefined ? {} : { topP: generation.topP }),
      ...(generation.topK === undefined ? {} : { topK: generation.topK }),
      ...(stopSequences === undefined ? {} : { stopSequences }),
      thinking,
      cacheRetention: generation.cacheRetention,
      ...(anthropicBetaHeader === undefined ? {} : { anthropicBetaHeader }),
    },
  };
}

function isSupportedAnthropicCatalogModel(
  model: Model<Api> | undefined,
  modelId: string,
): model is Model<typeof ANTHROPIC_MESSAGES_API> {
  return (
    model !== undefined &&
    model.id === modelId &&
    model.provider === 'anthropic' &&
    model.api === ANTHROPIC_MESSAGES_API &&
    model.baseUrl === ANTHROPIC_BASE_URL &&
    Number.isSafeInteger(model.maxTokens) &&
    model.maxTokens > 0
  );
}

function isBoundAnthropicModel(
  model: Model<Api> | undefined,
): model is Model<typeof ANTHROPIC_MESSAGES_API> {
  return (
    model !== undefined &&
    model.api === ANTHROPIC_MESSAGES_API &&
    model.provider === PI_ANTHROPIC_PROVIDER_ID &&
    model.baseUrl === ANTHROPIC_BASE_URL
  );
}

function createTransportFetch(
  transport: PiAnthropicTransport,
  rewriteRequestUrlForTest?: (url: URL) => URL,
): { fetch: typeof globalThis.fetch; dispose: () => Promise<void> } {
  const timeouts = {
    bodyTimeout: transport.bodyTimeout,
    headersTimeout: transport.headersTimeout,
  };
  const dispatcher =
    transport.proxy.kind === 'proxy'
      ? new ProxyAgent({ uri: transport.proxy.url, ...timeouts })
      : new Agent(timeouts);

  const fetchWithDispatcher = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    let requestInput: string | URL;
    try {
      requestInput = typeof input === 'string' || input instanceof URL ? input : input.url;
      const canonicalUrl = new URL(requestInput);
      if (
        canonicalUrl.origin !== ANTHROPIC_BASE_URL ||
        canonicalUrl.protocol !== 'https:' ||
        canonicalUrl.pathname !== '/v1/messages' ||
        (canonicalUrl.search !== '' && canonicalUrl.search !== '?beta=true') ||
        canonicalUrl.hash !== '' ||
        canonicalUrl.username !== '' ||
        canonicalUrl.password !== ''
      ) {
        throw new PiAnthropicModelBindingError('UNSUPPORTED_MODEL');
      }
      requestInput =
        rewriteRequestUrlForTest === undefined
          ? canonicalUrl
          : rewriteRequestUrlForTest(canonicalUrl);
    } catch (error) {
      if (error instanceof PiAnthropicModelBindingError) {
        throw error;
      }
      throw new PiAnthropicModelBindingError('RUNTIME_UNAVAILABLE');
    }

    return (await undiciFetch(requestInput as unknown as Parameters<typeof undiciFetch>[0], {
      ...(init as unknown as Parameters<typeof undiciFetch>[1]),
      redirect: 'error',
      dispatcher,
    })) as unknown as Response;
  };

  return {
    fetch: Object.assign(fetchWithDispatcher, { preconnect: () => undefined }),
    async dispose() {
      await dispatcher.close();
    },
  };
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
  dependencies: PiAnthropicModelBindingDependencies,
  disposeTransport: (() => Promise<void>) | undefined,
): Promise<boolean> {
  let failed = false;
  if (runtime !== undefined) {
    try {
      await runtime.removeRuntimeApiKey(PI_ANTHROPIC_PROVIDER_ID);
    } catch {
      failed = true;
    }
    try {
      runtime.unregisterProvider(PI_ANTHROPIC_PROVIDER_ID);
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
      await credentialStore.delete(PI_ANTHROPIC_PROVIDER_ID);
    } catch {
      failed = true;
    }
  }
  if (disposeTransport !== undefined) {
    try {
      await disposeTransport();
    } catch {
      failed = true;
    }
  }
  return failed;
}

/** Creates an isolated Pi Anthropic runtime and credential scope for one generation. */
export async function createPiAnthropicModelBinding(
  candidateInput: unknown,
  dependencies: PiAnthropicModelBindingDependencies = {},
): Promise<PiModelBinding> {
  const candidate = validateCandidate(candidateInput);
  let credentialStore: CredentialStore | undefined;
  let runtime: ModelRuntime | undefined;
  let disposeTransport: (() => Promise<void>) | undefined;

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
      ((targetRuntime, modelId) => targetRuntime.getModel('anthropic', modelId))
    )(runtime, candidate.modelId);
    if (
      !isSupportedAnthropicCatalogModel(catalogModel, candidate.modelId) ||
      candidate.generation.maxTokens > catalogModel.maxTokens ||
      (catalogModel.headers !== undefined && Object.keys(catalogModel.headers).length > 0) ||
      hasEntries(catalogModel.samplingParams) ||
      hasArrayEntries(catalogModel.compat?.allowedFallbackModels)
    ) {
      throw new PiAnthropicModelBindingError('UNSUPPORTED_MODEL');
    }
    if (
      candidate.generation.cacheRetention !== 'none' &&
      catalogModel.promptCache?.short === undefined
    ) {
      throw new PiAnthropicModelBindingError('UNSUPPORTED_MODEL');
    }
    if (
      candidate.generation.cacheRetention === 'long' &&
      (catalogModel.promptCache?.long === undefined ||
        catalogModel.compat?.supportsLongCacheRetention !== true)
    ) {
      throw new PiAnthropicModelBindingError('UNSUPPORTED_MODEL');
    }

    const thinking = candidate.generation.thinking;
    if (
      (thinking.kind !== 'disabled' && !catalogModel.reasoning) ||
      (thinking.kind === 'adaptive' && catalogModel.compat?.forceAdaptiveThinking !== true) ||
      (thinking.kind === 'adaptive' &&
        catalogModel.compat?.supportsMidConvoEffort === true &&
        thinking.effort === undefined) ||
      (thinking.kind === 'budget' && catalogModel.compat?.forceAdaptiveThinking === true) ||
      (thinking.kind === 'disabled' &&
        catalogModel.reasoning &&
        catalogModel.thinkingLevelMap?.off === null)
    ) {
      throw new PiAnthropicModelBindingError('UNSUPPORTED_MODEL');
    }

    const boundModel: Model<typeof ANTHROPIC_MESSAGES_API> = {
      id: catalogModel.id,
      name: catalogModel.name,
      api: ANTHROPIC_MESSAGES_API,
      provider: PI_ANTHROPIC_PROVIDER_ID,
      baseUrl: ANTHROPIC_BASE_URL,
      input: [...catalogModel.input],
      ...(catalogModel.inputLimits === undefined ? {} : { inputLimits: catalogModel.inputLimits }),
      cost: { ...catalogModel.cost },
      reasoning: catalogModel.reasoning,
      ...(catalogModel.thinkingLevelMap === undefined
        ? {}
        : { thinkingLevelMap: { ...catalogModel.thinkingLevelMap } }),
      ...(catalogModel.promptCache === undefined
        ? {}
        : { promptCache: { ...catalogModel.promptCache } }),
      contextWindow: catalogModel.contextWindow,
      maxTokens: candidate.generation.maxTokens,
      ...(catalogModel.compat === undefined ? {} : { compat: catalogModel.compat }),
    };

    const transport = createTransportFetch(
      candidate.transport,
      dependencies.rewriteRequestUrlForTest,
    );
    disposeTransport = transport.dispose;
    const { stream: anthropicStream } = await import(
      '@earendil-works/pi-ai/api/anthropic-messages'
    );
    runtime.registerProvider(PI_ANTHROPIC_PROVIDER_ID, {
      name: 'Anthropic',
      api: ANTHROPIC_MESSAGES_API,
      baseUrl: ANTHROPIC_BASE_URL,
      streamSimple: (model, context, options) => {
        if (!isBoundAnthropicModel(model)) {
          throw new PiAnthropicModelBindingError('UNSUPPORTED_MODEL');
        }
        if (
          hasEntries(options?.headers) ||
          hasEntries(options?.samplingParams) ||
          options?.transport !== undefined ||
          options?.deferred !== undefined ||
          options?.toolChoice !== undefined ||
          hasEntries(options?.env) ||
          options?.timeoutMs !== undefined ||
          options?.apiKey !== candidate.serverAdminApiKey
        ) {
          throw new PiAnthropicModelBindingError('UNSUPPORTED_MODEL');
        }

        const incomingOptions = options ?? {};
        const requestOptions: AnthropicOptions = {
          ...(incomingOptions.signal === undefined ? {} : { signal: incomingOptions.signal }),
          ...(incomingOptions.telemetry === undefined
            ? {}
            : { telemetry: incomingOptions.telemetry }),
          ...(incomingOptions.onResponse === undefined
            ? {}
            : { onResponse: incomingOptions.onResponse }),
          ...(incomingOptions.onProviderStreamEvent === undefined
            ? {}
            : { onProviderStreamEvent: incomingOptions.onProviderStreamEvent }),
          onPayload: async (payload, payloadModel) => {
            if (!isRecord(payload)) {
              throw new PiAnthropicModelBindingError('UNSUPPORTED_MODEL');
            }
            const transformed = await incomingOptions.onPayload?.(payload, payloadModel);
            const effectivePayload = transformed ?? payload;
            if (
              !isRecord(effectivePayload) ||
              !hasOnlyKeys(effectivePayload, [
                'model',
                'messages',
                'max_tokens',
                'stream',
                'betas',
                'system',
                'tools',
                'thinking',
                'output_config',
                'metadata',
                'tool_choice',
                'stop_sequences',
                'temperature',
                'top_p',
                'top_k',
                'fallbacks',
              ])
            ) {
              throw new PiAnthropicModelBindingError('UNSUPPORTED_MODEL');
            }
            const protectedFields = [
              'model',
              'messages',
              'max_tokens',
              'metadata',
              'thinking',
              'output_config',
            ];
            if (
              protectedFields.some(
                (field) =>
                  JSON.stringify(effectivePayload[field]) !== JSON.stringify(payload[field]),
              )
            ) {
              throw new PiAnthropicModelBindingError('UNSUPPORTED_MODEL');
            }

            const fixedPayload: Record<string, unknown> = {
              ...effectivePayload,
              model: candidate.modelId,
              max_tokens: candidate.generation.maxTokens,
              metadata: { user_id: candidate.requestUserId },
            };
            if (candidate.generation.temperature === undefined) {
              if (
                JSON.stringify(effectivePayload.temperature) !== JSON.stringify(payload.temperature)
              ) {
                throw new PiAnthropicModelBindingError('UNSUPPORTED_MODEL');
              }
            } else {
              fixedPayload.temperature = candidate.generation.temperature;
            }
            if (candidate.generation.topP === undefined) {
              if (JSON.stringify(effectivePayload.top_p) !== JSON.stringify(payload.top_p)) {
                throw new PiAnthropicModelBindingError('UNSUPPORTED_MODEL');
              }
            } else {
              fixedPayload.top_p = candidate.generation.topP;
            }
            if (candidate.generation.topK === undefined) {
              if (JSON.stringify(effectivePayload.top_k) !== JSON.stringify(payload.top_k)) {
                throw new PiAnthropicModelBindingError('UNSUPPORTED_MODEL');
              }
            } else {
              fixedPayload.top_k = candidate.generation.topK;
            }
            if (candidate.generation.stopSequences === undefined) {
              if (
                JSON.stringify(effectivePayload.stop_sequences) !==
                JSON.stringify(payload.stop_sequences)
              ) {
                throw new PiAnthropicModelBindingError('UNSUPPORTED_MODEL');
              }
            } else {
              fixedPayload.stop_sequences = [...candidate.generation.stopSequences];
            }
            if (hasArrayEntries(fixedPayload.fallbacks) || fixedPayload.tool_choice !== undefined) {
              throw new PiAnthropicModelBindingError('UNSUPPORTED_MODEL');
            }
            return fixedPayload;
          },
          ...(incomingOptions.identity === undefined ? {} : { identity: incomingOptions.identity }),
          ...(incomingOptions.maxRetries === undefined
            ? {}
            : { maxRetries: incomingOptions.maxRetries }),
          ...(incomingOptions.maxRetryDelayMs === undefined
            ? {}
            : { maxRetryDelayMs: incomingOptions.maxRetryDelayMs }),
          ...(candidate.generation.anthropicBetaHeader === undefined
            ? {}
            : { headers: { 'anthropic-beta': candidate.generation.anthropicBetaHeader } }),
          apiKey: candidate.serverAdminApiKey,
          fetch: transport.fetch,
          maxTokens: candidate.generation.maxTokens,
          ...(candidate.generation.temperature === undefined
            ? {}
            : { temperature: candidate.generation.temperature }),
          metadata: { user_id: candidate.requestUserId },
          thinkingEnabled: thinking.kind !== 'disabled',
          ...(thinking.kind === 'budget' ? { thinkingBudgetTokens: thinking.budgetTokens } : {}),
          ...(thinking.kind === 'adaptive' && thinking.effort !== undefined
            ? { effort: thinking.effort }
            : {}),
          ...(thinking.kind !== 'disabled' && thinking.display !== undefined
            ? { thinkingDisplay: thinking.display }
            : {}),
          cacheRetention: candidate.generation.cacheRetention,
        };
        return anthropicStream(model, context, requestOptions);
      },
      models: [boundModel],
    });
    await runtime.setRuntimeApiKey(PI_ANTHROPIC_PROVIDER_ID, candidate.serverAdminApiKey);

    const boundRuntimeModel = runtime.getModel(PI_ANTHROPIC_PROVIDER_ID, candidate.modelId);
    if (!isBoundAnthropicModel(boundRuntimeModel) || boundRuntimeModel.id !== candidate.modelId) {
      throw new PiAnthropicModelBindingError('UNSUPPORTED_MODEL');
    }

    let disposed = false;
    return {
      model: boundRuntimeModel,
      modelRuntime: runtime,
      async dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        if (await cleanupRuntime(runtime, credentialStore, dependencies, disposeTransport)) {
          throw new PiAnthropicModelBindingError('CLEANUP_FAILED');
        }
      },
    };
  } catch (error) {
    if (await cleanupRuntime(runtime, credentialStore, dependencies, disposeTransport)) {
      throw new PiAnthropicModelBindingError('CLEANUP_FAILED');
    }
    if (error instanceof PiAnthropicModelBindingError) {
      throw error;
    }
    throw new PiAnthropicModelBindingError('RUNTIME_UNAVAILABLE');
  }
}
