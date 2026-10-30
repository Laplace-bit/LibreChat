import test from 'node:test';
import { Type } from 'typebox';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';

const require = createRequire(import.meta.url);
const { createHostPiSession } = require('../../../dist/index.cjs');

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

async function createFakeOpenAIModelBinding(baseUrl, onDispose) {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider('pi-integration-test', {
    name: 'Pi integration test provider',
    baseUrl,
    api: 'openai-completions',
    apiKey: 'integration-test-key',
    models: [
      {
        id: 'echo-test',
        name: 'Echo test model',
        reasoning: false,
        input: ['text'],
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

async function createFakeChatServer({ toolCallOnFirst = false, responseDelayMs = 0 } = {}) {
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
      const sendResponse = () => {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-pi-test',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'echo-test',
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          })}\n\n`,
        );
        if (toolCallOnFirst && requestCount === 1) {
          response.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-pi-test',
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
                          name: 'safe_query',
                          arguments: '{"query":"authorized"}',
                        },
                      },
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
            id: 'chatcmpl-pi-test',
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

test('Pi host session sends a prompt through its bound provider and streams the reply', async () => {
  const fakeProvider = await createFakeChatServer({ toolCallOnFirst: true });
  let bindingDisposals = 0;
  let hostToolCalls = 0;
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
  } finally {
    try {
      await session?.dispose();
    } finally {
      await fakeProvider.close();
    }
  }
  assert.equal(bindingDisposals, 1);
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
