import type {
  AgentSession,
  AgentSessionEventListener,
  ModelRuntime,
  PromptOptions,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { PiHistoryMessage } from './history';
import type { PiPauseController } from './pause';
import { createPiProviderEventObserver, isPiToolBatchEventApi } from './providerEvents';
import { AgentRuntimeUnavailableError } from '../runtime/selection';

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
  tools: ToolDefinition[];
  /** Structured, server-converted history; each message remains a separate Pi entry. */
  history?: PiHistoryMessage[];
  /** Rejects multi-call tool batches before any tool gate or host handler runs. */
  toolBatchPolicy?: { controller: PiPauseController };
  signal?: AbortSignal;
}

/** Narrow, host-owned surface. The mutable Pi session itself is never exposed. */
export interface HostPiSession {
  readonly sessionFile: undefined;
  readonly activeToolNames: readonly string[];
  subscribe(listener: AgentSessionEventListener): () => void;
  prompt(text: string, options?: PromptOptions): Promise<void>;
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
      await session.abort();
    })();
    return abortPromise;
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
      }),
      customTools: options.tools,
    });
    session = result.session;

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
        await currentSession.prompt(text, promptOptions);
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
