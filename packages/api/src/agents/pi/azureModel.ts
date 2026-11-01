import { fetch as undiciFetch } from 'undici';
import type { CreateModelRuntimeOptions, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Api, CredentialStore, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { PiModelBinding } from './session';
import { getDirectDispatcher, getProxyDispatcher } from '~/utils/proxy';

export const PI_AZURE_PROVIDER_ID = 'azure' as const;
export const AZURE_OPENAI_RESPONSES_API = 'azure-openai-responses' as const;

const CANDIDATE_SOURCE = 'server-admin-config' as const;
const MAX_MODEL_ID_LENGTH = 128;
const MAX_DEPLOYMENT_NAME_LENGTH = 128;
const MAX_TRANSPORT_TIMEOUT_MS = 86_400_000;
const AZURE_V1_API_VERSION = 'v1' as const;
const AZURE_RESPONSES_PATH = '/openai/v1/responses' as const;

const ERROR_MESSAGES = {
  INVALID_CANDIDATE: 'The authorized Azure OpenAI model candidate is invalid.',
  UNSUPPORTED_MODEL: 'The selected Azure OpenAI model is not supported by this runtime.',
  RUNTIME_UNAVAILABLE: 'The Pi Azure OpenAI model runtime is unavailable.',
  CLEANUP_FAILED: 'The Pi Azure OpenAI model runtime could not be fully cleaned up.',
} as const;

export type PiAzureModelBindingErrorCode = keyof typeof ERROR_MESSAGES;

export interface AuthorizedPiAzureModelCandidate {
  readonly source: typeof CANDIDATE_SOURCE;
  readonly provider: 'azure';
  readonly api: typeof AZURE_OPENAI_RESPONSES_API;
  /** Normalized Azure public endpoint. This adapter intentionally supports only the v1 root. */
  readonly baseUrl: string;
  readonly modelId: string;
  readonly deploymentName: string;
  readonly apiVersion: typeof AZURE_V1_API_VERSION;
  readonly serverAdminApiKey: string;
  readonly transport: {
    readonly bodyTimeout: number;
    readonly headersTimeout: number;
    readonly proxy?: string;
  };
}

export interface PiAzureModelBindingDependencies {
  createCredentialStore?: () => CredentialStore | Promise<CredentialStore>;
  createRuntime?: (options: CreateModelRuntimeOptions) => Promise<ModelRuntime>;
  resolveCatalogModel?: (runtime: ModelRuntime, modelId: string) => Model<Api> | undefined;
  /** Test seam: production always uses the validated Azure destination. */
  rewriteRequestUrlForTest?: (url: URL) => URL;
  disposeRuntime?: (runtime: ModelRuntime) => void | Promise<void>;
}

export class PiAzureModelBindingError extends Error {
  readonly code: PiAzureModelBindingErrorCode;

  constructor(code: PiAzureModelBindingErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'PiAzureModelBindingError';
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

function validateBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new PiAzureModelBindingError('INVALID_CANDIDATE');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PiAzureModelBindingError('INVALID_CANDIDATE');
  }

  const expectedBaseUrl = `${url.origin}/openai/v1`;
  if (
    url.protocol !== 'https:' ||
    !isSupportedAzureHostname(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.pathname !== '/openai/v1' ||
    url.search !== '' ||
    url.hash !== '' ||
    value !== expectedBaseUrl
  ) {
    throw new PiAzureModelBindingError('INVALID_CANDIDATE');
  }

  return expectedBaseUrl;
}

function validateCandidate(value: unknown): AuthorizedPiAzureModelCandidate {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      new Set([
        'source',
        'provider',
        'api',
        'baseUrl',
        'modelId',
        'deploymentName',
        'apiVersion',
        'serverAdminApiKey',
        'transport',
      ]),
    ) ||
    value.source !== CANDIDATE_SOURCE ||
    value.provider !== PI_AZURE_PROVIDER_ID ||
    value.api !== AZURE_OPENAI_RESPONSES_API ||
    typeof value.modelId !== 'string' ||
    value.modelId.length === 0 ||
    value.modelId.length > MAX_MODEL_ID_LENGTH ||
    !/^[A-Za-z0-9._-]+$/u.test(value.modelId) ||
    typeof value.deploymentName !== 'string' ||
    value.deploymentName.length === 0 ||
    value.deploymentName.length > MAX_DEPLOYMENT_NAME_LENGTH ||
    !/^[A-Za-z0-9._-]+$/u.test(value.deploymentName) ||
    containsControlCharacter(value.deploymentName) ||
    value.apiVersion !== AZURE_V1_API_VERSION ||
    typeof value.serverAdminApiKey !== 'string' ||
    value.serverAdminApiKey.trim().length === 0 ||
    value.serverAdminApiKey === 'user_provided' ||
    containsControlCharacter(value.serverAdminApiKey) ||
    !isRecord(value.transport) ||
    !hasOnlyKeys(value.transport, new Set(['bodyTimeout', 'headersTimeout', 'proxy'])) ||
    typeof value.transport.bodyTimeout !== 'number' ||
    !Number.isSafeInteger(value.transport.bodyTimeout) ||
    value.transport.bodyTimeout < 0 ||
    value.transport.bodyTimeout > MAX_TRANSPORT_TIMEOUT_MS ||
    typeof value.transport.headersTimeout !== 'number' ||
    !Number.isSafeInteger(value.transport.headersTimeout) ||
    value.transport.headersTimeout < 0 ||
    value.transport.headersTimeout > MAX_TRANSPORT_TIMEOUT_MS
  ) {
    throw new PiAzureModelBindingError('INVALID_CANDIDATE');
  }

  let proxy: string | undefined;
  if (value.transport.proxy !== undefined) {
    if (typeof value.transport.proxy !== 'string' || value.transport.proxy.length > 2_048) {
      throw new PiAzureModelBindingError('INVALID_CANDIDATE');
    }
    const trimmed = value.transport.proxy.trim();
    if (trimmed.length > 0) {
      let parsed: URL;
      try {
        parsed = new URL(trimmed);
      } catch {
        throw new PiAzureModelBindingError('INVALID_CANDIDATE');
      }
      if (
        !['http:', 'https:', 'socks:', 'socks5:'].includes(parsed.protocol) ||
        !parsed.hostname ||
        (parsed.pathname !== '' && parsed.pathname !== '/') ||
        parsed.search !== '' ||
        parsed.hash !== ''
      ) {
        throw new PiAzureModelBindingError('INVALID_CANDIDATE');
      }
      proxy = trimmed;
    }
  }

  return {
    source: CANDIDATE_SOURCE,
    provider: PI_AZURE_PROVIDER_ID,
    api: AZURE_OPENAI_RESPONSES_API,
    baseUrl: validateBaseUrl(value.baseUrl),
    modelId: value.modelId,
    deploymentName: value.deploymentName,
    apiVersion: AZURE_V1_API_VERSION,
    serverAdminApiKey: value.serverAdminApiKey,
    transport: {
      bodyTimeout: value.transport.bodyTimeout,
      headersTimeout: value.transport.headersTimeout,
      ...(proxy === undefined ? {} : { proxy }),
    },
  };
}

function isSupportedCatalogModel(
  value: Model<Api> | undefined,
  modelId: string,
): value is Model<typeof AZURE_OPENAI_RESPONSES_API> {
  return (
    value !== undefined &&
    value.id === modelId &&
    value.provider === PI_AZURE_PROVIDER_ID &&
    value.api === AZURE_OPENAI_RESPONSES_API &&
    (value.baseUrl === '' || value.baseUrl === undefined) &&
    Number.isSafeInteger(value.maxTokens) &&
    value.maxTokens > 0 &&
    !hasEntries(value.headers) &&
    !hasEntries(value.samplingParams) &&
    !hasEntries(value.samplingParamsByThinkingLevel)
  );
}

function isBoundModel(
  value: Model<Api>,
  candidate: AuthorizedPiAzureModelCandidate,
): value is Model<typeof AZURE_OPENAI_RESPONSES_API> {
  return (
    value.id === candidate.modelId &&
    value.provider === PI_AZURE_PROVIDER_ID &&
    value.api === AZURE_OPENAI_RESPONSES_API &&
    value.baseUrl === candidate.baseUrl
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

function createValidatedFetch(
  candidate: AuthorizedPiAzureModelCandidate,
  rewriteRequestUrlForTest?: (url: URL) => URL,
): typeof globalThis.fetch {
  const transportOptions = {
    bodyTimeout: candidate.transport.bodyTimeout,
    headersTimeout: candidate.transport.headersTimeout,
  };
  const dispatcher =
    getProxyDispatcher(candidate.transport.proxy, transportOptions) ??
    getDirectDispatcher(transportOptions);
  const canonicalOrigin = new URL(candidate.baseUrl).origin;

  const fetchRequest = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    if (typeof input !== 'string' && !(input instanceof URL)) {
      throw new PiAzureModelBindingError('RUNTIME_UNAVAILABLE');
    }

    const url = new URL(input);
    const queryNames = [...url.searchParams.keys()];
    const headers = new Headers(init?.headers);
    if (
      url.origin !== canonicalOrigin ||
      url.pathname !== AZURE_RESPONSES_PATH ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== '' ||
      queryNames.length !== 1 ||
      queryNames[0] !== 'api-version' ||
      url.searchParams.getAll('api-version').length !== 1 ||
      url.searchParams.get('api-version') !== AZURE_V1_API_VERSION ||
      headers.get('api-key') !== candidate.serverAdminApiKey ||
      headers.has('authorization')
    ) {
      throw new PiAzureModelBindingError('RUNTIME_UNAVAILABLE');
    }

    const requestInput =
      rewriteRequestUrlForTest === undefined ? url : rewriteRequestUrlForTest(new URL(url));
    return (await undiciFetch(requestInput as unknown as Parameters<typeof undiciFetch>[0], {
      ...(init as unknown as Parameters<typeof undiciFetch>[1]),
      /** Do not let a server redirect this credential-bearing request to a new destination. */
      redirect: 'error',
      dispatcher,
    })) as unknown as Response;
  };

  return Object.assign(fetchRequest, { preconnect: () => undefined });
}

async function cleanupRuntime(
  runtime: ModelRuntime | undefined,
  credentialStore: CredentialStore | undefined,
  dependencies: PiAzureModelBindingDependencies,
): Promise<boolean> {
  let failed = false;
  if (runtime !== undefined) {
    try {
      await runtime.removeRuntimeApiKey(PI_AZURE_PROVIDER_ID);
    } catch {
      failed = true;
    }
    try {
      runtime.unregisterProvider(PI_AZURE_PROVIDER_ID);
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
      await credentialStore.delete(PI_AZURE_PROVIDER_ID);
    } catch {
      failed = true;
    }
  }
  return failed;
}

/** Creates a per-generation Pi Azure Responses model bound to one admin-authorized deployment. */
export async function createPiAzureModelBinding(
  candidateInput: unknown,
  dependencies: PiAzureModelBindingDependencies = {},
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

    const catalogModel = (
      dependencies.resolveCatalogModel ??
      ((targetRuntime, modelId) => targetRuntime.getModel(PI_AZURE_PROVIDER_ID, modelId))
    )(runtime, candidate.modelId);
    if (!isSupportedCatalogModel(catalogModel, candidate.modelId)) {
      throw new PiAzureModelBindingError('UNSUPPORTED_MODEL');
    }

    const fetch = createValidatedFetch(candidate, dependencies.rewriteRequestUrlForTest);
    const { streamSimple: azureResponsesStreamSimple } = await import(
      '@earendil-works/pi-ai/api/azure-openai-responses'
    );
    const boundModel = {
      ...catalogModel,
      provider: PI_AZURE_PROVIDER_ID,
      baseUrl: candidate.baseUrl,
      input: [...catalogModel.input],
      cost: { ...catalogModel.cost },
    } satisfies Model<typeof AZURE_OPENAI_RESPONSES_API>;

    runtime.registerProvider(PI_AZURE_PROVIDER_ID, {
      name: 'Azure OpenAI',
      api: AZURE_OPENAI_RESPONSES_API,
      baseUrl: candidate.baseUrl,
      streamSimple: (model, context, options) => {
        if (!isBoundModel(model, candidate) || options?.apiKey !== candidate.serverAdminApiKey) {
          throw new PiAzureModelBindingError('UNSUPPORTED_MODEL');
        }

        const incomingOnPayload = options.onPayload;
        const requestOptions: SimpleStreamOptions = {
          ...options,
          apiKey: candidate.serverAdminApiKey,
          fetch,
          headers: undefined,
          env: {
            ...(options.env ?? {}),
            AZURE_OPENAI_API_VERSION: candidate.apiVersion,
            AZURE_OPENAI_BASE_URL: candidate.baseUrl,
            AZURE_OPENAI_DEPLOYMENT_NAME_MAP: `${candidate.modelId}=${candidate.deploymentName}`,
          },
          onPayload: async (payload, payloadModel) => {
            const transformedPayload = await incomingOnPayload?.(payload, payloadModel);
            const authorizedPayload = transformedPayload ?? payload;
            if (!isRecord(authorizedPayload)) {
              throw new PiAzureModelBindingError('RUNTIME_UNAVAILABLE');
            }
            return { ...authorizedPayload, model: candidate.deploymentName };
          },
          maxRetries: options?.maxRetries ?? 2,
        };
        return azureResponsesStreamSimple(model, context, requestOptions);
      },
      models: [
        {
          id: boundModel.id,
          name: boundModel.name,
          api: AZURE_OPENAI_RESPONSES_API,
          baseUrl: candidate.baseUrl,
          input: [...boundModel.input],
          ...(boundModel.inputLimits === undefined ? {} : { inputLimits: boundModel.inputLimits }),
          cost: { ...boundModel.cost },
          reasoning: boundModel.reasoning,
          ...(boundModel.thinkingLevelMap === undefined
            ? {}
            : { thinkingLevelMap: { ...boundModel.thinkingLevelMap } }),
          ...(boundModel.promptCache === undefined ? {} : { promptCache: boundModel.promptCache }),
          contextWindow: boundModel.contextWindow,
          maxTokens: boundModel.maxTokens,
          ...(boundModel.compat === undefined ? {} : { compat: boundModel.compat }),
        },
      ],
    });
    await runtime.setRuntimeApiKey(PI_AZURE_PROVIDER_ID, candidate.serverAdminApiKey);

    const runtimeModel = runtime.getModel(PI_AZURE_PROVIDER_ID, candidate.modelId);
    if (runtimeModel === undefined || !isBoundModel(runtimeModel, candidate)) {
      throw new PiAzureModelBindingError('UNSUPPORTED_MODEL');
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
        if (await cleanupRuntime(runtime, credentialStore, dependencies)) {
          throw new PiAzureModelBindingError('CLEANUP_FAILED');
        }
      },
    };
  } catch (error) {
    if (await cleanupRuntime(runtime, credentialStore, dependencies)) {
      throw new PiAzureModelBindingError('CLEANUP_FAILED');
    }
    if (error instanceof PiAzureModelBindingError) {
      throw error;
    }
    throw new PiAzureModelBindingError('RUNTIME_UNAVAILABLE');
  }
}
