import { Tools } from 'librechat-data-provider';
import { CalculatorToolDefinition } from '@librechat/agents';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import type { LCTool } from '@librechat/agents';
import {
  convertPiToolSchema,
  createPiTools,
  executePiToolCall,
  PiToolCompatibilityError,
  type PiHostToolExecutionInput,
  type PiHostToolExecutor,
} from './tools';
import { PI_CALCULATOR_TOOL_NAME } from './toolNames';

const fileSearchParameters: NonNullable<LCTool['parameters']> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'A natural language query.',
    },
  },
  required: ['query'],
};

const fileSearchDefinition: LCTool = {
  name: Tools.file_search,
  description: 'Search files attached to this agent.',
  parameters: fileSearchParameters,
};

const calculatorDefinition: LCTool = {
  name: PI_CALCULATOR_TOOL_NAME,
  description: 'Evaluate an expression.',
  parameters: {
    type: 'object',
    properties: { input: { type: 'string' } },
    required: ['input'],
  },
};

function successfulResult(): AgentToolResult {
  return {
    content: [{ type: 'text', text: 'Search result' }],
    details: undefined,
  };
}

function hostExecutor(implementation: PiHostToolExecutor = async () => successfulResult()) {
  return jest.fn<ReturnType<PiHostToolExecutor>, Parameters<PiHostToolExecutor>>(implementation);
}

describe('createPiTools', () => {
  it('creates one file_search ToolDefinition with a strict TypeBox query schema', () => {
    const execute = hostExecutor();

    const [tool] = createPiTools({ definitions: [fileSearchDefinition], execute });

    expect(tool).toMatchObject({
      name: Tools.file_search,
      label: 'File Search',
      description: fileSearchDefinition.description,
      executionMode: 'sequential',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            description: 'A natural language query.',
          },
        },
      },
    });
  });

  it('routes execute through the injected host callback and forwards cancellation', async () => {
    const controller = new AbortController();
    const execute = hostExecutor();
    const [tool] = createPiTools({ definitions: [fileSearchDefinition], execute });

    const result = await tool.execute(
      'pi-call-1',
      { query: 'find a machine manual' },
      controller.signal,
    );

    expect(result).toEqual(successfulResult());
    expect(execute).toHaveBeenCalledWith(
      {
        toolCallId: 'pi-call-1',
        name: Tools.file_search,
        args: { query: 'find a machine manual' },
      } satisfies PiHostToolExecutionInput,
      controller.signal,
    );
  });

  it('creates and dispatches the host calculator with its validated input field', async () => {
    const execute = hostExecutor();
    const [tool] = createPiTools({ definitions: [calculatorDefinition], execute });

    expect(tool).toMatchObject({
      name: PI_CALCULATOR_TOOL_NAME,
      label: 'Calculator',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['input'],
        properties: { input: { type: 'string' } },
      },
    });

    await tool.execute('pi-calc-1', { input: '2 + 2' });

    expect(execute).toHaveBeenCalledWith(
      {
        toolCallId: 'pi-calc-1',
        name: PI_CALCULATOR_TOOL_NAME,
        args: { input: '2 + 2' },
      },
      undefined,
    );
  });

  it('returns no tools when the authorized agent has no callable tools', () => {
    expect(createPiTools({ definitions: [] })).toEqual([]);
  });

  it('rejects any callable tool outside the reviewed host adapters', () => {
    expect(() =>
      createPiTools({
        definitions: [{ name: 'web_search' }],
        execute: async () => successfulResult(),
      }),
    ).toThrow(new PiToolCompatibilityError('PI_TOOL_UNSUPPORTED'));
  });

  it('rejects a set containing a supported tool and an unsupported tool', () => {
    expect(() =>
      createPiTools({
        definitions: [fileSearchDefinition, { name: 'web_search' }],
        execute: async () => successfulResult(),
      }),
    ).toThrow(new PiToolCompatibilityError('PI_TOOL_UNSUPPORTED'));
  });

  it('rejects duplicate tool names before constructing Pi definitions', () => {
    expect(() =>
      createPiTools({
        definitions: [calculatorDefinition, calculatorDefinition],
        execute: async () => successfulResult(),
      }),
    ).toThrow(new PiToolCompatibilityError('PI_TOOL_UNSUPPORTED'));
  });

  it('does not expose host tools when their execution callback is unavailable', () => {
    expect(() => createPiTools({ definitions: [calculatorDefinition] })).toThrow(
      new PiToolCompatibilityError('PI_TOOL_EXECUTION_UNAVAILABLE'),
    );
  });

  it('does not expose supported host tools when their schema is missing', () => {
    expect(() =>
      createPiTools({
        definitions: [{ name: Tools.file_search }],
        execute: async () => successfulResult(),
      }),
    ).toThrow(new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED'));
  });
});

describe('convertPiToolSchema', () => {
  it('accepts the authoritative host calculator schema', () => {
    expect(
      convertPiToolSchema(PI_CALCULATOR_TOOL_NAME, CalculatorToolDefinition.schema),
    ).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['input'],
      properties: { input: { type: 'string' } },
    });
  });

  it.each([
    [Tools.file_search, undefined],
    [Tools.file_search, { type: 'array', items: { type: 'string' } }],
    [
      Tools.file_search,
      { type: 'object', properties: { query: { type: 'number' } }, required: ['query'] },
    ],
    [
      Tools.file_search,
      { type: 'object', properties: { query: { type: 'string' } }, required: [] },
    ],
    [
      Tools.file_search,
      {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: true,
      },
    ],
    [
      Tools.file_search,
      {
        type: 'object',
        properties: { query: { type: 'string' }, path: { type: 'string' } },
        required: ['query', 'path'],
      },
    ],
    [
      Tools.file_search,
      {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        oneOf: [{ type: 'object' }],
      },
    ],
    [
      PI_CALCULATOR_TOOL_NAME,
      {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
    ],
  ])('rejects missing, invalid, or unsupported schemas: %j', (name, schema) => {
    expect(() => convertPiToolSchema(name, schema)).toThrow(
      new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED'),
    );
  });

  it('rejects a non-string or empty schema description', () => {
    expect(() =>
      convertPiToolSchema(Tools.file_search, {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        description: '',
      }),
    ).toThrow(new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED'));
  });
});

describe('executePiToolCall', () => {
  it('passes only validated file_search arguments and forwards the cancellation signal', async () => {
    const controller = new AbortController();
    const execute = hostExecutor();

    await executePiToolCall({
      execute,
      name: Tools.file_search,
      toolCallId: 'pi-call-1',
      arguments: { query: 'find a machine manual' },
      signal: controller.signal,
    });

    expect(execute).toHaveBeenCalledWith(
      {
        toolCallId: 'pi-call-1',
        name: Tools.file_search,
        args: { query: 'find a machine manual' },
      } satisfies PiHostToolExecutionInput,
      controller.signal,
    );
  });

  it('validates calculator arguments before host dispatch', async () => {
    const execute = hostExecutor();

    await executePiToolCall({
      execute,
      name: PI_CALCULATOR_TOOL_NAME,
      toolCallId: 'pi-calc-1',
      arguments: { input: '2 + 2' },
    });

    expect(execute).toHaveBeenCalledWith(
      {
        toolCallId: 'pi-calc-1',
        name: PI_CALCULATOR_TOOL_NAME,
        args: { input: '2 + 2' },
      },
      undefined,
    );
    await expect(
      executePiToolCall({
        execute,
        name: PI_CALCULATOR_TOOL_NAME,
        toolCallId: 'pi-calc-2',
        arguments: { input: '' },
      }),
    ).rejects.toThrow(new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID'));
  });

  it('fails closed when no execution callback is available', async () => {
    await expect(
      executePiToolCall({
        toolCallId: 'pi-call-1',
        name: Tools.file_search,
        arguments: { query: 'manual' },
      }),
    ).rejects.toThrow(new PiToolCompatibilityError('PI_TOOL_EXECUTION_UNAVAILABLE'));
  });

  it('does not call the host when arguments contain an extra or invalid field', async () => {
    const execute = hostExecutor();

    await expect(
      executePiToolCall({
        execute,
        name: Tools.file_search,
        toolCallId: 'pi-call-1',
        arguments: { query: 'manual', path: '/etc/passwd' },
      }),
    ).rejects.toThrow(new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID'));
    await expect(
      executePiToolCall({
        execute,
        name: Tools.file_search,
        toolCallId: 'pi-call-2',
        arguments: { query: '' },
      }),
    ).rejects.toThrow(new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID'));
    expect(execute).not.toHaveBeenCalled();
  });

  it('propagates a host authorization denial without falling back to local execution', async () => {
    const authorizationError = new Error('Tool execution was denied by the host.');
    const execute = hostExecutor(async () => {
      throw authorizationError;
    });

    await expect(
      executePiToolCall({
        execute,
        name: Tools.file_search,
        toolCallId: 'pi-call-1',
        arguments: { query: 'manual' },
      }),
    ).rejects.toBe(authorizationError);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
