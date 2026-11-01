import { EModelEndpoint } from 'librechat-data-provider';
import type { CreateAuthorizedPiAzureModelCandidateInput } from './azurePiModel';
import type { InitializeResultBase } from '~/types';
import {
  AZURE_OPENAI_RESPONSES_API,
  PI_AZURE_PROVIDER_ID,
  type AuthorizedPiAzureModelCandidate,
} from '~/agents/pi/azureModel';
import { createAuthorizedPiAzureModelCandidate } from './azurePiModel';

const API_KEY = 'server-admin-azure-key';
const MODEL_ID = 'gpt-4o';
const DEPLOYMENT_NAME = 'factory-gpt-4o';
const BASE_URL = 'https://factory-resource.openai.azure.com/openai/v1';

function createInitializeResult(
  overrides: Partial<InitializeResultBase> = {},
): InitializeResultBase {
  return {
    azureOptions: {
      azureOpenAIApiKey: API_KEY,
      azureOpenAIApiDeploymentName: DEPLOYMENT_NAME,
      azureOpenAIApiVersion: 'v1',
    },
    llmConfig: {
      apiKey: API_KEY,
      model: DEPLOYMENT_NAME,
      user: 'user-1',
      streaming: true,
      useResponsesApi: true,
      firstPartyEndpoint: true,
    },
    configOptions: {
      baseURL: BASE_URL,
      defaultHeaders: { 'api-key': API_KEY },
      /** This is the existing Azure host client's generated default, not a custom query. */
      defaultQuery: { 'api-version': 'preview' },
      fetchOptions: { dispatcher: {} },
    },
    tools: [],
    ...overrides,
  };
}

type CandidateOverrides = Partial<CreateAuthorizedPiAzureModelCandidateInput>;

function candidateInput(
  overrides: CandidateOverrides = {},
): CreateAuthorizedPiAzureModelCandidateInput {
  return {
    endpoint: EModelEndpoint.azureOpenAI,
    credentialSource: 'server-admin-environment',
    adminApiKey: API_KEY,
    resolvedApiKey: API_KEY,
    userProvidedBaseURL: false,
    configuredBaseURL: undefined,
    azureConfig: undefined,
    allConfig: undefined,
    mappedAzureConfig: undefined,
    clientOptions: {
      reverseProxyUrl: undefined,
      baseURLIsUserProvided: false,
      transportTimeouts: { bodyTimeout: 900_000, headersTimeout: 300_000 },
    },
    modelParameters: { model: MODEL_ID, useResponsesApi: true },
    modelName: MODEL_ID,
    initializeResult: createInitializeResult(),
    ...overrides,
  };
}

describe('createAuthorizedPiAzureModelCandidate', () => {
  it.each([
    ['Azure OpenAI resource host', BASE_URL],
    [
      'Azure AI Foundry Models resource host',
      'https://factory-resource.services.ai.azure.com/openai/v1',
    ],
  ])('authorizes a catalogued Responses model on the canonical %s', async (_label, baseURL) => {
    const result = await createAuthorizedPiAzureModelCandidate(
      candidateInput({
        configuredBaseURL: baseURL,
        initializeResult: createInitializeResult({
          configOptions: {
            baseURL,
            defaultHeaders: { 'api-key': API_KEY },
            defaultQuery: { 'api-version': 'preview' },
            fetchOptions: { dispatcher: {} },
          },
        }),
      }),
    );

    expect(result).toEqual<AuthorizedPiAzureModelCandidate>({
      source: 'server-admin-config',
      provider: PI_AZURE_PROVIDER_ID,
      api: AZURE_OPENAI_RESPONSES_API,
      baseUrl: baseURL,
      modelId: MODEL_ID,
      deploymentName: DEPLOYMENT_NAME,
      apiVersion: 'v1',
      serverAdminApiKey: API_KEY,
      transport: { bodyTimeout: 900_000, headersTimeout: 300_000 },
    });
  });

  it('accepts an administrator model-group credential only when the resolved key is that group key', async () => {
    const mappedAzureConfig = {
      azureOptions: {
        azureOpenAIApiKey: API_KEY,
        azureOpenAIApiDeploymentName: DEPLOYMENT_NAME,
        azureOpenAIApiVersion: 'v1',
      },
      serverless: false,
    };
    const result = await createAuthorizedPiAzureModelCandidate(
      candidateInput({
        credentialSource: 'server-admin-model-group',
        mappedAzureConfig,
      }),
    );
    expect(result?.deploymentName).toBe(DEPLOYMENT_NAME);
  });

  const rejectedCandidates = [
    ['user credential source', { credentialSource: 'user' }],
    ['mismatched resolved key', { resolvedApiKey: 'different-key' }],
    ['user-provided URL', { userProvidedBaseURL: true }],
    ['non-Azure endpoint', { endpoint: EModelEndpoint.openAI }],
    ['unsupported catalog model', { modelName: 'not-in-the-pi-catalog' }],
    [
      'Chat Completions host configuration',
      {
        initializeResult: createInitializeResult({
          llmConfig: {
            apiKey: API_KEY,
            model: MODEL_ID,
            user: 'user-1',
            streaming: true,
            useResponsesApi: false,
            firstPartyEndpoint: true,
          },
        }),
      },
    ],
    [
      'unsupported model parameter',
      {
        modelParameters: { model: MODEL_ID, useResponsesApi: true, temperature: 0.2 },
      },
    ],
    [
      'dated Azure API version',
      {
        initializeResult: createInitializeResult({
          azureOptions: {
            azureOpenAIApiKey: API_KEY,
            azureOpenAIApiDeploymentName: DEPLOYMENT_NAME,
            azureOpenAIApiVersion: '2025-04-01-preview',
          },
        }),
      },
    ],
    [
      'custom Azure endpoint header',
      {
        azureConfig: { headers: { 'x-routing': 'custom' } },
      },
    ],
    ['global custom header', { allConfig: { headers: { 'x-routing': 'custom' } } }],
    [
      'group custom header',
      {
        mappedAzureConfig: {
          azureOptions: {
            azureOpenAIApiKey: API_KEY,
            azureOpenAIApiDeploymentName: DEPLOYMENT_NAME,
            azureOpenAIApiVersion: 'v1',
          },
          headers: { 'x-routing': 'custom' },
        },
        credentialSource: 'server-admin-model-group',
      },
    ],
    [
      'custom query in the configured URL',
      {
        configuredBaseURL: `${BASE_URL}?route=custom`,
      },
    ],
    [
      'custom provider query',
      {
        initializeResult: createInitializeResult({
          configOptions: {
            baseURL: BASE_URL,
            defaultHeaders: { 'api-key': API_KEY },
            defaultQuery: { 'api-version': 'preview', route: 'custom' },
            fetchOptions: { dispatcher: {} },
          },
        }),
      },
    ],
    [
      'unsupported host default query',
      {
        initializeResult: createInitializeResult({
          configOptions: {
            baseURL: BASE_URL,
            defaultHeaders: { 'api-key': API_KEY },
            defaultQuery: { 'api-version': 'v1' },
            fetchOptions: { dispatcher: {} },
          },
        }),
      },
    ],
    [
      'service endpoint with an unsupported suffix',
      {
        initializeResult: createInitializeResult({
          configOptions: {
            baseURL: 'https://factory-resource.ai.azure.com/openai/v1',
            defaultHeaders: { 'api-key': API_KEY },
            defaultQuery: { 'api-version': 'preview' },
            fetchOptions: { dispatcher: {} },
          },
        }),
      },
    ],
    [
      'cognitiveservices endpoint',
      {
        initializeResult: createInitializeResult({
          configOptions: {
            baseURL: 'https://factory-resource.cognitiveservices.azure.com/openai/v1',
            defaultHeaders: { 'api-key': API_KEY },
            defaultQuery: { 'api-version': 'preview' },
            fetchOptions: { dispatcher: {} },
          },
        }),
      },
    ],
    [
      'attacker-controlled hostname suffix',
      {
        initializeResult: createInitializeResult({
          configOptions: {
            baseURL: 'https://factory-resource.openai.azure.com.attacker.test/openai/v1',
            defaultHeaders: { 'api-key': API_KEY },
            defaultQuery: { 'api-version': 'preview' },
            fetchOptions: { dispatcher: {} },
          },
        }),
      },
    ],
    [
      'serverless model group',
      {
        credentialSource: 'server-admin-model-group',
        mappedAzureConfig: {
          azureOptions: { azureOpenAIApiKey: API_KEY },
          serverless: true,
        },
      },
    ],
  ] satisfies readonly (readonly [string, CandidateOverrides])[];

  it.each(rejectedCandidates)('does not authorize %s', async (_label, override) => {
    await expect(
      createAuthorizedPiAzureModelCandidate(candidateInput(override)),
    ).resolves.toBeUndefined();
  });
});
