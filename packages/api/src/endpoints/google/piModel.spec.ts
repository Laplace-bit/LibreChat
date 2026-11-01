import { Providers } from '@librechat/agents';
import { EModelEndpoint } from 'librechat-data-provider';
import { HarmBlockThreshold, HarmCategory } from '@google/generative-ai';
import type { GoogleClientOptions } from '@librechat/agents';
import type { InitializeResultBase } from '~/types';
import {
  GOOGLE_GENERATIVE_AI_API,
  GOOGLE_GENERATIVE_BASE_URL,
  type AuthorizedPiGoogleModelCandidate,
} from '~/agents/pi/googleModel';
import { createAuthorizedPiGoogleModelCandidate } from './piModel';

const API_KEY = 'AIza-server-admin-key-for-pi';
const MODEL_ID = 'gemini-2.5-flash';
const SAFETY_SETTINGS: NonNullable<GoogleClientOptions['safetySettings']> = [
  {
    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
    threshold: HarmBlockThreshold.BLOCK_NONE,
  },
];

function createInitializeResult(
  overrides: Partial<GoogleClientOptions> = {},
): InitializeResultBase {
  return {
    provider: Providers.GOOGLE,
    tools: [],
    llmConfig: {
      model: MODEL_ID,
      maxRetries: 2,
      maxOutputTokens: 512,
      safetySettings: SAFETY_SETTINGS,
      ...overrides,
    } satisfies GoogleClientOptions,
  };
}

function candidateInput(overrides: Record<string, unknown> = {}) {
  const initializeResult = createInitializeResult();
  return {
    endpoint: EModelEndpoint.google,
    adminApiKey: API_KEY,
    resolvedApiKey: API_KEY,
    userProvidedApiKey: false,
    resolvedProvider: Providers.GOOGLE,
    configuredBaseURL: undefined,
    reverseProxyURL: undefined,
    authHeader: false,
    googleConfig: {},
    allConfig: {},
    modelParameters: { model: MODEL_ID },
    expectedProxyURL: undefined,
    transport: { bodyTimeout: 900_000, headersTimeout: 300_000, proxy: undefined },
    initializeResult,
    ...overrides,
  };
}

describe('createAuthorizedPiGoogleModelCandidate', () => {
  it('maps only a canonical, server-admin direct Google request', () => {
    const result = createAuthorizedPiGoogleModelCandidate(candidateInput());

    expect(result).toEqual<AuthorizedPiGoogleModelCandidate>({
      source: 'server-admin-config',
      provider: 'google',
      api: GOOGLE_GENERATIVE_AI_API,
      baseUrl: GOOGLE_GENERATIVE_BASE_URL,
      modelId: MODEL_ID,
      serverAdminApiKey: API_KEY,
      transport: {
        bodyTimeout: 900_000,
        headersTimeout: 300_000,
        proxy: { kind: 'direct' },
      },
      generation: {
        maxOutputTokens: 512,
        safetySettings: SAFETY_SETTINGS,
      },
    });
  });

  it('maps the supported generation fields without dropping configured values', () => {
    const result = createAuthorizedPiGoogleModelCandidate(
      candidateInput({
        modelParameters: {
          model: MODEL_ID,
          temperature: 0.4,
          topP: 0.8,
          topK: 40,
          stopSequences: ['END'],
          thinking: true,
          thinkingLevel: 'HIGH',
        },
        initializeResult: createInitializeResult({
          temperature: 0.4,
          topP: 0.8,
          topK: 40,
          stopSequences: ['END'],
          thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' },
        }),
      }),
    );

    expect(result?.generation).toEqual({
      maxOutputTokens: 512,
      temperature: 0.4,
      topP: 0.8,
      topK: 40,
      stopSequences: ['END'],
      safetySettings: SAFETY_SETTINGS,
      thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' },
    });
  });

  it.each([
    ['Vertex endpoint', { endpoint: Providers.VERTEXAI }],
    ['Vertex provider result', { resolvedProvider: Providers.VERTEXAI }],
    ['user credential sentinel', { adminApiKey: 'user_provided', resolvedApiKey: 'user-key' }],
    ['resolved key mismatch', { resolvedApiKey: 'different-key' }],
    ['user-provided key', { userProvidedApiKey: true }],
    ['reverse proxy', { reverseProxyURL: 'https://gateway.example.test/v1beta' }],
    ['custom base URL', { configuredBaseURL: 'https://gateway.example.test/v1beta' }],
    ['custom admin headers', { googleConfig: { headers: { 'x-trace-id': 'trace' } } }],
    ['global custom headers', { allConfig: { headers: { 'x-trace-id': 'trace' } } }],
    ['Google auth header mode', { authHeader: true }],
    [
      'native Google tools',
      { initializeResult: { ...createInitializeResult(), tools: [{ googleSearch: {} }] } },
    ],
    ['unmapped model option', { modelParameters: { model: MODEL_ID, seed: 42 } }],
    [
      'unmapped LLM option',
      { initializeResult: createInitializeResult({ seed: 42 } as Partial<GoogleClientOptions>) },
    ],
    [
      'proxy provenance mismatch',
      {
        expectedProxyURL: 'http://proxy.example.test:3128',
        transport: { bodyTimeout: 900_000, headersTimeout: 300_000, proxy: undefined },
      },
    ],
    [
      'unsupported proxy protocol',
      {
        expectedProxyURL: 'socks5://proxy.example.test:1080',
        transport: {
          bodyTimeout: 900_000,
          headersTimeout: 300_000,
          proxy: 'socks5://proxy.example.test:1080',
        },
      },
    ],
    [
      'Gemini 3 Pro tiered usage model',
      {
        modelParameters: { model: 'gemini-3-pro-preview' },
        initializeResult: createInitializeResult({ model: 'gemini-3-pro-preview' }),
      },
    ],
  ])('leaves Pi binding unavailable for %s', (_name, override) => {
    expect(createAuthorizedPiGoogleModelCandidate(candidateInput(override))).toBeUndefined();
  });

  it('accepts only a captured HTTP(S) proxy and rejects unknown config values', () => {
    const proxy = 'http://proxy.internal:3128';
    const result = createAuthorizedPiGoogleModelCandidate(
      candidateInput({
        expectedProxyURL: proxy,
        transport: {
          bodyTimeout: 900_000,
          headersTimeout: 300_000,
          proxy,
        },
      }),
    );
    expect(result?.transport.proxy).toEqual({ kind: 'proxy', url: proxy });

    expect(
      createAuthorizedPiGoogleModelCandidate(
        candidateInput({
          transport: {
            bodyTimeout: 900_000,
            headersTimeout: 300_000,
            proxy: 'http://other.internal:3128',
          },
        }),
      ),
    ).toBeUndefined();
  });
});
