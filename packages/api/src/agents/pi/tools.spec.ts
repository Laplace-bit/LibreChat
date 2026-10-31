import { Tools } from 'librechat-data-provider';
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

  it('returns no tools when the authorized agent has no callable tools', () => {
    expect(createPiTools({ definitions: [] })).toEqual([]);
  });

  it('rejects any callable tool other than file_search', () => {
    expect(() =>
      createPiTools({
        definitions: [{ name: 'calculator' }],
        execute: async () => successfulResult(),
      }),
    ).toThrow(new PiToolCompatibilityError('PI_TOOL_UNSUPPORTED'));
  });

  it('rejects a set containing file_search and any additional tool', () => {
    expect(() =>
      createPiTools({
        definitions: [fileSearchDefinition, { name: 'calculator' }],
        execute: async () => successfulResult(),
      }),
    ).toThrow(new PiToolCompatibilityError('PI_TOOL_UNSUPPORTED'));
  });

  it('does not expose file_search when its host execution callback is unavailable', () => {
    expect(() => createPiTools({ definitions: [fileSearchDefinition] })).toThrow(
      new PiToolCompatibilityError('PI_TOOL_EXECUTION_UNAVAILABLE'),
    );
  });

  it('does not expose file_search when its schema is missing', () => {
    expect(() =>
      createPiTools({
        definitions: [{ name: Tools.file_search }],
        execute: async () => successfulResult(),
      }),
    ).toThrow(new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED'));
  });
});

describe('convertPiToolSchema', () => {
  it.each([
    undefined,
    { type: 'array', items: { type: 'string' } },
    { type: 'object', properties: { query: { type: 'number' } }, required: ['query'] },
    { type: 'object', properties: { query: { type: 'string' } }, required: [] },
    {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: true,
    },
    {
      type: 'object',
      properties: { query: { type: 'string' }, path: { type: 'string' } },
      required: ['query', 'path'],
    },
    {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      oneOf: [{ type: 'object' }],
    },
  ])('rejects missing, invalid, or unsupported schemas: %j', (schema) => {
    expect(() => convertPiToolSchema(schema)).toThrow(
      new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED'),
    );
  });

  it('rejects a non-string or empty schema description', () => {
    expect(() =>
      convertPiToolSchema({
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

  it('fails closed when no execution callback is available', async () => {
    await expect(
      executePiToolCall({
        toolCallId: 'pi-call-1',
        arguments: { query: 'manual' },
      }),
    ).rejects.toThrow(new PiToolCompatibilityError('PI_TOOL_EXECUTION_UNAVAILABLE'));
  });

  it('does not call the host when arguments contain an extra or invalid field', async () => {
    const execute = hostExecutor();

    await expect(
      executePiToolCall({
        execute,
        toolCallId: 'pi-call-1',
        arguments: { query: 'manual', path: '/etc/passwd' },
      }),
    ).rejects.toThrow(new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID'));
    await expect(
      executePiToolCall({ execute, toolCallId: 'pi-call-2', arguments: { query: '' } }),
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
        toolCallId: 'pi-call-1',
        arguments: { query: 'manual' },
      }),
    ).rejects.toBe(authorizationError);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
