import { createPiProviderEventObserver, isPiToolBatchEventApi } from './providerEvents';

describe('Pi raw provider event observer', () => {
  it('rejects a repeated Completions call ID before Pi can merge it by ID', () => {
    const observer = createPiProviderEventObserver();

    expect(
      observer.observe('openai-completions', {
        id: 'response-1',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call-reused' },
                { index: 1, id: 'call-reused' },
              ],
            },
          },
        ],
      }),
    ).toEqual({
      kind: 'repeated_call_id',
      api: 'openai-completions',
      callId: 'call-reused',
      firstIndex: 0,
      repeatedIndex: 1,
    });
  });

  it('rejects tool-call deltas without a stream index', () => {
    const observer = createPiProviderEventObserver();

    expect(
      observer.observe('openai-completions', {
        id: 'response-1',
        choices: [{ index: 0, delta: { tool_calls: [{ id: 'call-without-index' }] } }],
      }),
    ).toEqual({
      kind: 'missing_tool_call_index',
      api: 'openai-completions',
      callId: 'call-without-index',
    });
  });

  it('rejects Completions tool-call choices without a choice index', () => {
    const observer = createPiProviderEventObserver();

    expect(
      observer.observe('openai-completions', {
        id: 'response-1',
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1' }] } }],
      }),
    ).toEqual({ kind: 'missing_choice_index', api: 'openai-completions' });
  });

  it('rejects multiple Completions choices because the Pi parser shares its maps across choices', () => {
    const observer = createPiProviderEventObserver();

    expect(
      observer.observe('openai-completions', {
        id: 'response-1',
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: 'call-first' }] } },
          { index: 1, delta: { tool_calls: [{ index: 0, id: 'call-second' }] } },
        ],
      }),
    ).toEqual({
      kind: 'cross_choice_tool_call',
      api: 'openai-completions',
      firstChoiceIndex: 0,
      choiceIndex: 1,
      toolCallIndex: 0,
    });
  });

  it('fails closed when a Completions tool-call chunk has no response ID', () => {
    const observer = createPiProviderEventObserver();
    const firstCall = {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-reused' }] } }],
    };

    expect(observer.observe('openai-completions', firstCall)).toEqual({
      kind: 'missing_response_id',
      api: 'openai-completions',
    });
  });

  it('retains shared Completions parser state after a choice finishes', () => {
    const observer = createPiProviderEventObserver();

    expect(
      observer.observe('openai-completions', {
        id: 'response-1',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-first' }] } }],
      }),
    ).toBeUndefined();
    expect(
      observer.observe('openai-completions', {
        id: 'response-1',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }),
    ).toBeUndefined();
    expect(
      observer.observe('openai-completions', {
        id: 'response-1',
        choices: [{ index: 1, delta: { tool_calls: [{ index: 0, id: 'call-second' }] } }],
      }),
    ).toEqual({
      kind: 'cross_choice_tool_call',
      api: 'openai-completions',
      firstChoiceIndex: 0,
      choiceIndex: 1,
      toolCallIndex: 0,
    });
  });

  it('starts fresh Completions identity state when the response ID changes', () => {
    const observer = createPiProviderEventObserver();
    const createCall = (id: string) => ({
      id,
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-reused' }] } }],
    });

    expect(observer.observe('openai-completions', createCall('response-1'))).toBeUndefined();
    expect(observer.observe('openai-completions', createCall('response-2'))).toBeUndefined();
  });

  it('rejects duplicate Responses call IDs across output indexes before host dispatch', () => {
    const observer = createPiProviderEventObserver();

    expect(
      observer.observe('openai-responses', {
        type: 'response.created',
        response: { id: 'response-1' },
      }),
    ).toBeUndefined();
    expect(
      observer.observe('openai-responses', {
        type: 'response.output_item.added',
        response_id: 'response-1',
        output_index: 0,
        item: { id: 'item-1', type: 'function_call', call_id: 'call-reused' },
      }),
    ).toBeUndefined();
    expect(
      observer.observe('openai-responses', {
        type: 'response.output_item.added',
        response_id: 'response-1',
        output_index: 1,
        item: { id: 'item-2', type: 'function_call', call_id: 'call-reused' },
      }),
    ).toEqual({
      kind: 'repeated_call_id',
      api: 'openai-responses',
      callId: 'call-reused',
      firstIndex: 0,
      repeatedIndex: 1,
    });
  });

  it('accepts an added and done event for the same Responses call', () => {
    const observer = createPiProviderEventObserver();
    const toolItem = {
      id: 'item-1',
      type: 'function_call',
      call_id: 'call-1',
    };

    expect(
      observer.observe('openai-responses', {
        type: 'response.output_item.added',
        response_id: 'response-1',
        output_index: 0,
        item: toolItem,
      }),
    ).toBeUndefined();
    expect(
      observer.observe('openai-responses', {
        type: 'response.output_item.done',
        response_id: 'response-1',
        output_index: 0,
        item: toolItem,
      }),
    ).toBeUndefined();
  });

  it('rejects Responses function calls without an output index', () => {
    const observer = createPiProviderEventObserver();

    expect(
      observer.observe('openai-responses', {
        type: 'response.output_item.added',
        response_id: 'response-1',
        item: { id: 'item-1', type: 'function_call', call_id: 'call-1' },
      }),
    ).toEqual({
      kind: 'missing_tool_call_index',
      api: 'openai-responses',
      callId: 'call-1',
    });
  });

  it('only reports raw events for explicitly covered provider APIs', () => {
    expect(isPiToolBatchEventApi('openai-completions')).toBe(true);
    expect(isPiToolBatchEventApi('openai-responses')).toBe(true);
    expect(isPiToolBatchEventApi('anthropic-messages')).toBe(false);
  });
});
