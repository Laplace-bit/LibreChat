import { fetch as undiciFetch } from 'undici';
import type { CreateModelRuntimeOptions, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Api, CredentialStore, Model } from '@earendil-works/pi-ai';
import type { PiModelBinding } from './session';
import { getDirectDispatcher, getProxyDispatcher } from '~/utils/proxy';

export const PI_OPENAI_PROVIDER_ID = 'librechat-openai' as const;
export const OPENAI_API = 'openai-responses' as const;
export const OPENAI_BASE_URL = 'https://api.openai.com/v1' as const;

const CANDIDATE_SOURCE = 'server-admin-config' as const;
const MAX_MODEL_ID_LENGTH = 128;
const MAX_TRANSPORT_TIMEOUT_MS = 86_400_000;

const ERROR_MESSAGES = {
  INVALID_CANDIDATE: 'The authorized OpenAI model candidate is invalid.',
  UNSUPPORTED_MODEL: 'The selected OpenAI model is not supported by this runtime.',
  RUNTIME_UNAVAILABLE: 'The Pi OpenAI model runtime is unavailable.',
  CLEANUP_FAILED: 'The Pi OpenAI model runtime could not be fully cleaned up.',
} as const;

export type PiOpenAIModelBindingErrorCode = keyof typeof ERROR_MESSAGES;

export interface PiOpenAITransport {
  readonly bodyTimeout: number;
  readonly headersTimeout: number;
  readonly proxy?: string;
}

/**
 * The server-side provider resolver must construct this only from an authorized admin configuration.
 * This shape is a module contract, not proof of authorization: callers must never populate it from
 * request-body credentials or user-owned llmConfig secrets.
 */
export interface AuthorizedPiOpenAIModelCandidate {
  readonly source: typeof CANDIDATE_SOURCE;
  readonly provider: 'openai';
  readonly api: typeof OPENAI_API;
  readonly baseUrl: typeof OPENAI_BASE_URL;
  readonly modelId: string;
  readonly serverAdminApiKey: string;
  /** Server-authenticated user.id from the resolver; never take this from request parameters. */
  readonly requestUserId?: string;
  readonly transport: PiOpenAITransport;
  readonly sampling?: {
    readonly temperature?: number;
    readonly topP?: number;
    readonly maxTokens?: number;
  };
}

export interface PiOpenAIModelBindingDependencies {
  createCredentialStore?: () => CredentialStore | Promise<CredentialStore>;
  createRuntime?: (options: CreateModelRuntimeOptions) => Promise<ModelRuntime>;
  resolveCatalogModel?: (runtime: ModelRuntime, modelId: string) => Model<Api> | undefined;
  /** Test seam for redirecting the canonical OpenAI URL to a local HTTP server. */
  rewriteRequestUrlForTest?: (url: URL) => URL;
  /** Test/runtime adapter hook; Pi ModelRuntime itself currently exposes no public dispose method. */
  disposeRuntime?: (runtime: ModelRuntime) => void | Promise<void>;
}

export class PiOpenAIModelBindingError extends Error {
  readonly code: PiOpenAIModelBindingErrorCode;

  constructor(code: PiOpenAIModelBindingErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'PiOpenAIModelBindingError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
  });
}

function validateTransport(transport: unknown): PiOpenAITransport {
  if (!isRecord(transport) || !hasOnlyKeys(transport, ['bodyTimeout', 'headersTimeout', 'proxy'])) {
    throw new PiOpenAIModelBindingError('INVALID_CANDIDATE');
  }

  const { bodyTimeout, headersTimeout, proxy } = transport;
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
    throw new PiOpenAIModelBindingError('INVALID_CANDIDATE');
  }

  let validatedProxy: string | undefined;
  if (proxy !== undefined) {
    if (typeof proxy !== 'string' || proxy.length > 2048) {
      throw new PiOpenAIModelBindingError('INVALID_CANDIDATE');
    }
    const trimmedProxy = proxy.trim();
    if (trimmedProxy.length > 0) {
      let parsedProxy: URL;
      try {
        parsedProxy = new URL(trimmedProxy);
      } catch {
        throw new PiOpenAIModelBindingError('INVALID_CANDIDATE');
      }
      if (
        !['http:', 'https:', 'socks:', 'socks5:'].includes(parsedProxy.protocol) ||
        !parsedProxy.hostname ||
        (parsedProxy.pathname !== '' && parsedProxy.pathname !== '/') ||
        parsedProxy.search !== '' ||
        parsedProxy.hash !== ''
      ) {
        throw new PiOpenAIModelBindingError('INVALID_CANDIDATE');
      }
      validatedProxy = trimmedProxy;
    }
  }

  return {
    bodyTimeout,
    headersTimeout,
    ...(validatedProxy === undefined ? {} : { proxy: validatedProxy }),
  };
}

function validateSampling(sampling: unknown): AuthorizedPiOpenAIModelCandidate['sampling'] {
  if (sampling === undefined) {
    return undefined;
  }
  if (!isRecord(sampling) || !hasOnlyKeys(sampling, ['temperature', 'topP', 'maxTokens'])) {
    throw new PiOpenAIModelBindingError('INVALID_CANDIDATE');
  }

  const { temperature, topP, maxTokens } = sampling;
  if (
    (temperature !== undefined &&
      (typeof temperature !== 'number' ||
        !Number.isFinite(temperature) ||
        temperature < 0 ||
        temperature > 2)) ||
    (topP !== undefined &&
      (typeof topP !== 'number' || !Number.isFinite(topP) || topP <= 0 || topP > 1)) ||
    (maxTokens !== undefined &&
      (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens < 1))
  ) {
    throw new PiOpenAIModelBindingError('INVALID_CANDIDATE');
  }

  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

function validateCandidate(candidate: unknown): AuthorizedPiOpenAIModelCandidate {
  if (
    !isRecord(candidate) ||
    !hasOnlyKeys(candidate, [
      'source',
      'provider',
      'api',
      'baseUrl',
      'modelId',
      'serverAdminApiKey',
      'requestUserId',
      'transport',
      'sampling',
    ])
  ) {
    throw new PiOpenAIModelBindingError('INVALID_CANDIDATE');
  }

  const { source, provider, api, baseUrl, modelId, serverAdminApiKey, requestUserId } = candidate;
  if (
    source !== CANDIDATE_SOURCE ||
    provider !== 'openai' ||
    api !== OPENAI_API ||
    baseUrl !== OPENAI_BASE_URL ||
    typeof modelId !== 'string' ||
    modelId.length === 0 ||
    modelId.length > MAX_MODEL_ID_LENGTH ||
    !/^[A-Za-z0-9._-]+$/u.test(modelId) ||
    typeof serverAdminApiKey !== 'string' ||
    serverAdminApiKey.trim().length === 0 ||
    (requestUserId !== undefined &&
      (typeof requestUserId !== 'string' ||
        requestUserId.trim().length === 0 ||
        requestUserId.length > 256 ||
        containsControlCharacter(requestUserId)))
  ) {
    throw new PiOpenAIModelBindingError('INVALID_CANDIDATE');
  }

  const transport = validateTransport(candidate.transport);
  const sampling = validateSampling(candidate.sampling);
  if (sampling?.maxTokens !== undefined && sampling.maxTokens > 1_000_000) {
    throw new PiOpenAIModelBindingError('INVALID_CANDIDATE');
  }

  return {
    source,
    provider,
    api,
    baseUrl,
    modelId,
    serverAdminApiKey,
    ...(requestUserId === undefined ? {} : { requestUserId }),
    transport,
    ...(sampling === undefined ? {} : { sampling }),
  };
}

function isSupportedCatalogModel(
  model: Model<Api> | undefined,
  modelId: string,
): model is Model<typeof OPENAI_API> {
  return (
    model !== undefined &&
    model.id === modelId &&
    model.provider === 'openai' &&
    model.api === OPENAI_API &&
    model.baseUrl === OPENAI_BASE_URL &&
    Number.isSafeInteger(model.maxTokens) &&
    model.maxTokens > 0
  );
}

function assertBoundModel(
  model: Model<Api> | undefined,
  modelId: string,
): asserts model is Model<Api> {
  if (
    model === undefined ||
    model.id !== modelId ||
    model.provider !== PI_OPENAI_PROVIDER_ID ||
    model.api !== OPENAI_API ||
    model.baseUrl !== OPENAI_BASE_URL
  ) {
    throw new PiOpenAIModelBindingError('UNSUPPORTED_MODEL');
  }
}

function isBoundOpenAIResponsesModel(model: Model<Api>): model is Model<typeof OPENAI_API> {
  return (
    model.api === OPENAI_API &&
    model.provider === PI_OPENAI_PROVIDER_ID &&
    model.baseUrl === OPENAI_BASE_URL
  );
}

async function createDefaultCredentialStore(): Promise<CredentialStore> {
  const { InMemoryCredentialStore } = await import('@earendil-works/pi-ai');
  return new InMemoryCredentialStore();
}

async function createDefaultRuntime(options: CreateModelRuntimeOptions): Promise<ModelRuntime> {
  const { ModelRuntime: PiModelRuntime } = await import('@earendil-works/pi-coding-agent');
  return PiModelRuntime.create(options);
}

function createTransportFetch(
  transport: PiOpenAITransport,
  rewriteRequestUrlForTest?: (url: URL) => URL,
): typeof globalThis.fetch {
  const timeouts = {
    bodyTimeout: transport.bodyTimeout,
    headersTimeout: transport.headersTimeout,
  };
  const dispatcher = getProxyDispatcher(transport.proxy, timeouts) ?? getDirectDispatcher(timeouts);

  const fetchWithDispatcher = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    let requestInput = input;
    if (rewriteRequestUrlForTest !== undefined) {
      if (typeof input !== 'string' && !(input instanceof URL)) {
        throw new PiOpenAIModelBindingError('RUNTIME_UNAVAILABLE');
      }
      requestInput = rewriteRequestUrlForTest(new URL(input));
    }
    return (await undiciFetch(requestInput as unknown as Parameters<typeof undiciFetch>[0], {
      ...(init as unknown as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    })) as unknown as Response;
  };

  // The application's Bun fetch type includes preconnect; OpenAI's SDK only calls fetch.
  return Object.assign(fetchWithDispatcher, { preconnect: () => undefined });
}

async function cleanupRuntime(
  runtime: ModelRuntime | undefined,
  credentialStore: CredentialStore | undefined,
  dependencies: PiOpenAIModelBindingDependencies,
): Promise<boolean> {
  let failed = false;
  if (runtime !== undefined) {
    try {
      await runtime.removeRuntimeApiKey(PI_OPENAI_PROVIDER_ID);
    } catch {
      failed = true;
    }
    try {
      // Pi 1.4.0 returns void here and starts an internal refresh that this adapter cannot await.
      runtime.unregisterProvider(PI_OPENAI_PROVIDER_ID);
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
      await credentialStore.delete(PI_OPENAI_PROVIDER_ID);
    } catch {
      failed = true;
    }
  }
  return failed;
}

/** Creates an isolated Pi model runtime and in-memory credential scope for one generation. */
export async function createPiOpenAIModelBinding(
  candidateInput: unknown,
  dependencies: PiOpenAIModelBindingDependencies = {},
): Promise<PiModelBinding> {
  const candidate = validateCandidate(candidateInput);
  let credentialStore: CredentialStore | undefined;
  let runtime: ModelRuntime | undefined;

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

    const { streamSimple: openAIResponsesStreamSimple } = await import(
      '@earendil-works/pi-ai/api/openai-responses'
    );
    const fetch = createTransportFetch(candidate.transport, dependencies.rewriteRequestUrlForTest);
    const catalogModel = (
      dependencies.resolveCatalogModel ??
      ((targetRuntime, modelId) => targetRuntime.getModel('openai', modelId))
    )(runtime, candidate.modelId);
    if (!isSupportedCatalogModel(catalogModel, candidate.modelId)) {
      throw new PiOpenAIModelBindingError('UNSUPPORTED_MODEL');
    }
    if (
      candidate.sampling?.maxTokens !== undefined &&
      candidate.sampling.maxTokens > catalogModel.maxTokens
    ) {
      throw new PiOpenAIModelBindingError('INVALID_CANDIDATE');
    }

    const samplingParams = {
      ...catalogModel.samplingParams,
      ...(candidate.sampling?.temperature === undefined
        ? {}
        : { temperature: candidate.sampling.temperature }),
      ...(candidate.sampling?.topP === undefined ? {} : { top_p: candidate.sampling.topP }),
      ...(candidate.requestUserId === undefined ? {} : { user: candidate.requestUserId }),
    };
    runtime.registerProvider(PI_OPENAI_PROVIDER_ID, {
      name: 'OpenAI',
      api: OPENAI_API,
      baseUrl: OPENAI_BASE_URL,
      streamSimple: (model, context, options) => {
        if (!isBoundOpenAIResponsesModel(model)) {
          throw new PiOpenAIModelBindingError('UNSUPPORTED_MODEL');
        }
        return openAIResponsesStreamSimple(model, context, {
          ...options,
          fetch,
        });
      },
      models: [
        {
          id: catalogModel.id,
          name: catalogModel.name,
          api: OPENAI_API,
          baseUrl: OPENAI_BASE_URL,
          input: [...catalogModel.input],
          inputLimits: catalogModel.inputLimits,
          cost: { ...catalogModel.cost },
          reasoning: catalogModel.reasoning,
          thinkingLevelMap: catalogModel.thinkingLevelMap,
          promptCache: catalogModel.promptCache,
          contextWindow: catalogModel.contextWindow,
          maxTokens: candidate.sampling?.maxTokens ?? catalogModel.maxTokens,
          samplingParams,
          compat: catalogModel.compat,
        },
      ],
    });
    await runtime.setRuntimeApiKey(PI_OPENAI_PROVIDER_ID, candidate.serverAdminApiKey);

    const boundModel = runtime.getModel(PI_OPENAI_PROVIDER_ID, candidate.modelId);
    assertBoundModel(boundModel, candidate.modelId);

    let disposed = false;
    return {
      model: boundModel,
      modelRuntime: runtime,
      async dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        if (await cleanupRuntime(runtime, credentialStore, dependencies)) {
          throw new PiOpenAIModelBindingError('CLEANUP_FAILED');
        }
      },
    };
  } catch (error) {
    if (await cleanupRuntime(runtime, credentialStore, dependencies)) {
      throw new PiOpenAIModelBindingError('CLEANUP_FAILED');
    }
    if (error instanceof PiOpenAIModelBindingError) {
      throw error;
    }
    throw new PiOpenAIModelBindingError('RUNTIME_UNAVAILABLE');
  }
}
