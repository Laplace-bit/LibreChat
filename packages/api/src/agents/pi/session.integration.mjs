import test from 'node:test';
import { Type } from 'typebox';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { StepTypes, Tools, UsageEvents } from 'librechat-data-provider';
import { createContentAggregator, GraphEvents } from '@librechat/agents';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@librechat/agents/langchain/messages';

const require = createRequire(import.meta.url);
const {
  convertLibreChatHistoryToPi,
  createHostPiSession,
  executePiGeneration,
  PiContextBudgetExceededError,
  PiContextUsageUnavailableError,
  createPiContentEventTranslator,
  LEGACY_AGENT_RUNTIME,
  PINNED_PI_AGENT_RUNTIME,
  resolveResumableAgentRuntime,
  resolveStoredAgentRuntime,
} = require('../../../dist/index.cjs');
const tinyPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPgEpH7DwABpAE8sdwFIwAAAABJRU5ErkJggg==';

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function createTestModelBinding(onDispose) {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const model = modelRuntime.getModels()[0];
  assert.ok(model, 'Pi has a static model catalog');
  return {
    model,
    modelRuntime,
    dispose: onDispose,
  };
}

async function createFakeOpenAIModelBinding(baseUrl, onDispose, api = 'openai-completions') {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider('pi-integration-test', {
    name: 'Pi integration test provider',
    baseUrl,
    api,
    apiKey: 'integration-test-key',
    models: [
      {
        id: 'echo-test',
        name: 'Echo test model',
        reasoning: false,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 128,
      },
    ],
  });
  const model = modelRuntime.getModel('pi-integration-test', 'echo-test');
  assert.ok(model, 'the per-run provider model is registered');
  return { model, modelRuntime, dispose: onDispose };
}

async function createFakeChatServer({
  toolCallOnFirst = false,
  siblingToolCallOnFirst = false,
  siblingToolCallId = 'call_sibling',
  toolCallName = 'safe_query',
  toolCallArguments = '{"query":"authorized"}',
  responseDelayMs = 0,
  onRequest,
} = {}) {
  let requestCount = 0;
  const requestBodies = [];
  let authorization;
  let clientCancelled = false;
  const server = createServer((request, response) => {
    let body = '';
    let responseTimer;
    request.on('aborted', () => {
      clientCancelled = true;
    });
    request.socket.once('close', () => {
      if (!response.writableEnded) {
        clientCancelled = true;
      }
    });
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requestCount += 1;
      requestBodies.push(JSON.parse(body));
      authorization = request.headers.authorization;
      onRequest?.();
      const sendResponse = () => {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        response.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-pi-test-${requestCount}`,
            object: 'chat.completion.chunk',
            created: 1,
            model: 'echo-test',
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          })}\n\n`,
        );
        if (toolCallOnFirst && requestCount === 1) {
          response.write(
            `data: ${JSON.stringify({
              id: `chatcmpl-pi-test-${requestCount}`,
              object: 'chat.completion.chunk',
              created: 1,
              model: 'echo-test',
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_safe_query',
                        type: 'function',
                        function: {
                          name: toolCallName,
                          arguments: toolCallArguments,
                        },
                      },
                      ...(siblingToolCallOnFirst
                        ? [
                            {
                              index: 1,
                              id: siblingToolCallId,
                              type: 'function',
                              function: {
                                name: toolCallName,
                                arguments: '{"query":"sibling query"}',
                              },
                            },
                          ]
                        : []),
                    ],
                  },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
        } else {
          response.write(
            `data: ${JSON.stringify({
              id: `chatcmpl-pi-test-${requestCount}`,
              object: 'chat.completion.chunk',
              created: 1,
              model: 'echo-test',
              choices: [
                {
                  index: 0,
                  delta: { reasoning_content: 'provider reasoning' },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-pi-test',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'echo-test',
              choices: [{ index: 0, delta: { content: 'Pi adapter stream' }, finish_reason: null }],
            })}\n\n`,
          );
        }
        response.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-pi-test-${requestCount}`,
            object: 'chat.completion.chunk',
            created: 1,
            model: 'echo-test',
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: toolCallOnFirst && requestCount === 1 ? 'tool_calls' : 'stop',
              },
            ],
          })}\n\n`,
        );
        response.end('data: [DONE]\n\n');
      };
      response.on('close', () => {
        clearTimeout(responseTimer);
        if (!response.writableEnded) {
          clientCancelled = true;
        }
      });
      if (responseDelayMs === 0) {
        sendResponse();
      } else {
        responseTimer = setTimeout(sendResponse, responseDelayMs);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    getRequestCount: () => requestCount,
    getRequestBody: () => requestBodies.at(-1),
    getRequestBodies: () => requestBodies,
    getAuthorization: () => authorization,
    wasClientCancelled: () => clientCancelled,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

test('Pi host sessions expose only host tools, keep state in memory, and dispose run bindings', async () => {
  let bindingDisposals = 0;

  const session = await createHostPiSession({
    createModelBinding: () =>
      createTestModelBinding(() => {
        bindingDisposals += 1;
      }),
    systemPrompt: 'Session boundary integration test.',
    tools: [
      {
        name: 'safe_query',
        label: 'Safe query',
        description: 'Query authorized factory data.',
        parameters: Type.Object({ query: Type.String() }),
        execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      },
    ],
  });

  assert.equal(session.sessionFile, undefined);
  assert.deepEqual(session.activeToolNames, ['safe_query']);
  await session.dispose();
  await session.dispose();
  assert.equal(bindingDisposals, 1, 'the model binding is disposed exactly once');
});

test('Pi host session refuses prompts after the host generation is aborted', async () => {
  const controller = new AbortController();
  let bindingDisposals = 0;
  const session = await createHostPiSession({
    createModelBinding: () =>
      createTestModelBinding(() => {
        bindingDisposals += 1;
      }),
    systemPrompt: 'Abort boundary integration test.',
    tools: [],
    signal: controller.signal,
  });

  assert.deepEqual(session.activeToolNames, [], 'Pi must not activate built-in tools');
  controller.abort();
  await assert.rejects(session.prompt('This must not start a model call.'), { name: 'AbortError' });
  await session.dispose();
  assert.equal(bindingDisposals, 1);
});

test('Pi host session releases a model binding if cancellation races session creation', async () => {
  const controller = new AbortController();
  let bindingDisposals = 0;

  await assert.rejects(
    createHostPiSession({
      createModelBinding: async () => {
        controller.abort();
        return createTestModelBinding(() => {
          bindingDisposals += 1;
        });
      },
      systemPrompt: 'Creation race boundary integration test.',
      tools: [],
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
  assert.equal(bindingDisposals, 1, 'the binding is disposed when startup is cancelled');
});

test('LibreChat history becomes structured Pi messages and preserves the current image prompt', async () => {
  const fakeProvider = await createFakeChatServer();
  let bindingDisposals = 0;
  let session;

  try {
    const modelBinding = await createFakeOpenAIModelBinding(fakeProvider.baseUrl, () => {
      bindingDisposals += 1;
    });
    const conversion = convertLibreChatHistoryToPi({
      messages: [
        new SystemMessage('Agent system instructions.'),
        new HumanMessage('Previous user question.'),
        new AIMessage({
          content: 'I queried the factory system.',
          tool_calls: [
            {
              id: 'historical-query-1',
              name: 'safe_query',
              args: { query: 'previous shift output' },
              type: 'tool_call',
            },
          ],
        }),
        new ToolMessage({
          content: 'Stored result: 42 units.',
          tool_call_id: 'historical-query-1',
          name: 'safe_query',
        }),
        new HumanMessage({
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${tinyPngBase64}` } },
          ],
        }),
      ],
      model: modelBinding.model,
      baseSystemPrompt: 'Host policy instructions.',
      now: () => 123,
    });

    assert.equal(conversion.history.length, 3);
    assert.equal(conversion.history[0].role, 'user');
    assert.equal(conversion.history[1].role, 'assistant');
    assert.equal(conversion.history[2].role, 'toolResult');
    assert.match(conversion.systemPrompt, /Host policy instructions\./);
    assert.match(conversion.systemPrompt, /Agent system instructions\./);
    assert.equal(conversion.prompt.text, 'What is in this image?');
    assert.deepEqual(conversion.prompt.images, [
      { type: 'image', mimeType: 'image/png', data: tinyPngBase64 },
    ]);

    session = await createHostPiSession({
      createModelBinding: async () => modelBinding,
      systemPrompt: conversion.systemPrompt,
      history: conversion.history,
      tools: [],
    });
    await session.prompt(conversion.prompt.text, { images: conversion.prompt.images });

    const { messages } = fakeProvider.getRequestBody();
    assert.deepEqual(
      messages.map(({ role }) => role),
      ['system', 'user', 'assistant', 'tool', 'user'],
    );
    assert.match(messages[0].content, /Host policy instructions\./);
    assert.equal(messages[1].content, 'Previous user question.');
    assert.equal(messages[2].tool_calls[0].id, 'historical-query-1');
    assert.equal(messages[3].content, 'Stored result: 42 units.');
    assert.ok(
      JSON.stringify(messages[4].content).includes(tinyPngBase64),
      JSON.stringify(messages[4].content),
    );
  } finally {
    try {
      await session?.dispose();
    } finally {
      await fakeProvider.close();
    }
  }
  assert.equal(bindingDisposals, 1);
});

test('LibreChat history conversion rejects incomplete tool state, signatures, and remote images', () => {
  const model = { api: 'openai-completions', provider: 'openai', id: 'test-model' };
  assert.throws(
    () =>
      convertLibreChatHistoryToPi({
        model,
        messages: [
          new HumanMessage('Run a query.'),
          new AIMessage({
            content: 'Querying.',
            tool_calls: [{ id: 'missing-result', name: 'safe_query', args: {}, type: 'tool_call' }],
          }),
          new HumanMessage('Continue.'),
        ],
      }),
    { code: 'unresolved_tool_call' },
  );
  assert.throws(
    () =>
      convertLibreChatHistoryToPi({
        model,
        messages: [
          new AIMessage({
            content: 'Signed answer.',
            additional_kwargs: { thought_signature: 'provider-private-signature' },
          }),
          new HumanMessage('Continue.'),
        ],
      }),
    { code: 'provider_signature' },
  );
  assert.throws(
    () =>
      convertLibreChatHistoryToPi({
        model,
        messages: [
          new AIMessage({
            content: 'Signed tool response.',
            additional_kwargs: { signatures: { 'call-1': 'provider-private-signature' } },
          }),
          new HumanMessage('Continue.'),
        ],
      }),
    { code: 'provider_signature' },
  );
  assert.throws(
    () =>
      convertLibreChatHistoryToPi({
        model,
        messages: [
          new HumanMessage({
            content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }],
          }),
        ],
      }),
    { code: 'unsupported_content' },
  );
});

test('generation runtime identity defaults old jobs to legacy and rejects unknown Pi versions', () => {
  assert.deepEqual(resolveStoredAgentRuntime(undefined), {
    status: 'resolved',
    selection: LEGACY_AGENT_RUNTIME,
  });
  assert.deepEqual(resolveStoredAgentRuntime({ engine: 'legacy' }), {
    status: 'resolved',
    selection: LEGACY_AGENT_RUNTIME,
  });
  assert.deepEqual(resolveStoredAgentRuntime(PINNED_PI_AGENT_RUNTIME), {
    status: 'resolved',
    selection: PINNED_PI_AGENT_RUNTIME,
  });
  assert.deepEqual(resolveStoredAgentRuntime({ engine: 'pi', sdkVersion: '99.0.0' }), {
    status: 'unsupported',
  });
  assert.deepEqual(resolveStoredAgentRuntime(null), { status: 'unsupported' });
  assert.deepEqual(resolveStoredAgentRuntime({ engine: 'legacy', sdkVersion: 'future' }), {
    status: 'unsupported',
  });
  assert.deepEqual(resolveStoredAgentRuntime({ engine: 'other' }), { status: 'unsupported' });
  assert.deepEqual(resolveResumableAgentRuntime(undefined), {
    status: 'available',
    selection: LEGACY_AGENT_RUNTIME,
  });
  assert.deepEqual(resolveResumableAgentRuntime(PINNED_PI_AGENT_RUNTIME), {
    status: 'unavailable',
  });
});

test('Pi content events close an interrupted host step as cancelled', () => {
  const translatePiEvent = createPiContentEventTranslator({
    createStepIdentity: () => ({
      id: 'interrupted-step',
      index: 0,
      messageId: 'librechat-response-2',
      runId: 'librechat-run-2',
      agentId: 'host-agent-1',
    }),
    now: () => 100,
  });
  const assistantMessage = { role: 'assistant' };

  translatePiEvent({ type: 'message_start', message: assistantMessage });
  const partialEvents = translatePiEvent({
    type: 'message_update',
    message: assistantMessage,
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'partial reply',
      partial: assistantMessage,
    },
  });
  const lowLevelEndEvents = translatePiEvent({
    type: 'agent_end',
    messages: [],
    willRetry: true,
  });
  const cancelledEvents = translatePiEvent({ type: 'agent_settled', aborted: true });

  assert.deepEqual(
    partialEvents.map(({ event }) => event),
    [GraphEvents.ON_RUN_STEP, GraphEvents.ON_MESSAGE_DELTA],
  );
  assert.deepEqual(
    lowLevelEndEvents,
    [],
    'a low-level run ending does not close host steps while Pi may retry',
  );
  assert.deepEqual(cancelledEvents, [
    {
      event: GraphEvents.ON_RUN_STEP_CLOSED,
      data: {
        id: 'interrupted-step',
        index: 0,
        type: 'message_creation',
        status: 'cancelled',
        created_at: 100,
        closed_at: 100,
        runId: 'librechat-run-2',
        agentId: 'host-agent-1',
      },
    },
  ]);
});

test('Pi host session sends a prompt through its bound provider and streams the reply', async () => {
  const fakeProvider = await createFakeChatServer({ toolCallOnFirst: true });
  let bindingDisposals = 0;
  let hostToolCalls = 0;
  let hostStepIndex = 0;
  let hostStepId = 0;
  const contentAggregator = createContentAggregator();
  const hostEvents = [];
  const identityRequests = [];
  let unsupportedToolCycleRejected = false;
  const translatePiEvent = createPiContentEventTranslator({
    createStepIdentity: (identity) => {
      identityRequests.push(identity);
      return {
        id: `pi-step-${hostStepId++}`,
        index: hostStepIndex++,
        messageId: 'librechat-response-1',
        runId: 'librechat-run-1',
        agentId: 'host-agent-1',
      };
    },
  });
  let session;

  try {
    session = await createHostPiSession({
      createModelBinding: () =>
        createFakeOpenAIModelBinding(fakeProvider.baseUrl, () => {
          bindingDisposals += 1;
        }),
      systemPrompt: 'Use the configured test provider.',
      tools: [
        {
          name: 'safe_query',
          label: 'Safe query',
          description: 'Query authorized factory data.',
          parameters: Type.Object({ query: Type.String() }),
          execute: async (_toolCallId, params) => {
            assert.equal(params.query, 'authorized');
            hostToolCalls += 1;
            return { content: [{ type: 'text', text: 'authorized-result' }] };
          },
        },
      ],
    });
    let streamedText = '';
    const observedEvents = [];
    const observedMessages = [];
    session.subscribe((event) => {
      /** This direct session test exercises Pi's scoped host tool API. The product dispatcher
       *  currently passes no tools, and its event bridge must reject unrepresented tool cycles. */
      if (
        event.type === 'agent_end' &&
        event.messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.stopReason === 'toolUse' &&
            message.content.some((part) => part.type === 'toolCall'),
        )
      ) {
        assert.throws(() => translatePiEvent(event), { code: 'PI_RESPONSE_UNSUPPORTED' });
        unsupportedToolCycleRejected = true;
        observedEvents.push(event.type);
        return;
      }
      for (const hostEvent of translatePiEvent(event)) {
        hostEvents.push(hostEvent);
        if (hostEvent.event !== GraphEvents.ON_RUN_STEP_CLOSED) {
          contentAggregator.aggregateContent(hostEvent);
        }
      }
      observedEvents.push(event.type);
      if (event.type === 'message_end') {
        observedMessages.push(event.message);
      }
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        streamedText += event.assistantMessageEvent.delta;
      }
    });

    await session.prompt('Say exactly: Pi adapter stream');
    const diagnostics = `events=${observedEvents.join(', ')} messages=${JSON.stringify(observedMessages)}`;
    assert.equal(fakeProvider.getRequestCount(), 2, diagnostics);
    assert.equal(hostToolCalls, 1, 'only the supplied host tool executes');
    assert.equal(unsupportedToolCycleRejected, true);
    assert.equal(fakeProvider.getAuthorization(), 'Bearer integration-test-key');
    assert.ok(
      JSON.stringify(fakeProvider.getRequestBodies()[0]).includes('Say exactly: Pi adapter stream'),
      'the user prompt reaches the selected provider',
    );
    const modelContext = JSON.stringify(fakeProvider.getRequestBodies()[0]);
    assert.ok(modelContext.includes('/librechat-agent'));
    assert.equal(
      modelContext.includes(process.cwd()),
      false,
      'the host working directory stays private',
    );
    assert.ok(
      JSON.stringify(fakeProvider.getRequestBodies()[1]).includes('authorized-result'),
      'the host tool result is sent back to Pi for the next model turn',
    );
    assert.equal(streamedText, 'Pi adapter stream', diagnostics);
    assert.equal(
      hostEvents.filter(({ event }) => event === GraphEvents.ON_REASONING_DELTA).length,
      1,
      'Pi reasoning deltas map to the host reasoning event',
    );
    assert.equal(
      hostEvents.filter(({ event }) => event === GraphEvents.ON_MESSAGE_DELTA).length,
      1,
      'Pi text deltas map to the host message event',
    );
    assert.deepEqual(
      identityRequests.map(({ contentType }) => contentType),
      ['think', 'text'],
    );
    assert.deepEqual(
      contentAggregator.contentParts.filter(Boolean).map((part) => ({
        type: part.type,
        text: part.text,
        think: part.think,
      })),
      [
        { type: 'think', text: undefined, think: 'provider reasoning' },
        { type: 'text', text: 'Pi adapter stream', think: undefined },
      ],
    );
    assert.deepEqual(
      hostEvents
        .filter(({ event }) => event === GraphEvents.ON_RUN_STEP_CLOSED)
        .map(({ data }) => data.status),
      ['completed', 'completed'],
      'the host sees terminal closure for streamed content steps',
    );
  } finally {
    try {
      await session?.dispose();
    } finally {
      await fakeProvider.close();
    }
  }
  assert.equal(bindingDisposals, 1);
});

test('Pi host session continues an exact restored tool-result transcript without replaying the prompt', async () => {
  const fakeProvider = await createFakeChatServer();
  let bindingDisposals = 0;
  let session;

  try {
    const modelBinding = await createFakeOpenAIModelBinding(fakeProvider.baseUrl, () => {
      bindingDisposals += 1;
    });
    session = await createHostPiSession({
      createModelBinding: async () => modelBinding,
      systemPrompt: 'Continue the reviewed tool call.',
      tools: [],
      history: [
        { role: 'user', content: 'Search for the maintenance manual.', timestamp: 100 },
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'pi-reviewed-call',
              name: Tools.file_search,
              arguments: { query: 'maintenance manual' },
            },
          ],
          api: modelBinding.model.api,
          provider: modelBinding.model.provider,
          model: modelBinding.model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'toolUse',
          timestamp: 101,
        },
        {
          role: 'toolResult',
          toolCallId: 'pi-reviewed-call',
          toolName: Tools.file_search,
          content: [{ type: 'text', text: 'Approved search result.' }],
          isError: false,
          timestamp: 102,
        },
      ],
    });
    let streamedText = '';
    session.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        streamedText += event.assistantMessageEvent.delta;
      }
    });

    await session.continueFromToolResult('pi-reviewed-call');

    assert.equal(fakeProvider.getRequestCount(), 1);
    assert.ok(
      JSON.stringify(fakeProvider.getRequestBody()).includes('Approved search result.'),
      'the approved host result reaches the next Pi model turn',
    );
    assert.equal(streamedText, 'Pi adapter stream');
    assert.equal(bindingDisposals, 0, 'the session retains the binding until host disposal');
  } finally {
    try {
      await session?.dispose();
    } finally {
      await fakeProvider.close();
    }
  }

  assert.equal(bindingDisposals, 1);
});

test('Pi host session drains cancellation of an active restored tool-result continuation', async () => {
  const fakeProvider = await createFakeChatServer({ responseDelayMs: 1000 });
  const controller = new AbortController();
  let bindingDisposals = 0;
  let session;

  try {
    const modelBinding = await createFakeOpenAIModelBinding(fakeProvider.baseUrl, () => {
      bindingDisposals += 1;
    });
    session = await createHostPiSession({
      createModelBinding: async () => modelBinding,
      systemPrompt: 'Cancel a restored tool-result continuation.',
      tools: [],
      signal: controller.signal,
      history: [
        { role: 'user', content: 'Search the maintenance manual.', timestamp: 100 },
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'pi-cancelled-call',
              name: Tools.file_search,
              arguments: { query: 'maintenance manual' },
            },
          ],
          api: modelBinding.model.api,
          provider: modelBinding.model.provider,
          model: modelBinding.model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'toolUse',
          timestamp: 101,
        },
        {
          role: 'toolResult',
          toolCallId: 'pi-cancelled-call',
          toolName: Tools.file_search,
          content: [{ type: 'text', text: 'Approved search result.' }],
          isError: false,
          timestamp: 102,
        },
      ],
    });

    const continuation = session.continueFromToolResult('pi-cancelled-call');
    const requestDeadline = Date.now() + 3000;
    while (fakeProvider.getRequestCount() === 0 && Date.now() < requestDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fakeProvider.getRequestCount(), 1, 'the continuation provider request started');
    controller.abort();
    await withTimeout(
      continuation.catch(() => undefined),
      3000,
      'Pi restored continuation did not drain after abort',
    );
    const cancellationDeadline = Date.now() + 1000;
    while (!fakeProvider.wasClientCancelled() && Date.now() < cancellationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fakeProvider.wasClientCancelled(), true);
  } finally {
    try {
      await session?.dispose();
    } finally {
      await fakeProvider.close();
    }
  }

  assert.equal(bindingDisposals, 1, 'the binding is disposed after the continuation drains');
});

test('Pi generation dispatcher streams a host-formatted turn and reports provider usage', async () => {
  const hostEvents = [];
  let contextUsagePrecededProviderRequest = false;
  const fakeProvider = await createFakeChatServer({
    onRequest: () => {
      contextUsagePrecededProviderRequest = hostEvents.some(
        (event) => event.event === UsageEvents.ON_CONTEXT_USAGE,
      );
    },
  });
  let bindingDisposals = 0;
  let stepIndex = 0;

  try {
    const outcome = await executePiGeneration({
      messages: [
        new SystemMessage('Use the configured test provider.'),
        new HumanMessage('Say exactly: Pi adapter stream'),
      ],
      createModelBinding: () =>
        createFakeOpenAIModelBinding(fakeProvider.baseUrl, () => {
          bindingDisposals += 1;
        }),
      createStepIdentity: () => ({
        id: `dispatch-step-${stepIndex}`,
        index: stepIndex++,
        messageId: 'dispatch-message-1',
        runId: 'dispatch-run-1',
        agentId: 'dispatch-agent-1',
      }),
      usageAttribution: { provider: 'openAI', agentId: 'dispatch-agent-1' },
      contextUsage: {
        tokenCounter: (message) => (message._getType() === 'system' ? 18 : 27),
        runId: 'dispatch-run-1',
        agentId: 'dispatch-agent-1',
        calibrationRatio: 1,
      },
      handleHostEvent: (event) => hostEvents.push(event),
    });

    assert.equal(outcome.status, 'completed');
    assert.equal(fakeProvider.getRequestCount(), 1);
    assert.equal(contextUsagePrecededProviderRequest, true);
    assert.equal(bindingDisposals, 1, 'the dispatched generation disposes its provider binding');
    assert.equal(outcome.usage.length, 1, 'provider usage is collected once per model call');
    assert.equal(outcome.usage[0].runId, 'dispatch-run-1');
    const contextUsageIndex = hostEvents.findIndex(
      (event) => event.event === UsageEvents.ON_CONTEXT_USAGE,
    );
    const tokenUsageIndex = hostEvents.findIndex(
      (event) => event.event === UsageEvents.ON_TOKEN_USAGE,
    );
    assert.ok(contextUsageIndex >= 0 && contextUsageIndex < tokenUsageIndex);
    assert.ok(
      hostEvents.some(
        (event) =>
          event.event === GraphEvents.ON_MESSAGE_DELTA &&
          event.data.delta.content.some((part) => part.text === 'Pi adapter stream'),
      ),
    );
  } finally {
    await fakeProvider.close();
  }
});

test('Pi dispatcher pauses at the tool gate without host effects or terminal tool steps', async () => {
  const fakeProvider = await createFakeChatServer({
    toolCallOnFirst: true,
    toolCallName: Tools.file_search,
    toolCallArguments: '{"query":"maintenance manual"}',
  });
  const hostEvents = [];
  let bindingDisposals = 0;
  let hostToolCalls = 0;
  const usageHandlerStarted = deferred();
  const releaseUsageHandler = deferred();
  let generationSettled = false;

  try {
    const generation = executePiGeneration({
      messages: [
        new SystemMessage('Use the configured test provider.'),
        new HumanMessage('Search for the maintenance manual.'),
      ],
      createModelBinding: () =>
        createFakeOpenAIModelBinding(fakeProvider.baseUrl, () => {
          bindingDisposals += 1;
        }),
      toolDefinitions: [
        {
          name: Tools.file_search,
          description: 'Search agent files.',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
      executeHostToolCall: async () => {
        hostToolCalls += 1;
        return { toolCallId: 'host-call-1', status: 'success', content: 'unexpected result' };
      },
      createToolStepIdentity: () => ({
        id: 'paused-tool-step',
        index: 0,
        messageId: 'pause-response',
        runId: 'pause-run',
        agentId: 'pause-agent',
      }),
      createToolCallId: () => 'host-call-1',
      toolExecutionGate: async (call) => {
        assert.equal(call.name, Tools.file_search);
        assert.deepEqual(call.args, { query: 'maintenance manual' });
        return { kind: 'pause', allowedDecisions: ['approve', 'reject'] };
      },
      createStepIdentity: () => ({
        id: 'pause-content-step',
        index: 0,
        messageId: 'pause-response',
        runId: 'pause-run',
        agentId: 'pause-agent',
      }),
      handleHostEvent: async (event) => {
        if (event.event === UsageEvents.ON_TOKEN_USAGE) {
          usageHandlerStarted.resolve();
          await releaseUsageHandler.promise;
        }
        hostEvents.push(event);
      },
    });
    const boundedGeneration = withTimeout(
      generation,
      5_000,
      'Pi did not settle after the host tool gate requested a pause',
    );
    await withTimeout(
      usageHandlerStarted.promise,
      5_000,
      'Pi did not settle the fake provider response after the pause request',
    );
    await Promise.resolve();
    assert.equal(generationSettled, false, 'pause waits for sequenced host events to drain');
    releaseUsageHandler.resolve();
    const outcome = await boundedGeneration;
    generationSettled = true;

    assert.equal(outcome.status, 'paused');
    assert.deepEqual(outcome.signal, {
      kind: 'tool_approval',
      toolCall: {
        toolCallId: 'call_safe_query',
        name: Tools.file_search,
        args: { query: 'maintenance manual' },
        hostExecution: {
          toolCallId: 'host-call-1',
          toolTurn: 0,
          stepIdentity: {
            id: 'paused-tool-step',
            index: 0,
            messageId: 'pause-response',
            runId: 'pause-run',
            agentId: 'pause-agent',
          },
          createdAt: outcome.signal.toolCall.hostExecution.createdAt,
        },
        review: { allowedDecisions: ['approve', 'reject'] },
      },
    });
    assert.equal(
      Number.isSafeInteger(outcome.signal.toolCall.hostExecution.createdAt),
      true,
      'pause carries the durable host-step timestamp',
    );
    assert.equal(fakeProvider.getRequestCount(), 1, 'pause stops the next model request');
    assert.equal(hostToolCalls, 0, 'the host handler is not invoked before approval');
    assert.equal(bindingDisposals, 1, 'the per-run provider binding is disposed');
    assert.equal(
      hostEvents.some(({ event }) => event === UsageEvents.ON_TOKEN_USAGE),
      true,
      'Pi settles and the sequenced usage event is drained before pause returns',
    );
    assert.deepEqual(
      hostEvents.find(
        (event) =>
          event.event === GraphEvents.ON_RUN_STEP && event.data.type === StepTypes.TOOL_CALLS,
      )?.data,
      {
        id: 'paused-tool-step',
        runId: 'pause-run',
        agentId: 'pause-agent',
        type: StepTypes.TOOL_CALLS,
        index: 0,
        created_at: outcome.signal.toolCall.hostExecution.createdAt,
        status: 'in_progress',
        stepDetails: {
          type: StepTypes.TOOL_CALLS,
          tool_calls: [
            {
              id: 'host-call-1',
              type: 'tool_call',
              name: Tools.file_search,
              args: { query: 'maintenance manual' },
            },
          ],
        },
      },
      'the approval is tied to one durable in-progress host step',
    );
    assert.equal(
      hostEvents.some(
        (event) =>
          event.event === GraphEvents.ON_RUN_STEP_COMPLETED ||
          (event.event === GraphEvents.ON_RUN_STEP_CLOSED &&
            event.data.type === StepTypes.TOOL_CALLS),
      ),
      false,
      'an unexecuted proposal must not emit a terminal host tool step',
    );
  } finally {
    releaseUsageHandler.resolve();
    await fakeProvider.close();
  }
});

for (const [scenario, siblingToolCallId, expectedReason] of [
  ['mixed execute/pause decisions', 'call_sibling', 'multiple_tool_calls'],
  ['repeated provider call ID', 'call_safe_query', 'provider_event'],
]) {
  test(`Pi dispatcher rejects ${scenario} before host effects`, async () => {
    const fakeProvider = await createFakeChatServer({
      toolCallOnFirst: true,
      siblingToolCallOnFirst: true,
      siblingToolCallId,
      toolCallName: Tools.file_search,
      toolCallArguments: '{"query":"maintenance manual"}',
    });
    const hostEvents = [];
    let hostToolCalls = 0;
    let gateCalls = 0;

    try {
      const outcome = await withTimeout(
        executePiGeneration({
          messages: [
            new SystemMessage('Use the configured test provider.'),
            new HumanMessage('Search for two maintenance documents.'),
          ],
          createModelBinding: () =>
            createFakeOpenAIModelBinding(fakeProvider.baseUrl, () => undefined),
          toolDefinitions: [
            {
              name: Tools.file_search,
              description: 'Search agent files.',
              parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
              },
            },
          ],
          executeHostToolCall: async () => {
            hostToolCalls += 1;
            return { toolCallId: 'host-call-1', status: 'success', content: 'unexpected result' };
          },
          createToolStepIdentity: () => ({
            id: 'unsupported-tool-step',
            index: 0,
            messageId: 'unsupported-response',
            runId: 'unsupported-run',
            agentId: 'unsupported-agent',
          }),
          createToolCallId: () => 'host-call-1',
          toolExecutionGate: async () => {
            gateCalls += 1;
            return gateCalls === 1
              ? { kind: 'execute' }
              : { kind: 'pause', allowedDecisions: ['approve', 'reject'] };
          },
          createStepIdentity: () => ({
            id: 'unsupported-content-step',
            index: 0,
            messageId: 'unsupported-response',
            runId: 'unsupported-run',
            agentId: 'unsupported-agent',
          }),
          handleHostEvent: (event) => {
            hostEvents.push(event);
          },
        }),
        5_000,
        'Pi did not settle the unsupported tool batch',
      );

      assert.equal(outcome.status, 'unsupported');
      assert.equal(outcome.reason, expectedReason);
      if (scenario === 'repeated provider call ID') {
        assert.deepEqual(outcome.failure, {
          kind: 'repeated_call_id',
          api: 'openai-completions',
          callId: 'call_safe_query',
          firstIndex: 0,
          repeatedIndex: 1,
        });
      }
      assert.equal(
        fakeProvider.getRequestCount(),
        1,
        'no model continuation follows the unsupported batch',
      );
      assert.equal(
        gateCalls,
        0,
        'the whole assistant tool-call batch is rejected before any per-tool gate decision',
      );
      assert.equal(hostToolCalls, 0, 'no call in the batch reaches the host tool handler');
      assert.equal(
        hostEvents.some(
          (event) =>
            (event.event === GraphEvents.ON_RUN_STEP && event.data.type === StepTypes.TOOL_CALLS) ||
            (event.event === GraphEvents.ON_RUN_STEP_CLOSED &&
              event.data.type === StepTypes.TOOL_CALLS),
        ),
        false,
        'blocked unexecuted calls do not create or close host tool steps',
      );
    } finally {
      await fakeProvider.close();
    }
  });
}

test('Pi tool gate fails closed before provider invocation for uncovered APIs', async () => {
  const fakeProvider = await createFakeChatServer();
  let bindingDisposals = 0;
  let gateCalls = 0;
  let hostEvents = 0;

  try {
    await assert.rejects(
      executePiGeneration({
        messages: [
          new SystemMessage('Use the configured test provider.'),
          new HumanMessage('Run a host tool.'),
        ],
        createModelBinding: () =>
          createFakeOpenAIModelBinding(
            fakeProvider.baseUrl,
            () => {
              bindingDisposals += 1;
            },
            'anthropic-messages',
          ),
        toolExecutionGate: async () => {
          gateCalls += 1;
          return { kind: 'execute' };
        },
        createStepIdentity: () => ({
          id: 'unsupported-api-step',
          index: 0,
          messageId: 'unsupported-api-message',
          runId: 'unsupported-api-run',
          agentId: 'unsupported-api-agent',
        }),
        handleHostEvent: () => {
          hostEvents += 1;
        },
      }),
      { name: 'AgentRuntimeUnavailableError' },
    );

    assert.equal(fakeProvider.getRequestCount(), 0, 'uncovered adapters do not reach the provider');
    assert.equal(bindingDisposals, 1, 'the rejected request-scoped binding is disposed');
    assert.equal(gateCalls, 0, 'the tool gate is never evaluated');
    assert.equal(hostEvents, 0, 'no host events are emitted');
  } finally {
    await fakeProvider.close();
  }
});

test('Pi dispatch fails closed before provider invocation when host context usage cannot be measured', async () => {
  const fakeProvider = await createFakeChatServer();
  let bindingDisposals = 0;
  const hostEvents = [];

  try {
    await assert.rejects(
      executePiGeneration({
        messages: [new SystemMessage('Context usage boundary.'), new HumanMessage('Say hello.')],
        createModelBinding: () =>
          createFakeOpenAIModelBinding(fakeProvider.baseUrl, () => {
            bindingDisposals += 1;
          }),
        createStepIdentity: () => ({
          id: 'unmeasured-step',
          index: 0,
          messageId: 'unmeasured-message',
          runId: 'unmeasured-run',
          agentId: 'unmeasured-agent',
        }),
        usageAttribution: { provider: 'openAI', agentId: 'unmeasured-agent' },
        contextUsage: {
          tokenCounter: () => Number.NaN,
          runId: 'unmeasured-run',
          agentId: 'unmeasured-agent',
        },
        handleHostEvent: (event) => hostEvents.push(event),
      }),
      (error) => error instanceof PiContextUsageUnavailableError,
    );

    assert.equal(fakeProvider.getRequestCount(), 0, 'Pi fails before contacting the provider');
    assert.equal(hostEvents.length, 0, 'the host does not receive a false context snapshot');
    assert.equal(bindingDisposals, 1, 'the untransferred binding is disposed after the failure');
  } finally {
    await fakeProvider.close();
  }
});

test('Pi dispatch fails closed before provider invocation when the unpruned transcript is over budget', async () => {
  const fakeProvider = await createFakeChatServer();
  let bindingDisposals = 0;
  const hostEvents = [];

  try {
    await assert.rejects(
      executePiGeneration({
        messages: [new SystemMessage('Context usage boundary.'), new HumanMessage('Say hello.')],
        createModelBinding: () =>
          createFakeOpenAIModelBinding(fakeProvider.baseUrl, () => {
            bindingDisposals += 1;
          }),
        createStepIdentity: () => ({
          id: 'over-budget-step',
          index: 0,
          messageId: 'over-budget-message',
          runId: 'over-budget-run',
          agentId: 'over-budget-agent',
        }),
        usageAttribution: { provider: 'openAI', agentId: 'over-budget-agent' },
        contextUsage: {
          /** 230 × system + user + reply primer exceeds the 450-token
           *  effective cap, but fits the 500-token model cap without reserve. */
          tokenCounter: () => 230,
          maxContextTokens: 500,
          reserveRatio: 0.1,
          runId: 'over-budget-run',
          agentId: 'over-budget-agent',
        },
        handleHostEvent: (event) => hostEvents.push(event),
      }),
      (error) => error instanceof PiContextBudgetExceededError,
    );

    assert.equal(fakeProvider.getRequestCount(), 0, 'the over-budget transcript never reaches Pi');
    assert.equal(
      hostEvents.length,
      0,
      'the host does not receive a context snapshot for an invalid turn',
    );
    assert.equal(bindingDisposals, 1, 'the model binding is disposed after the projection fails');
  } finally {
    await fakeProvider.close();
  }
});

test('Pi host session cancels its active provider request when the job signal aborts', async () => {
  const fakeProvider = await createFakeChatServer({ responseDelayMs: 1000 });
  const controller = new AbortController();
  let bindingDisposals = 0;
  let generationAborted = false;
  let session;

  try {
    session = await createHostPiSession({
      createModelBinding: () =>
        createFakeOpenAIModelBinding(fakeProvider.baseUrl, () => {
          bindingDisposals += 1;
        }),
      systemPrompt: 'Abort the provider request when the host job stops.',
      tools: [],
      signal: controller.signal,
    });
    session.subscribe((event) => {
      if (event.type === 'agent_settled') {
        generationAborted = event.aborted;
      }
    });

    const prompt = session.prompt('Wait for a provider response that will be cancelled.');
    const timeout = Date.now() + 3000;
    while (fakeProvider.getRequestCount() === 0 && Date.now() < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fakeProvider.getRequestCount(), 1, 'the provider request started');
    controller.abort();
    await withTimeout(
      prompt.catch(() => undefined),
      3000,
      'Pi abort timed out',
    );
    const cancellationDeadline = Date.now() + 1000;
    while (!fakeProvider.wasClientCancelled() && Date.now() < cancellationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    try {
      await session?.dispose();
    } finally {
      await fakeProvider.close();
    }
  }

  assert.equal(generationAborted, true);
  assert.equal(fakeProvider.wasClientCancelled(), true);
  assert.equal(bindingDisposals, 1);
});

test('Pi host sessions isolate tool loadouts across concurrent generations', async () => {
  const generations = await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      let bindingDisposals = 0;
      const session = await createHostPiSession({
        createModelBinding: () =>
          createTestModelBinding(() => {
            bindingDisposals += 1;
          }),
        systemPrompt: `Concurrent session ${index}.`,
        tools: [
          {
            name: `safe_query_${index}`,
            label: 'Safe query',
            description: 'Query authorized factory data.',
            parameters: Type.Object({ query: Type.String() }),
            execute: async () => ({ content: [{ type: 'text', text: String(index) }] }),
          },
        ],
      });
      return { index, session, getBindingDisposals: () => bindingDisposals };
    }),
  );

  try {
    for (const { index, session } of generations) {
      assert.deepEqual(session.activeToolNames, [`safe_query_${index}`]);
      assert.equal(session.sessionFile, undefined);
    }
  } finally {
    await Promise.all(generations.map(({ session }) => session.dispose()));
  }

  for (const generation of generations) {
    assert.equal(generation.getBindingDisposals(), 1);
  }
});
