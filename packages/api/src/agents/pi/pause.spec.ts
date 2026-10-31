import { Tools } from 'librechat-data-provider';
import { PI_CALCULATOR_TOOL_NAME } from './toolNames';
import { createPiPauseController } from './pause';

describe('Pi pause controller', () => {
  it('returns the same approval for an identical tool call', () => {
    const controller = createPiPauseController();
    const call = {
      toolCallId: 'call-1',
      name: Tools.file_search,
      args: { query: 'maintenance manual' },
      hostExecution: {
        toolCallId: 'host-call-1',
        toolTurn: 0,
        stepIdentity: {
          id: 'step-1',
          index: 0,
          messageId: 'message-1',
          runId: 'run-1',
          agentId: 'agent-1',
        },
        createdAt: 1,
      },
      review: { allowedDecisions: ['approve', 'reject'] as const },
    } as const;

    const firstSignal = controller.request(call);
    const repeatedSignal = controller.request(call);

    expect(repeatedSignal).toBe(firstSignal);
    expect(firstSignal).toEqual({ kind: 'tool_approval', toolCall: call });
  });

  it('supports schema-validated calculator calls and rejects conflicting reused IDs', () => {
    const controller = createPiPauseController();
    const call = {
      toolCallId: 'call-calc-1',
      name: PI_CALCULATOR_TOOL_NAME,
      args: { input: '2 + 2' },
      hostExecution: {
        toolCallId: 'host-calc-1',
        toolTurn: 0,
        stepIdentity: {
          id: 'calc-step-1',
          index: 0,
          messageId: 'message-1',
          runId: 'run-1',
          agentId: 'agent-1',
        },
        createdAt: 1,
      },
      review: { allowedDecisions: ['approve', 'reject'] as const },
    } as const;

    expect(controller.request(call)).toEqual({ kind: 'tool_approval', toolCall: call });
    expect(() => controller.request({ ...call, args: { input: '2 + 3' } })).toThrow(
      'A Pi tool call ID cannot refer to two different host actions',
    );
  });

  it('keeps the managed Code API session with a paused non-code tool', () => {
    const controller = createPiPauseController();
    const codeSessionContext = {
      session_id: 'exec-session',
      files: [
        {
          id: 'upload-1',
          resource_id: 'user-1',
          name: 'input.csv',
          storage_session_id: 'storage-1',
          kind: 'user' as const,
        },
      ],
    };

    const signal = controller.request({
      toolCallId: 'call-search-1',
      name: Tools.file_search,
      args: { query: 'input.csv' },
      codeSessionContext,
      hostExecution: {
        toolCallId: 'host-search-1',
        toolTurn: 1,
        stepIdentity: {
          id: 'step-search-1',
          index: 1,
          messageId: 'message-1',
          runId: 'run-1',
          agentId: 'agent-1',
        },
        createdAt: 2,
      },
      review: { allowedDecisions: ['approve', 'reject'] },
    });

    expect(signal).toMatchObject({
      kind: 'tool_approval',
      toolCall: { name: Tools.file_search, codeSessionContext },
    });
  });

  it('records an unsupported batch as IDs without retaining unvalidated arguments', () => {
    const controller = createPiPauseController();

    const firstSignal = controller.rejectBatch(['call-1', 'call-2']);
    const repeatedSignal = controller.rejectBatch(['call-1', 'call-2']);

    expect(repeatedSignal).toBe(firstSignal);
    expect(firstSignal).toEqual({
      kind: 'unsupported_tool_batch',
      toolCallIds: ['call-1', 'call-2'],
    });
  });

  it('fails closed on repeated call IDs and keeps the first rejected batch idempotently', () => {
    const controller = createPiPauseController();

    expect(() => controller.rejectBatch(['call-1'])).toThrow(
      'An unsupported Pi tool batch requires at least two tool call IDs',
    );

    expect(controller.rejectBatch(['call-1', 'call-1'])).toEqual({
      kind: 'unsupported_tool_batch',
      toolCallIds: ['call-1', 'call-1'],
    });
    const firstSignal = controller.signal;
    expect(controller.rejectBatch(['call-3', 'call-4'])).toBe(firstSignal);
  });
});
