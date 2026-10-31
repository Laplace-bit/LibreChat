import { z } from 'zod';
import { StepEvents, Tools } from 'librechat-data-provider';
import { tool as createStructuredTool } from '@librechat/agents/langchain/tools';
import { GraphEvents, type EventHandler, type ToolExecuteBatchRequest } from '@librechat/agents';
import type { LCTool } from '@librechat/agents';
import type { PiHostEvent } from './events';
import {
  createToolExecuteHandler,
  type ToolEndCallback,
  type ToolExecuteOptions,
} from '../handlers';
import { createPiHostToolBatchExecutor } from './hostToolBatch';
import { createPiHostToolExecutor } from './toolExecution';
import { createPiHostEventSequencer } from './bridge';
import { createPiTools } from './tools';

interface FileSearchArtifact {
  [Tools.file_search]: {
    sources: Array<{
      type: 'file';
      fileId: string;
      content: string;
      fileName: string;
      relevance: number;
      pages: number[];
      pageRelevance: Record<number, number>;
    }>;
    fileCitations: true;
  };
}

interface MessageEnvelope {
  event: string;
  data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolExecuteBatchRequest(value: unknown): value is ToolExecuteBatchRequest {
  return (
    isRecord(value) &&
    Array.isArray(value.toolCalls) &&
    typeof value.resolve === 'function' &&
    typeof value.reject === 'function'
  );
}

function getMessageEnvelopes(writes: readonly string[]): MessageEnvelope[] {
  const envelopes: MessageEnvelope[] = [];
  const prefix = 'event: message\ndata: ';

  for (const chunk of writes) {
    if (!chunk.startsWith(prefix)) {
      continue;
    }
    const serialized = chunk.slice(prefix.length).replace(/\n\n$/, '');
    const parsed: unknown = JSON.parse(serialized);
    if (isRecord(parsed) && typeof parsed.event === 'string' && 'data' in parsed) {
      envelopes.push({ event: parsed.event, data: parsed.data });
    }
  }

  return envelopes;
}

describe('Pi host tool batch integration', () => {
  it('executes file_search through the real handler and preserves SSE and artifact ownership', async () => {
    const userId = 'user-pi-1';
    const agentId = 'agent-pi-1';
    const threadId = 'thread-pi-1';
    const runId = 'run-pi-1';
    const callId = 'host-call-pi-1';
    const stepId = 'host-step-pi-1';
    const query = 'maintenance manual';
    const responseText = 'Search results for ' + query;
    const source = {
      type: 'file' as const,
      fileId: 'file-pi-1',
      content: 'Inspect the gearbox every 500 hours.',
      fileName: 'maintenance.pdf',
      relevance: 0.97,
      pages: [4],
      pageRelevance: { 4: 0.97 },
    };
    const artifact: FileSearchArtifact = {
      [Tools.file_search]: {
        sources: [source],
        fileCitations: true,
      },
    };
    const toolDefinition = {
      name: Tools.file_search,
      description: 'Search files attached to this agent.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    } satisfies LCTool;
    const request = {
      user: { id: userId, tenantId: 'tenant-pi-1' },
      body: { conversationId: threadId },
      config: { endpoints: { agents: {} } },
    };
    const writes: string[] = [];
    const artifactPromises: Promise<unknown>[] = [];
    let callbackStartedResolve: (() => void) | undefined;
    const callbackStarted = new Promise<void>((resolve) => {
      callbackStartedResolve = resolve;
    });
    let releaseCallback: (() => void) | undefined;
    const callbackGate = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const order: string[] = [];
    let artifactCallbackArgs: Parameters<ToolEndCallback>[0] | undefined;
    let artifactCallbackMetadata: Parameters<ToolEndCallback>[1] | undefined;
    const toolEndCallbackMock = jest.fn(
      async (data: Parameters<ToolEndCallback>[0], metadata: Parameters<ToolEndCallback>[1]) => {
        artifactCallbackArgs = data;
        artifactCallbackMetadata = metadata;
        if (data.output.artifact == null) {
          throw new Error('Expected file_search to return an artifact.');
        }
        const attachment = {
          type: Tools.file_search,
          toolCallId: data.output.tool_call_id,
          messageId: metadata.run_id,
          conversationId: metadata.thread_id,
          userId: request.user.id,
          agentId: metadata.executingAgentId,
          stepId: metadata.stepId,
        };
        artifactPromises.push(Promise.resolve(attachment));
        writes.push('event: attachment\ndata: ' + JSON.stringify(attachment) + '\n\n');
        order.push('artifact-callback-start');
        callbackStartedResolve?.();
        await callbackGate;
        order.push('artifact-callback-finished');
      },
    );
    const toolEndCallback: ToolEndCallback = toolEndCallbackMock;
    const fakeHostTool = createStructuredTool(
      async ({ query: receivedQuery }): Promise<[string, FileSearchArtifact]> => {
        expect(receivedQuery).toBe(query);
        return [responseText, artifact];
      },
      {
        name: Tools.file_search,
        description: 'Search the agent files.',
        schema: z.object({ query: z.string() }),
        responseFormat: 'content_and_artifact',
      },
    );
    const loadTools: ToolExecuteOptions['loadTools'] = jest.fn(
      async (toolNames, loadedAgentId, configurable) => {
        expect(toolNames).toEqual([Tools.file_search]);
        expect(loadedAgentId).toBe(agentId);
        expect(configurable?.req).toBe(request);
        return { loadedTools: [fakeHostTool] };
      },
    );
    const hostToolHandler = createToolExecuteHandler({ loadTools, toolEndCallback });
    const capturedBatches: ToolExecuteBatchRequest[] = [];
    const instrumentedHostHandler: EventHandler = {
      handle: (event, data, metadata, graph) => {
        if (event === GraphEvents.ON_TOOL_EXECUTE && isToolExecuteBatchRequest(data)) {
          capturedBatches.push(data);
          const resolveBatch = data.resolve;
          data.resolve = (results) => {
            order.push('batch-resolve');
            resolveBatch(results);
          };
        }
        return hostToolHandler.handle(event, data, metadata, graph);
      },
    };
    const piMetadata = {
      thread_id: threadId,
      user_id: userId,
      run_id: runId,
      agent_id: agentId,
      agentId,
      last_agent_id: agentId,
      langgraph_node: 'agent=' + agentId,
      hide_sequential_outputs: false,
    };
    const eventSequencer = createPiHostEventSequencer(async (event: PiHostEvent) => {
      writes.push(
        'event: message\ndata: ' +
          JSON.stringify({ event: event.event, data: event.data }) +
          '\n\n',
      );
    });
    const executeHostToolCall = createPiHostToolBatchExecutor({
      handler: instrumentedHostHandler,
      userId,
      agentId,
      request,
      threadId,
      runId,
      metadata: piMetadata,
    });
    const executePiTool = createPiHostToolExecutor({
      createStepIdentity: () => ({
        id: stepId,
        index: 0,
        messageId: 'assistant-message-pi-1',
        runId,
        agentId,
      }),
      createToolCallId: () => callId,
      executeHostToolCall,
      handleHostEvent: eventSequencer.enqueue,
      now: () => 100,
    });
    const [piTool] = createPiTools({ definitions: [toolDefinition], execute: executePiTool });
    if (piTool == null) {
      throw new Error('Expected the file_search Pi tool definition.');
    }

    let piResultSettled = false;
    const piResultPromise = piTool.execute('pi-provider-call-1', { query }).then((result) => {
      piResultSettled = true;
      order.push('pi-result');
      return result;
    });

    await callbackStarted;
    expect(piResultSettled).toBe(false);
    expect(order).toEqual(['artifact-callback-start']);
    expect(toolEndCallbackMock).toHaveBeenCalledTimes(1);
    expect(capturedBatches).toHaveLength(1);

    const [batch] = capturedBatches;
    if (batch == null) {
      throw new Error('Expected the host tool batch.');
    }
    expect(batch.toolCalls).toEqual([
      {
        id: callId,
        name: Tools.file_search,
        args: { query },
        stepId,
      },
    ]);
    expect(batch.userId).toBe(userId);
    expect(batch.agentId).toBe(agentId);
    expect(batch.configurable).toMatchObject({
      req: request,
      user_id: userId,
      thread_id: threadId,
      run_id: runId,
    });
    expect(batch.metadata).toMatchObject({
      user_id: userId,
      agent_id: agentId,
      thread_id: threadId,
      run_id: runId,
    });
    expect(artifactCallbackArgs).toMatchObject({
      input: { query },
      output: {
        name: Tools.file_search,
        tool_call_id: callId,
        content: responseText,
        artifact,
      },
    });
    expect(artifactCallbackMetadata).toMatchObject({
      run_id: runId,
      thread_id: threadId,
      executingAgentId: agentId,
      stepId,
    });

    if (releaseCallback == null) {
      throw new Error('Expected the artifact callback gate to be available.');
    }
    releaseCallback();

    await expect(piResultPromise).resolves.toEqual({
      content: [{ type: 'text', text: responseText }],
      details: { status: 'success' },
    });
    await eventSequencer.drain();
    const [attachment] = await Promise.all(artifactPromises);

    expect(order).toEqual([
      'artifact-callback-start',
      'artifact-callback-finished',
      'batch-resolve',
      'pi-result',
    ]);
    expect(attachment).toMatchObject({
      type: Tools.file_search,
      toolCallId: callId,
      messageId: runId,
      conversationId: threadId,
      userId,
      agentId,
      stepId,
    });
    expect(writes.some((chunk) => chunk.startsWith('event: attachment\ndata: '))).toBe(true);

    const emittedEvents = getMessageEnvelopes(writes);
    expect(emittedEvents.map(({ event }) => event)).toEqual([
      GraphEvents.ON_RUN_STEP,
      StepEvents.ON_TOOL_CALLS_DISPATCHED,
      GraphEvents.ON_RUN_STEP_COMPLETED,
      GraphEvents.ON_RUN_STEP_CLOSED,
    ]);
    expect(emittedEvents[emittedEvents.length - 1]?.data).toMatchObject({
      id: stepId,
      status: 'completed',
    });
  });
});
