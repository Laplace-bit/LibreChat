import { DATE_RANGE, Constants } from '@librechat/agents';
import { Constants as DataConstants, Tools } from 'librechat-data-provider';
import type { Agents } from 'librechat-data-provider';
import type { PiPauseToolCall } from './pause';
import {
  appendPiToolResultContinuation,
  buildPiApprovalInterruptPayload,
  createPiApprovalContinuation,
  matchesPiApprovalHostState,
  revalidatePiMcpApprovalArguments,
  resolvePiApprovalContinuation,
  resolvePiApprovalDecision,
} from './resume';
import { createPiMcpToolSchemaRegistry } from './mcpSchema';
import { buildPendingAction } from '~/agents/hitl/policy';
import { createPiPauseController } from './pause';

function createApproval() {
  const toolCall: PiPauseToolCall = {
    toolCallId: 'pi-call-1',
    name: Tools.file_search,
    args: { query: 'maintenance manual' },
    hostExecution: {
      toolCallId: 'host-call-1',
      toolTurn: 3,
      stepIdentity: {
        id: 'step-1',
        index: 2,
        messageId: 'response-1',
        runId: 'response-1',
        agentId: 'agent-1',
      },
      createdAt: 100,
    },
    review: { allowedDecisions: ['approve', 'reject', 'edit', 'respond'] },
  };
  const payload = buildPiApprovalInterruptPayload({
    hostToolCallId: toolCall.hostExecution.toolCallId,
    toolName: toolCall.name,
    args: toolCall.args,
    allowedDecisions: toolCall.review.allowedDecisions,
  });
  const pendingAction = buildPendingAction(payload, {
    streamId: 'conversation-1',
    conversationId: 'conversation-1',
    runId: 'response-1',
    responseMessageId: 'response-1',
  });
  return {
    toolCall,
    pendingAction,
    continuation: createPiApprovalContinuation(pendingAction.actionId, toolCall),
  };
}

function hostState(args: Record<string, unknown> = { query: 'maintenance manual' }) {
  return {
    runSteps: [
      {
        id: 'step-1',
        runId: 'response-1',
        agentId: 'agent-1',
        type: 'tool_calls',
        index: 2,
        created_at: 100,
        status: 'in_progress',
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [
            {
              id: 'host-call-1',
              type: 'function',
              function: { name: Tools.file_search, arguments: args },
            },
          ],
        },
      },
    ],
    aggregatedContent: [
      {
        type: 'tool_call',
        tool_call: {
          id: 'host-call-1',
          stepId: 'step-1',
          name: Tools.file_search,
          args: JSON.stringify(args),
        },
      },
    ],
  };
}

function createMcpApproval() {
  const name = `lookup${DataConstants.mcp_delimiter}inventory`;
  const parameters = {
    type: 'object',
    properties: { query: { type: 'string', minLength: 2 } },
    required: ['query'],
  };
  const mcpToolSchemas = createPiMcpToolSchemaRegistry([{ name, parameters }]);
  const toolName = [...mcpToolSchemas.keys()][0];
  const schema = toolName == null ? undefined : mcpToolSchemas.get(toolName);
  if (toolName == null || schema == null) {
    throw new Error('Test MCP schema failed to compile');
  }
  const toolCall = {
    kind: 'mcp' as const,
    toolCallId: 'pi-mcp-call-1',
    name: toolName,
    args: { query: 'pump' },
    schemaFingerprint: schema.fingerprint,
    hostExecution: {
      toolCallId: 'host-mcp-call-1',
      toolTurn: 1,
      stepIdentity: {
        id: 'mcp-step-1',
        index: 3,
        messageId: 'response-1',
        runId: 'response-1',
        agentId: 'agent-1',
      },
      createdAt: 101,
    },
    review: { allowedDecisions: ['approve', 'reject', 'edit', 'respond'] as const },
  };
  const signal = createPiPauseController({ mcpToolSchemas }).request(toolCall);
  if (signal.kind !== 'tool_approval') {
    throw new Error('Test MCP approval did not pause');
  }
  const payload = buildPiApprovalInterruptPayload({
    kind: 'mcp',
    hostToolCallId: toolCall.hostExecution.toolCallId,
    toolName,
    args: toolCall.args,
    schemaFingerprint: schema.fingerprint,
    mcpToolSchemas,
    allowedDecisions: toolCall.review.allowedDecisions,
  });
  const pendingAction = buildPendingAction(payload, {
    streamId: 'conversation-1',
    conversationId: 'conversation-1',
    runId: 'response-1',
    responseMessageId: 'response-1',
  });
  const continuation = createPiApprovalContinuation(pendingAction.actionId, signal.toolCall);
  return { continuation, mcpToolSchemas, pendingAction, parameters, toolName };
}

describe('Pi approval continuation', () => {
  it('persists the MCP schema fingerprint and revalidates against current authorized schemas', () => {
    const { continuation, mcpToolSchemas, pendingAction, parameters, toolName } =
      createMcpApproval();
    expect(continuation).toMatchObject({ kind: 'mcp', toolName, args: { query: 'pump' } });
    expect('schemaFingerprint' in continuation).toBe(true);
    expect(
      resolvePiApprovalContinuation({
        value: continuation,
        pendingAction,
        responseMessageId: 'response-1',
        agentId: 'agent-1',
      }),
    ).toEqual(continuation);

    expect(
      revalidatePiMcpApprovalArguments({
        continuation,
        arguments: { query: 'pump station' },
        mcpToolSchemas,
      }),
    ).toEqual({ query: 'pump station' });

    const changedSchema = createPiMcpToolSchemaRegistry([
      { name: toolName, parameters: { ...parameters, description: 'Changed after approval' } },
    ]);
    expect(() =>
      revalidatePiMcpApprovalArguments({
        continuation,
        arguments: continuation.args,
        mcpToolSchemas: changedSchema,
      }),
    ).toThrow('This tool schema is not supported by the Pi runtime.');
    expect(() =>
      revalidatePiMcpApprovalArguments({
        continuation,
        arguments: continuation.args,
        mcpToolSchemas: createPiMcpToolSchemaRegistry([]),
      }),
    ).toThrow('This tool schema is not supported by the Pi runtime.');
    expect(() =>
      revalidatePiMcpApprovalArguments({
        continuation,
        arguments: { query: 'x' },
        mcpToolSchemas,
      }),
    ).toThrow('The Pi tool arguments are invalid.');
  });

  it('persists the managed Code API session snapshot and requires an approval target binding', () => {
    const toolCall: PiPauseToolCall = {
      toolCallId: 'pi-code-call',
      name: Constants.BASH_TOOL,
      args: { command: 'python report.py' },
      codeSessionContext: {
        session_id: 'exec-session',
        files: [
          {
            id: 'upload-1',
            resource_id: 'user-1',
            name: 'input.csv',
            storage_session_id: 'storage-1',
            kind: 'user',
          },
        ],
      },
      hostExecution: {
        toolCallId: 'host-code-call',
        toolTurn: 0,
        stepIdentity: {
          id: 'code-step',
          index: 0,
          messageId: 'response-1',
          runId: 'response-1',
          agentId: 'agent-1',
        },
        createdAt: 101,
      },
      review: { allowedDecisions: ['approve', 'reject'] },
    };
    const payload = buildPiApprovalInterruptPayload({
      hostToolCallId: toolCall.hostExecution.toolCallId,
      toolName: toolCall.name,
      args: toolCall.args,
      allowedDecisions: toolCall.review.allowedDecisions,
    });
    const binding = {
      version: 1 as const,
      targets: [{ agentId: 'agent-1', targetHash: 'a'.repeat(64) }],
    };
    const pendingAction = buildPendingAction(payload, {
      streamId: 'conversation-1',
      conversationId: 'conversation-1',
      runId: 'response-1',
      responseMessageId: 'response-1',
      codeExecutionBinding: binding,
    });
    const continuation = createPiApprovalContinuation(pendingAction.actionId, toolCall);

    expect(
      resolvePiApprovalContinuation({
        value: continuation,
        pendingAction,
        responseMessageId: 'response-1',
        agentId: 'agent-1',
      }),
    ).toEqual(continuation);
    expect(
      resolvePiApprovalContinuation({
        value: continuation,
        pendingAction: { ...pendingAction, codeExecutionBinding: undefined },
        responseMessageId: 'response-1',
        agentId: 'agent-1',
      }),
    ).toBeUndefined();
    expect(
      resolvePiApprovalContinuation({
        value: { ...continuation, codeSessionContext: { session_id: 'exec-session', files: [{}] } },
        pendingAction,
        responseMessageId: 'response-1',
        agentId: 'agent-1',
      }),
    ).toBeUndefined();
  });

  it('retains the Code API session binding across a non-code tool approval', () => {
    const toolCall: PiPauseToolCall = {
      ...createApproval().toolCall,
      codeSessionContext: { session_id: 'exec-session' },
    };
    const payload = buildPiApprovalInterruptPayload({
      hostToolCallId: toolCall.hostExecution.toolCallId,
      toolName: toolCall.name,
      args: toolCall.args,
      allowedDecisions: toolCall.review.allowedDecisions,
    });
    const binding = {
      version: 1 as const,
      targets: [{ agentId: 'agent-1', targetHash: 'b'.repeat(64) }],
    };
    const pendingAction = buildPendingAction(payload, {
      streamId: 'conversation-1',
      conversationId: 'conversation-1',
      runId: 'response-1',
      responseMessageId: 'response-1',
      codeExecutionBinding: binding,
    });
    const continuation = createPiApprovalContinuation(pendingAction.actionId, toolCall);

    expect(
      resolvePiApprovalContinuation({
        value: continuation,
        pendingAction,
        responseMessageId: 'response-1',
        agentId: 'agent-1',
      }),
    ).toEqual(continuation);
    expect(
      resolvePiApprovalContinuation({
        value: continuation,
        pendingAction: { ...pendingAction, codeExecutionBinding: undefined },
        responseMessageId: 'response-1',
        agentId: 'agent-1',
      }),
    ).toBeUndefined();
  });

  it('restores a web_search approval with its citation turn and reviewed arguments', () => {
    const toolCall: PiPauseToolCall = {
      ...createApproval().toolCall,
      name: Tools.web_search,
      args: { query: 'pump reliability', date: DATE_RANGE.PAST_YEAR, country: 'us' },
      hostExecution: { ...createApproval().toolCall.hostExecution, toolTurn: 2 },
    };
    const payload = buildPiApprovalInterruptPayload({
      hostToolCallId: toolCall.hostExecution.toolCallId,
      toolName: toolCall.name,
      args: toolCall.args,
      allowedDecisions: toolCall.review.allowedDecisions,
    });
    const pendingAction = buildPendingAction(payload, {
      streamId: 'conversation-1',
      conversationId: 'conversation-1',
      runId: 'response-1',
      responseMessageId: 'response-1',
    });
    const continuation = createPiApprovalContinuation(pendingAction.actionId, toolCall);

    expect(
      resolvePiApprovalContinuation({
        value: continuation,
        pendingAction,
        responseMessageId: 'response-1',
        agentId: 'agent-1',
      }),
    ).toEqual(continuation);
    expect(continuation.toolTurn).toBe(2);
    expect(continuation.args).toEqual({
      query: 'pump reliability',
      date: 'y',
      country: 'us',
    });
  });

  it('validates the server envelope against the exact pending action and generation', () => {
    const { continuation, pendingAction } = createApproval();

    expect(
      resolvePiApprovalContinuation({
        value: continuation,
        pendingAction,
        responseMessageId: 'response-1',
        agentId: 'agent-1',
      }),
    ).toEqual(continuation);
    expect(
      resolvePiApprovalContinuation({
        value: { ...continuation, hostToolCallId: 'stale-host-call' },
        pendingAction,
        responseMessageId: 'response-1',
        agentId: 'agent-1',
      }),
    ).toBeUndefined();
    expect(
      resolvePiApprovalContinuation({
        value: continuation,
        pendingAction,
        responseMessageId: 'replacement-response',
        agentId: 'agent-1',
      }),
    ).toBeUndefined();
    expect(
      resolvePiApprovalContinuation({
        value: continuation,
        pendingAction: {
          ...pendingAction,
          payload: { type: 'tool_approval', action_requests: null, review_configs: [] },
        } as unknown as Agents.PendingAction,
        responseMessageId: 'response-1',
        agentId: 'agent-1',
      }),
    ).toBeUndefined();
  });

  it('requires matching unfinished run-step and streamed content before resume', () => {
    const { continuation } = createApproval();
    const state = hostState();
    const input = {
      continuation,
      ...state,
      responseMessageId: 'response-1',
      agentId: 'agent-1',
    };

    expect(matchesPiApprovalHostState(input)).toBe(true);
    expect(
      matchesPiApprovalHostState({
        ...input,
        runSteps: hostState({ query: 'different query' }).runSteps,
      }),
    ).toBe(false);
    expect(matchesPiApprovalHostState({ ...input, aggregatedContent: [] })).toBe(false);
  });

  it('executes only allowed approve/edit decisions and keeps reject/respond side-effect free', () => {
    const { continuation } = createApproval();
    const resolution = (
      decision: Agents.ToolApprovalDecisionType,
    ): Agents.ToolApprovalResolution => {
      if (decision === 'edit') {
        return {
          tool_call_id: 'host-call-1',
          decision,
          editedArguments: { query: 'revised manual' },
        };
      }
      if (decision === 'respond') {
        return { tool_call_id: 'host-call-1', decision, responseText: 'Search later' };
      }
      return { tool_call_id: 'host-call-1', decision };
    };

    expect(
      resolvePiApprovalDecision({ continuation, resolutions: [resolution('approve')] }),
    ).toEqual({ kind: 'execute', args: { query: 'maintenance manual' } });
    expect(resolvePiApprovalDecision({ continuation, resolutions: [resolution('edit')] })).toEqual({
      kind: 'execute',
      args: { query: 'revised manual' },
    });
    expect(
      resolvePiApprovalDecision({ continuation, resolutions: [resolution('reject')] }),
    ).toEqual({ kind: 'reject' });
    expect(
      resolvePiApprovalDecision({ continuation, resolutions: [resolution('respond')] }),
    ).toEqual({ kind: 'respond', text: 'Search later' });
    expect(
      resolvePiApprovalDecision({
        continuation: { ...continuation, allowedDecisions: ['reject'] },
        resolutions: [resolution('approve')],
      }),
    ).toBeUndefined();
    expect(
      resolvePiApprovalDecision({
        continuation,
        resolutions: [
          {
            tool_call_id: 'host-call-1',
            decision: 'edit',
            editedArguments: { query: 'changed', unexpected: true },
          },
        ],
      }),
    ).toBeUndefined();
    expect(resolvePiApprovalDecision({ continuation, resolutions: [null] })).toBeUndefined();
  });

  it('restores the user prompt followed by the exact Pi call and its result', () => {
    const { continuation } = createApproval();
    const messages = appendPiToolResultContinuation({
      conversion: {
        systemPrompt: 'Be useful.',
        history: [],
        prompt: { text: 'Find the maintenance manual.', images: [] },
      },
      continuation,
      toolArguments: continuation.args,
      result: { content: [{ type: 'text', text: 'Found two manuals.' }], isError: false },
      model: {
        api: 'openai-responses',
        provider: 'librechat-openai',
        id: 'gpt-4o-mini',
      },
      now: () => 200,
    });

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult']);
    expect(messages[messages.length - 2]).toMatchObject({
      role: 'assistant',
      stopReason: 'toolUse',
      content: [
        {
          type: 'toolCall',
          id: 'pi-call-1',
          name: Tools.file_search,
          arguments: { query: 'maintenance manual' },
        },
      ],
    });
    expect(messages[messages.length - 1]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'pi-call-1',
      toolName: Tools.file_search,
    });
  });

  it('records the reviewed edited arguments in the resumed Pi tool call', () => {
    const { continuation } = createApproval();
    const toolArguments = { query: 'revised manual' };
    const messages = appendPiToolResultContinuation({
      conversion: {
        systemPrompt: 'Be useful.',
        history: [],
        prompt: { text: 'Find the maintenance manual.', images: [] },
      },
      continuation,
      toolArguments,
      result: { content: [{ type: 'text', text: 'Found the revised manual.' }], isError: false },
      model: {
        api: 'openai-responses',
        provider: 'librechat-openai',
        id: 'gpt-4o-mini',
      },
      now: () => 200,
    });

    expect(messages[messages.length - 2]).toMatchObject({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'pi-call-1',
          name: Tools.file_search,
          arguments: toolArguments,
        },
      ],
    });
  });
});
