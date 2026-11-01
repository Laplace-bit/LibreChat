import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventListener,
  ModelRuntime,
  PromptOptions,
} from '@earendil-works/pi-coding-agent';
import type { PiContentPart, PiHistoryMessage } from './history';
import type { PiPauseController } from './pause';
import type { PiToolDefinition } from './tools';
import { createPiProviderEventObserver, isPiToolBatchEventApi } from './providerEvents';
import { AgentRuntimeUnavailableError } from '../runtime/selection';

type PiAgentMessage = Extract<AgentSessionEvent, { type: 'message_start' }>['message'];

export interface PiModelBinding {
  /** A request-scoped model selected from the caller's authorized configuration. */
  model: NonNullable<AgentSession['model']>;
  /** A request-scoped runtime containing only this run's provider credentials. */
  modelRuntime: ModelRuntime;
  dispose(): void | Promise<void>;
}

export interface HostPiSessionOptions {
  /** Must return a fresh credential/runtime binding for this generation. */
  createModelBinding(): Promise<PiModelBinding>;
  systemPrompt: string;
  tools: PiToolDefinition[];
  /** Structured, server-converted history; each message remains a separate Pi entry. */
  history?: PiHistoryMessage[];
  /** Rejects multi-call tool batches before any tool gate or host handler runs. */
  toolBatchPolicy?: { controller: PiPauseController };
  signal?: AbortSignal;
  /**
   * Runs at Pi's awaited finish-turn boundary, after tool results are persisted
   * and before the next provider request polls the steering queue.
   */
  onTurnEnd?(context: HostPiTurnEndContext): void | Promise<void>;
}

export interface HostPiTurnEndContext {
  signal?: AbortSignal;
  steer: AgentSession['steer'];
}

/** Narrow, host-owned surface. The mutable Pi session itself is never exposed. */
export interface HostPiSession {
  readonly sessionFile: undefined;
  readonly activeToolNames: readonly string[];
  subscribe(listener: AgentSessionEventListener): () => void;
  prompt(text: string, options?: PromptOptions): Promise<void>;
  /** Starts a normal AgentSession prompt while retaining the source order of text and images. */
  promptContent(content: readonly PiContentPart[]): Promise<void>;
  /**
   * Continue a restored transcript whose final message is the result for exactly
   * one preceding assistant tool call. This uses Pi's public Agent continuation
   * API; the host wrapper owns cancellation and waits for it before disposal.
   */
  continueFromToolResult(toolCallId: string): Promise<void>;
  steer: AgentSession['steer'];
  followUp: AgentSession['followUp'];
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

function abortError(): Error {
  const error = new Error('Pi generation was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Creates an isolated Pi session for one host-owned generation.
 *
 * LibreChat supplies the already-authorized model and tools. Pi's filesystem,
 * extension, skill, prompt, theme, MCP, and built-in tool discovery is disabled
 * so the session cannot silently add local capabilities from the API process.
 */
export async function createHostPiSession(options: HostPiSessionOptions): Promise<HostPiSession> {
  if (options.signal?.aborted) {
    throw abortError();
  }

  const modelBinding = await options.createModelBinding();
  let session: AgentSession | undefined;
  let disposed = false;
  let promptStarted = false;
  let activeOperation: Promise<void> | undefined;
  let activeOperationKind: 'prompt' | 'tool_result_continuation' | undefined;
  let abortPromise: Promise<void> | undefined;

  const requireSession = () => {
    if (disposed || session == null) {
      throw new Error('Pi generation is already disposed');
    }
    if (options.signal?.aborted) {
      throw abortError();
    }
    return session;
  };

  const requestAbort = () => {
    if (disposed || session == null) {
      return Promise.resolve();
    }
    abortPromise ??= (async () => {
      if (activeOperationKind === 'tool_result_continuation') {
        /**
         * AgentSession.abort() waits on its own `_isAgentRunActive` flag. A
         * direct Agent.continue() deliberately does not set that private flag,
         * so abort the public Agent operation and await its exact promise.
         */
        session.agent.abort();
        await activeOperation?.catch(() => undefined);
        return;
      }
      await session.abort();
    })();
    return abortPromise;
  };

  const runOperation = async (
    kind: NonNullable<typeof activeOperationKind>,
    start: () => Promise<void>,
  ) => {
    if (activeOperation != null) {
      throw new Error('Pi generation already has an active operation');
    }
    const operation = start();
    activeOperation = operation;
    activeOperationKind = kind;
    try {
      await operation;
    } finally {
      if (activeOperation === operation) {
        activeOperation = undefined;
        activeOperationKind = undefined;
      }
    }
  };

  const validateToolResultContinuation = (toolCallId: string) => {
    if (toolCallId.length === 0) {
      throw new Error('Pi continuation requires a tool call identity');
    }
    const messages = requireSession().messages;
    const toolResult = messages[messages.length - 1];
    const assistant = messages[messages.length - 2];
    if (toolResult?.role !== 'toolResult' || assistant?.role !== 'assistant') {
      throw new Error('Pi continuation requires an assistant tool call followed by its result');
    }
    const toolCalls = assistant.content.filter((part) => part.type === 'toolCall');
    if (
      toolCalls.length !== 1 ||
      toolCalls[0].id !== toolCallId ||
      toolResult.toolCallId !== toolCallId ||
      toolResult.toolName !== toolCalls[0].name
    ) {
      throw new Error('Pi continuation transcript does not match the reviewed tool call');
    }
  };

  const dispose = async () => {
    if (disposed) {
      return;
    }
    const abortOperation = requestAbort();
    disposed = true;
    options.signal?.removeEventListener('abort', abort);

    const cleanupErrors: unknown[] = [];
    try {
      await abortOperation;
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      session?.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await modelBinding.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Failed to dispose Pi generation resources');
    }
  };

  const abort = () => {
    if (disposed || session == null) {
      return;
    }
    void requestAbort().catch(() => undefined);
  };

  try {
    if (options.toolBatchPolicy != null && !isPiToolBatchEventApi(modelBinding.model.api)) {
      throw new AgentRuntimeUnavailableError();
    }
    if (options.signal?.aborted) {
      throw abortError();
    }
    // The SDK is ESM-only while this workspace emits CommonJS, so this is the
    // runtime boundary that loads Pi without introducing require(ESM) failures.
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } =
      await import('@earendil-works/pi-coding-agent');
    // This is a logical label, not a host workspace. Pi has no filesystem
    // tools or resource discovery, and host tools must use authorized APIs.
    const cwd = '/librechat-agent';
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: options.systemPrompt,
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory(cwd);
    for (const message of options.history ?? []) {
      sessionManager.appendMessage(message);
    }

    const result = await createAgentSession({
      cwd,
      agentDir: cwd,
      model: modelBinding.model,
      modelRuntime: modelBinding.modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager: SettingsManager.inMemory({
        defaultTools: options.tools.map(({ name }) => name),
        // Pi's private compaction is not a durable LibreChat checkpoint and
        // its summarization usage is not reported through the host lifecycle.
        compaction: { enabled: false },
      }),
      customTools: options.tools,
    });
    session = result.session;

    if (options.onTurnEnd != null) {
      const previousFinishTurn = session.agent.finishTurn;
      session.agent.finishTurn = async (turn, signal) => {
        const decision = (await previousFinishTurn?.(turn, signal)) as
          | { action: 'continue' }
          | { action: 'end' }
          | undefined;
        if (
          turn.message.stopReason !== 'error' &&
          turn.message.stopReason !== 'aborted' &&
          decision?.action !== 'end' &&
          signal?.aborted !== true &&
          options.signal?.aborted !== true
        ) {
          await options.onTurnEnd?.({
            signal,
            steer: (text, images, steerOptions) =>
              requireSession().steer(text, images, steerOptions),
          });
        }
        return decision;
      };
    }

    if (options.toolBatchPolicy != null) {
      const previousProviderStreamEvent = session.agent.onProviderStreamEvent;
      const providerEventObserver = createPiProviderEventObserver();
      session.agent.onProviderStreamEvent = async (event, model) => {
        if (!isPiToolBatchEventApi(model.api)) {
          options.toolBatchPolicy?.controller.rejectProviderEvent({
            kind: 'unsupported_api',
            api: model.api,
          });
          abort();
        } else {
          const providerFailure = providerEventObserver.observe(model.api, event);
          if (providerFailure != null) {
            options.toolBatchPolicy?.controller.rejectProviderEvent(providerFailure);
            abort();
          }
        }
        await previousProviderStreamEvent?.(event, model);
      };

      const previousBeforeToolCall = session.agent.beforeToolCall;
      session.agent.beforeToolCall = async (context, signal) => {
        const previousResult = await previousBeforeToolCall?.(context, signal);
        if (signal?.aborted) {
          return previousResult;
        }

        const toolCalls = context.assistantMessage.content.filter(
          (part) => part.type === 'toolCall',
        );
        if (toolCalls.length > 1) {
          options.toolBatchPolicy?.controller.rejectBatch(toolCalls.map(({ id }) => id));
          return {
            block: true,
            reason: 'This tool batch cannot be paused safely.',
            terminate: true,
          };
        }

        return previousResult;
      };
    }

    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      throw abortError();
    }

    return {
      sessionFile: undefined,
      get activeToolNames() {
        if (disposed) {
          return [];
        }
        return session?.agent.state.tools.map(({ name }) => name) ?? [];
      },
      subscribe(listener) {
        return requireSession().subscribe(listener);
      },
      async prompt(text, promptOptions) {
        const currentSession = requireSession();
        if (promptStarted) {
          throw new Error('A Pi host session accepts one initial prompt per generation');
        }
        promptStarted = true;
        await runOperation('prompt', () => currentSession.prompt(text, promptOptions));
      },
      async promptContent(content) {
        const currentSession = requireSession();
        if (promptStarted) {
          throw new Error('A Pi host session accepts one initial prompt per generation');
        }
        promptStarted = true;

        const text = content
          .filter((part): part is Extract<PiContentPart, { type: 'text' }> => part.type === 'text')
          .map(({ text: partText }) => partText)
          .join('');
        const images = content.filter(
          (part): part is Extract<PiContentPart, { type: 'image' }> => part.type === 'image',
        );

        await runOperation('prompt', async () => {
          const originalPrompt = currentSession.agent.prompt;
          const callOriginalPrompt = originalPrompt.bind(currentSession.agent);
          let intercepted = false;

          const applyOrderedContent = (messages: typeof currentSession.agent.state.messages) => {
            if (intercepted) {
              return messages;
            }

            const userIndex = messages.findIndex((message) => message.role === 'user');
            const userMessage = messages[userIndex];
            if (
              userIndex < 0 ||
              userMessage?.role !== 'user' ||
              !Array.isArray(userMessage.content)
            ) {
              throw new Error('Pi AgentSession did not provide an ordered user message');
            }

            const normalizedImages = userMessage.content.filter(
              (part): part is Extract<PiContentPart, { type: 'image' }> =>
                typeof part === 'object' && part !== null && part.type === 'image',
            );
            if (normalizedImages.length !== images.length) {
              throw new Error('Pi could not preserve every authorized inline prompt image');
            }

            const normalizedText = userMessage.content
              .filter(
                (part): part is Extract<PiContentPart, { type: 'text' }> =>
                  typeof part === 'object' && part !== null && part.type === 'text',
              )
              .map(({ text: partText }) => partText)
              .join('');
            if (!normalizedText.startsWith(text)) {
              throw new Error('Pi AgentSession changed the ordered prompt text');
            }

            const trailingSessionHints = normalizedText.slice(text.length);
            let imageIndex = 0;
            const orderedParts = content.map((part) => {
              if (part.type === 'text') {
                return part;
              }
              const normalizedImage = normalizedImages[imageIndex];
              imageIndex += 1;
              if (normalizedImage == null) {
                throw new Error('Pi could not preserve every authorized inline prompt image');
              }
              return normalizedImage;
            });
            if (trailingSessionHints.length > 0) {
              orderedParts.push({ type: 'text', text: trailingSessionHints });
            }

            const reordered = [...messages];
            reordered[userIndex] = { ...userMessage, content: orderedParts };
            intercepted = true;
            return reordered;
          };

          async function orderedPrompt(message: PiAgentMessage | PiAgentMessage[]): Promise<void>;
          async function orderedPrompt(
            text: string,
            promptImages?: PromptOptions['images'],
          ): Promise<void>;
          async function orderedPrompt(
            message: string | PiAgentMessage | PiAgentMessage[],
            promptImages?: PromptOptions['images'],
          ): Promise<void> {
            if (typeof message === 'string') {
              return callOriginalPrompt(message, promptImages);
            }
            if (intercepted) {
              return callOriginalPrompt(message);
            }

            const messages = Array.isArray(message) ? message : [message];
            return callOriginalPrompt(applyOrderedContent(messages));
          }

          currentSession.agent.prompt = orderedPrompt;
          try {
            await currentSession.prompt(text, {
              expandPromptTemplates: false,
              source: 'rpc',
              ...(images.length === 0 ? {} : { images }),
            });
            if (!intercepted) {
              throw new Error('Pi AgentSession did not submit the ordered prompt');
            }
          } finally {
            if (currentSession.agent.prompt === orderedPrompt) {
              currentSession.agent.prompt = originalPrompt;
            }
          }
        });
      },
      async continueFromToolResult(toolCallId) {
        const currentSession = requireSession();
        if (promptStarted) {
          throw new Error('A Pi host session accepts one generation operation');
        }
        validateToolResultContinuation(toolCallId);
        promptStarted = true;
        await runOperation('tool_result_continuation', () => currentSession.agent.continue());
      },
      steer(text, images, steerOptions) {
        return requireSession().steer(text, images, steerOptions);
      },
      followUp(text, images, followUpOptions) {
        return requireSession().followUp(text, images, followUpOptions);
      },
      async abort() {
        await requestAbort();
      },
      dispose,
    };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Failed to create Pi generation');
    }
    throw error;
  }
}
