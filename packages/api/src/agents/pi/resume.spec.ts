import { DATE_RANGE, Constants } from '@librechat/agents';
import { actionDelimiter, Constants as DataConstants, Tools } from 'librechat-data-provider';
import type { Agents } from 'librechat-data-provider';
import type { PiDeleteMemoryArguments, PiSetMemoryArguments } from './tools';
import type { PiPauseAskUserQuestionCall, PiPauseToolCall } from './pause';
import type { PiAskUserQuestionArguments } from './tools';
import {
  appendPiToolResultContinuation,
  buildPiApprovalInterruptPayload,
  createPiAskUserQuestionContinuation,
  createPiApprovalContinuation,
  matchesPiAskUserQuestionHostState,
  matchesPiApprovalHostState,
  revalidatePiActionApprovalArguments,
  revalidatePiMcpApprovalArguments,
  resolvePiApprovalContinuation,
  resolvePiAskUserQuestionContinuation,
  resolvePiApprovalDecision,
} from './resume';
import {
  PI_DELETE_MEMORY_TOOL_NAME,
  PI_SET_MEMORY_TOOL_NAME,
  PI_SKILL_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
} from './toolNames';
import { createPiActionToolSchemaRegistry, isPiActionToolName } from './actionSchema';
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

function createPiAskUserQuestion() {
  const args: PiAskUserQuestionArguments = {
    questions: [
      { id: 'plant_code', question: 'Which plant?' },
      { id: 'window_7d', question: 'Which time window?' },
    ],
  };
  const [first] = args.questions;
  const toolCall: PiPauseAskUserQuestionCall = {
    toolCallId: 'pi-ask-call-1',
    name: ASK_USER_QUESTION_TOOL_NAME,
    args,
    hostExecution: {
      toolCallId: 'host-ask-call-1',
      toolTurn: 2,
      stepIdentity: {
        id: 'ask-step-1',
        index: 3,
        messageId: 'response-1',
        runId: 'response-1',
        agentId: 'agent-1',
      },
      createdAt: 101,
    },
  };
  const payload = {
    type: 'ask_user_question' as const,
    question: { question: first.question },
    questions: args.questions,
    tool_call_id: toolCall.hostExecution.toolCallId,
  };
  const pendingAction = buildPendingAction(payload, {
    streamId: 'conversation-1',
    conversationId: 'conversation-1',
    runId: 'response-1',
    responseMessageId: 'response-1',
  });
  return {
    args,
    toolCall,
    pendingAction,
    continuation: createPiAskUserQuestionContinuation(pendingAction.actionId, toolCall),
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
              type: 'tool_call',
              name: Tools.file_search,
              args,
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

function createActionApproval() {
  const rawToolName = `get_inventory${actionDelimiter}api---example---com`;
  if (!isPiActionToolName(rawToolName)) {
    throw new Error('Test Action name failed validation');
  }
  const toolName = rawToolName;
  const parameters = {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 2, maxLength: 40 },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    },
    required: ['query'],
  };
  const definition = {
    name: toolName,
    description: 'List inventory.',
    oauth: false,
    parameters,
  };
  const actionToolSchemas = createPiActionToolSchemaRegistry([definition]);
  const schema = actionToolSchemas.get(toolName);
  if (schema == null) {
    throw new Error('Test Action schema failed to compile');
  }
  const toolCall = {
    kind: 'action' as const,
    toolCallId: 'pi-action-call-1',
    name: toolName,
    args: { query: 'pump', limit: 3 },
    schemaFingerprint: schema.fingerprint,
    hostExecution: {
      toolCallId: 'host-action-call-1',
      toolTurn: 1,
      stepIdentity: {
        id: 'action-step-1',
        index: 4,
        messageId: 'response-1',
        runId: 'response-1',
        agentId: 'agent-1',
      },
      createdAt: 102,
    },
    review: { allowedDecisions: ['approve', 'reject', 'edit', 'respond'] as const },
  };
  const signal = createPiPauseController({ actionToolSchemas }).request(toolCall);
  if (signal.kind !== 'tool_approval') {
    throw new Error('Test Action approval did not pause');
  }
  const payload = buildPiApprovalInterruptPayload({
    kind: 'action',
    hostToolCallId: toolCall.hostExecution.toolCallId,
    toolName: toolCall.name,
    args: toolCall.args,
    schemaFingerprint: schema.fingerprint,
    actionToolSchemas,
    allowedDecisions: toolCall.review.allowedDecisions,
  });
  const pendingAction = buildPendingAction(payload, {
    streamId: 'conversation-1',
    conversationId: 'conversation-1',
    runId: 'response-1',
    responseMessageId: 'response-1',
  });
  const continuation = createPiApprovalContinuation(pendingAction.actionId, signal.toolCall);
  return { actionToolSchemas, continuation, definition, parameters, pendingAction, toolName };
}

describe('Pi approval continuation', () => {
  it('binds ask-user continuation to the exact question IDs, action and unfinished host step', () => {
    const { continuation, pendingAction, args, toolCall } = createPiAskUserQuestion();
    const resumed = resolvePiAskUserQuestionContinuation({
      value: continuation,
      pendingAction,
      responseMessageId: 'response-1',
      agentId: 'agent-1',
    });
    const runSteps = [
      {
        id: 'ask-step-1',
        runId: 'response-1',
        agentId: 'agent-1',
        type: 'tool_calls',
        index: 3,
        created_at: 101,
        status: 'in_progress',
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [
            {
              id: 'host-ask-call-1',
              type: 'tool_call',
              name: ASK_USER_QUESTION_TOOL_NAME,
              args,
            },
          ],
        },
      },
    ];
    const aggregatedContent = [
      {
        type: 'tool_call',
        tool_call: {
          id: 'host-ask-call-1',
          stepId: 'ask-step-1',
          name: ASK_USER_QUESTION_TOOL_NAME,
          args: JSON.stringify(args),
        },
      },
    ];

    expect(resumed).toEqual(continuation);
    expect(
      resolvePiAskUserQuestionContinuation({
        value: { ...continuation, hostToolCallId: 'foreign-host-call' },
        pendingAction,
        responseMessageId: 'response-1',
        agentId: 'agent-1',
      }),
    ).toBeUndefined();
    expect(
      resolvePiAskUserQuestionContinuation({
        value: continuation,
        pendingAction: {
          ...pendingAction,
          payload: { type: 'tool_approval' },
        } as unknown as Agents.PendingAction,
        responseMessageId: 'response-1',
        agentId: 'agent-1',
      }),
    ).toBeUndefined();
    expect(
      matchesPiAskUserQuestionHostState({
        continuation,
        runSteps,
        aggregatedContent,
        responseMessageId: 'response-1',
        agentId: 'agent-1',
      }),
    ).toBe(true);
    expect(
      matchesPiAskUserQuestionHostState({
        continuation,
        runSteps,
        aggregatedContent,
        responseMessageId: 'replacement-response',
        agentId: 'agent-1',
      }),
    ).toBe(false);
    expect(toolCall.toolCallId).toBe(continuation.piToolCallId);
  });

  it('appends a user answer to the original Pi ask tool-call ID', () => {
    const { continuation, args } = createPiAskUserQuestion();
    const answers = { plant_code: 'North', window_7d: 'last 7 days' };
    const result = appendPiToolResultContinuation({
      conversion: {
        systemPrompt: 'Be useful.',
        history: [],
        prompt: { text: 'Choose a plant.', images: [] },
      },
      continuation,
      toolArguments: args,
      result: { content: [{ type: 'text', text: JSON.stringify({ answers }) }], isError: false },
      model: {
        api: 'openai-responses',
        provider: 'librechat-openai',
        id: 'gpt-4o-mini',
      },
      now: () => 200,
    });

    expect(result.map((message) => message.role)).toEqual(['user', 'assistant', 'toolResult']);
    expect(result[1]).toMatchObject({
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: continuation.piToolCallId,
          name: ASK_USER_QUESTION_TOOL_NAME,
          arguments: args,
        },
      ],
    });
    expect(result[2]).toMatchObject({
      role: 'toolResult',
      toolCallId: continuation.piToolCallId,
      toolName: ASK_USER_QUESTION_TOOL_NAME,
      content: [{ type: 'text', text: JSON.stringify({ answers }) }],
    });
  });

  it('preserves a host skill action through the existing approval continuation shape', () => {
    const toolCall: PiPauseToolCall = {
      toolCallId: 'pi-skill-call',
      name: PI_SKILL_TOOL_NAME,
      args: { skillName: 'maintenance', args: 'focus on press line 4' },
      hostExecution: {
        toolCallId: 'host-skill-call',
        toolTurn: 0,
        stepIdentity: {
          id: 'skill-step',
          index: 0,
          messageId: 'response-1',
          runId: 'response-1',
          agentId: 'agent-1',
        },
        createdAt: 100,
      },
      review: { allowedDecisions: ['approve', 'reject'] },
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
    expect(
      matchesPiApprovalHostState({
        continuation,
        responseMessageId: 'response-1',
        agentId: 'agent-1',
        runSteps: [
          {
            id: 'skill-step',
            runId: 'response-1',
            agentId: 'agent-1',
            type: 'tool_calls',
            index: 0,
            created_at: 100,
            status: 'in_progress',
            stepDetails: {
              type: 'tool_calls',
              tool_calls: [
                {
                  id: 'host-skill-call',
                  type: 'tool_call',
                  name: PI_SKILL_TOOL_NAME,
                  args: toolCall.args,
                },
              ],
            },
          },
        ],
        aggregatedContent: [
          {
            type: 'tool_call',
            tool_call: {
              id: 'host-skill-call',
              stepId: 'skill-step',
              name: PI_SKILL_TOOL_NAME,
              args: JSON.stringify(toolCall.args),
            },
          },
        ],
      }),
    ).toBe(true);
  });

  it.each([
    [PI_SET_MEMORY_TOOL_NAME, { key: 'preferred_line', value: 'Summaries first.' }],
    [PI_DELETE_MEMORY_TOOL_NAME, { key: 'obsolete_line' }],
  ])('preserves %s through the existing approval continuation shape', (name, args) => {
    const toolCall = {
      toolCallId: `pi-${name}-call`,
      name,
      args,
      hostExecution: {
        toolCallId: `host-${name}-call`,
        toolTurn: 0,
        stepIdentity: {
          id: `${name}-step`,
          index: 0,
          messageId: 'response-1',
          runId: 'response-1',
          agentId: 'agent-1',
        },
        createdAt: 100,
      },
      review: { allowedDecisions: ['approve', 'reject'] as const },
    } as PiPauseToolCall;
    const payload =
      name === PI_SET_MEMORY_TOOL_NAME
        ? buildPiApprovalInterruptPayload({
            hostToolCallId: toolCall.hostExecution.toolCallId,
            toolName: PI_SET_MEMORY_TOOL_NAME,
            args: args as PiSetMemoryArguments,
            allowedDecisions: toolCall.review.allowedDecisions,
          })
        : buildPiApprovalInterruptPayload({
            hostToolCallId: toolCall.hostExecution.toolCallId,
            toolName: PI_DELETE_MEMORY_TOOL_NAME,
            args: args as PiDeleteMemoryArguments,
            allowedDecisions: toolCall.review.allowedDecisions,
          });
    const pendingAction = buildPendingAction(payload, {
      streamId: 'conversation-1',
      conversationId: 'conversation-1',
      runId: 'response-1',
      responseMessageId: 'response-1',
    });
    const continuation = createPiApprovalContinuation(pendingAction.actionId, toolCall);
    const serializedArgs = JSON.stringify(toolCall.args);

    expect(
      resolvePiApprovalContinuation({
        value: continuation,
        pendingAction,
        responseMessageId: 'response-1',
        agentId: 'agent-1',
      }),
    ).toEqual(continuation);
    expect(
      matchesPiApprovalHostState({
        continuation,
        responseMessageId: 'response-1',
        agentId: 'agent-1',
        runSteps: [
          {
            id: `${name}-step`,
            runId: 'response-1',
            agentId: 'agent-1',
            type: 'tool_calls',
            index: 0,
            created_at: 100,
            status: 'in_progress',
            stepDetails: {
              type: 'tool_calls',
              tool_calls: [
                {
                  id: `host-${name}-call`,
                  type: 'tool_call',
                  name,
                  args,
                },
              ],
            },
          },
        ],
        aggregatedContent: [
          {
            type: 'tool_call',
            tool_call: {
              id: `host-${name}-call`,
              stepId: `${name}-step`,
              name,
              args: serializedArgs,
            },
          },
        ],
      }),
    ).toBe(true);
  });

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

  it('binds approval resume to the current authorized Action definition and validates edits', () => {
    const { continuation, actionToolSchemas, definition, parameters, pendingAction, toolName } =
      createActionApproval();
    expect(continuation).toMatchObject({
      kind: 'action',
      toolName,
      args: { query: 'pump', limit: 3 },
    });
    expect(
      resolvePiApprovalContinuation({
        value: continuation,
        pendingAction,
        responseMessageId: 'response-1',
        agentId: 'agent-1',
      }),
    ).toEqual(continuation);
    expect(
      revalidatePiActionApprovalArguments({
        continuation,
        arguments: { query: 'pump', limit: 4 },
        actionToolSchemas,
      }),
    ).toEqual({ query: 'pump', limit: 4 });

    const changedParameters = {
      ...parameters,
      properties: { ...parameters.properties, limit: { type: 'integer', maximum: 5 } },
    };
    const changedDefinition = createPiActionToolSchemaRegistry([
      { ...definition, parameters: changedParameters },
    ]);
    expect(() =>
      revalidatePiActionApprovalArguments({
        continuation,
        arguments: continuation.args,
        actionToolSchemas: changedDefinition,
      }),
    ).toThrow('This tool schema is not supported by the Pi runtime.');
    expect(() =>
      revalidatePiActionApprovalArguments({
        continuation,
        arguments: continuation.args,
        actionToolSchemas: createPiActionToolSchemaRegistry([]),
      }),
    ).toThrow('This tool schema is not supported by the Pi runtime.');

    const edited = resolvePiApprovalDecision({
      continuation,
      resolutions: [
        {
          tool_call_id: continuation.hostToolCallId,
          decision: 'edit',
          editedArguments: { query: 'x', limit: 3 },
        },
      ],
    });
    expect(edited).toMatchObject({ kind: 'execute', args: { query: 'x', limit: 3 } });
    if (edited?.kind !== 'execute') {
      throw new Error('Expected an edited Action approval decision.');
    }
    expect(() =>
      revalidatePiActionApprovalArguments({
        continuation,
        arguments: edited.args,
        actionToolSchemas,
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
