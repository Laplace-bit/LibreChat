import { WebSearchToolDefinition } from '@librechat/agents';
import { CalculatorToolDefinition, Constants } from '@librechat/agents';
import { Constants as DataConstants, Tools } from 'librechat-data-provider';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';
import type { LCTool } from '@librechat/agents';
import {
  convertPiToolSchema,
  createPiTools,
  executePiToolCall,
  PiToolCompatibilityError,
  type PiHostToolDefinition,
  type PiHostToolExecutionInput,
  type PiHostToolExecutor,
} from './tools';
import {
  PI_BASH_TOOL_NAME,
  PI_CALCULATOR_TOOL_NAME,
  PI_DELETE_MEMORY_TOOL_NAME,
  PI_READ_FILE_TOOL_NAME,
  PI_SET_MEMORY_TOOL_NAME,
  PI_SKILL_TOOL_NAME,
} from './toolNames';
import { createPiMcpToolSchema, isPiMcpToolName } from './mcpSchema';

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

const bashDefinition: PiHostToolDefinition = {
  name: Constants.BASH_TOOL,
  description: 'Run a command in the managed code sandbox.',
  parameters: {
    type: 'object',
    properties: {
      intent: { type: 'string', description: 'Describe the current action.' },
      command: { type: 'string', description: 'Command to run.' },
      args: { type: 'array', items: { type: 'string' } },
    },
    required: ['command'],
  },
};

const readFileDefinition: PiHostToolDefinition = {
  name: Constants.READ_FILE,
  description: 'Read a text or image from the managed code sandbox.',
  parameters: {
    type: 'object',
    properties: {
      intent: { type: 'string', description: 'Describe the current action.' },
      path: { type: 'string', description: 'Sandbox file path.' },
      start_line: { type: 'integer', minimum: 1 },
      max_lines: { type: 'integer', minimum: 1, maximum: 500 },
    },
    required: ['path'],
  },
};

const skillDefinition: LCTool = {
  name: PI_SKILL_TOOL_NAME,
  description: 'Load an accessible skill.',
  parameters: {
    type: 'object',
    properties: {
      intent: { type: 'string' },
      skillName: { type: 'string' },
      args: { type: 'string' },
    },
    required: ['skillName'],
  },
};

const setMemoryDefinition: LCTool = {
  name: PI_SET_MEMORY_TOOL_NAME,
  description: 'Save user memory.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Memory key.' },
      value: { type: 'string', description: 'Memory value.' },
    },
    required: ['key', 'value'],
  },
};

const deleteMemoryDefinition: LCTool = {
  name: PI_DELETE_MEMORY_TOOL_NAME,
  description: 'Delete user memory.',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string', description: 'Memory key.' } },
    required: ['key'],
  },
};

const webSearchDefinition: PiHostToolDefinition = {
  name: Tools.web_search,
  description: 'Search the web using the administrator-configured provider.',
  parameters: {
    type: 'object',
    properties: {
      intent: { type: 'string', description: 'Describe the current search.' },
      query: { type: 'string', description: 'Search query.' },
      date: { type: 'string', enum: ['h', 'd', 'w', 'm', 'y'], description: 'Date range.' },
      country: { type: 'string', description: 'Two-letter country code.' },
      images: { type: 'boolean' },
      videos: { type: 'boolean' },
      news: { type: 'boolean' },
    },
    required: ['query'],
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
  it('creates a schema-bound host adapter for an authorized MCP definition', async () => {
    const nameValue = `lookup${DataConstants.mcp_delimiter}inventory`;
    if (!isPiMcpToolName(nameValue)) {
      throw new Error('Expected a valid MCP tool name.');
    }
    const parameters = {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 40 },
        includeInactive: { type: 'boolean' },
      },
      required: ['query'],
    };
    const schema = createPiMcpToolSchema(nameValue, parameters);
    const execute = hostExecutor();
    const [tool] = createPiTools({
      definitions: [
        {
          name: nameValue,
          description: 'Look up inventory records.',
          parameters,
        },
      ],
      execute,
    });

    expect(tool).toMatchObject({
      name: nameValue,
      label: nameValue,
      executionMode: 'sequential',
      parameters: { type: 'object', required: ['query'], additionalProperties: false },
    });
    await tool.execute('pi-mcp-call-1', { query: 'motor', includeInactive: false });
    expect(execute).toHaveBeenCalledWith(
      {
        kind: 'mcp',
        toolCallId: 'pi-mcp-call-1',
        name: nameValue,
        args: { query: 'motor', includeInactive: false },
        schemaFingerprint: schema.fingerprint,
      },
      undefined,
    );
    await expect(tool.execute('pi-mcp-invalid', { query: 'x', extra: true })).rejects.toMatchObject(
      { code: 'PI_TOOL_ARGUMENTS_INVALID' },
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('creates strict managed Code API tool schemas and forwards only validated args', async () => {
    const execute = hostExecutor();
    const tools = createPiTools({ definitions: [bashDefinition, readFileDefinition], execute });
    const [bash, readFile] = tools;

    expect(bash).toMatchObject({
      name: PI_BASH_TOOL_NAME,
      executionMode: 'sequential',
      parameters: {
        additionalProperties: false,
        required: ['command'],
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          intent: { type: 'string' },
        },
      },
    });
    expect(readFile).toMatchObject({
      name: PI_READ_FILE_TOOL_NAME,
      parameters: {
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string' },
          start_line: { type: 'integer', minimum: 1 },
          max_lines: { type: 'integer', minimum: 1, maximum: 500 },
          intent: { type: 'string' },
        },
      },
    });

    await bash.execute('pi-bash-1', {
      command: 'python script.py',
      args: ['--mode', 'check'],
      intent: 'Checking the generated report',
    });
    await readFile.execute('pi-read-1', { path: '/mnt/data/report.txt', start_line: 4 });

    expect(execute).toHaveBeenNthCalledWith(
      1,
      {
        toolCallId: 'pi-bash-1',
        name: PI_BASH_TOOL_NAME,
        args: {
          command: 'python script.py',
          args: ['--mode', 'check'],
          intent: 'Checking the generated report',
        },
      },
      undefined,
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      {
        toolCallId: 'pi-read-1',
        name: PI_READ_FILE_TOOL_NAME,
        args: { path: '/mnt/data/report.txt', start_line: 4 },
      },
      undefined,
    );
  });

  it('adapts inline memory tools with strict schemas and host-only arguments', async () => {
    const execute = hostExecutor();
    const [setMemory, deleteMemory] = createPiTools({
      definitions: [setMemoryDefinition, deleteMemoryDefinition],
      execute,
    });

    expect(setMemory).toMatchObject({
      name: PI_SET_MEMORY_TOOL_NAME,
      executionMode: 'sequential',
      parameters: {
        type: 'object',
        required: ['key', 'value'],
        additionalProperties: false,
      },
    });
    expect(deleteMemory).toMatchObject({
      name: PI_DELETE_MEMORY_TOOL_NAME,
      executionMode: 'sequential',
      parameters: { type: 'object', required: ['key'], additionalProperties: false },
    });

    await setMemory.execute('pi-memory-set', {
      key: 'preferred_line',
      value: 'The operator prefers summaries before detailed tables.',
    });
    await deleteMemory.execute('pi-memory-delete', { key: 'obsolete_line' });

    expect(execute).toHaveBeenNthCalledWith(
      1,
      {
        toolCallId: 'pi-memory-set',
        name: PI_SET_MEMORY_TOOL_NAME,
        args: {
          key: 'preferred_line',
          value: 'The operator prefers summaries before detailed tables.',
        },
      },
      undefined,
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      {
        toolCallId: 'pi-memory-delete',
        name: PI_DELETE_MEMORY_TOOL_NAME,
        args: { key: 'obsolete_line' },
      },
      undefined,
    );
    await expect(
      setMemory.execute('pi-memory-extra', { key: 'x', value: 'y', extra: true }),
    ).rejects.toMatchObject({ code: 'PI_TOOL_ARGUMENTS_INVALID' });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('routes the host skill tool with bounded arguments and no Pi-local skill lookup', async () => {
    const execute = hostExecutor();
    const [skill] = createPiTools({ definitions: [skillDefinition], execute });

    expect(skill).toMatchObject({
      name: PI_SKILL_TOOL_NAME,
      executionMode: 'sequential',
      parameters: {
        type: 'object',
        required: ['skillName'],
        additionalProperties: false,
      },
    });
    await skill.execute('pi-skill-call', {
      intent: 'Loading the maintenance workflow',
      skillName: 'maintenance-workflow',
      args: 'focus on press line 4',
    });
    expect(execute).toHaveBeenCalledWith(
      {
        toolCallId: 'pi-skill-call',
        name: PI_SKILL_TOOL_NAME,
        args: {
          intent: 'Loading the maintenance workflow',
          skillName: 'maintenance-workflow',
          args: 'focus on press line 4',
        },
      },
      undefined,
    );

    await expect(
      skill.execute('pi-skill-invalid', { skillName: 'x', path: '/etc/passwd' }),
    ).rejects.toMatchObject({ code: 'PI_TOOL_ARGUMENTS_INVALID' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects read_file ranges above the host hard limit before dispatch', async () => {
    const execute = hostExecutor();
    const [, readFile] = createPiTools({
      definitions: [bashDefinition, readFileDefinition],
      execute,
    });

    await expect(
      readFile.execute('pi-read-too-many', { path: 'report.txt', max_lines: 501 }),
    ).rejects.toThrow(new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID'));
    expect(execute).not.toHaveBeenCalled();
  });

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

  it('creates strict web_search parameters and forwards only the reviewed argument shape', async () => {
    const execute = hostExecutor();
    const [tool] = createPiTools({ definitions: [webSearchDefinition], execute });
    const args = {
      intent: 'Searching for the current pump standard',
      query: 'ISO pump vibration standard',
      date: 'y',
      country: 'us',
      images: false,
      videos: true,
      news: false,
    };

    expect(tool).toMatchObject({
      name: Tools.web_search,
      executionMode: 'sequential',
      parameters: {
        additionalProperties: false,
        required: ['query'],
        properties: {
          intent: { type: 'string' },
          query: { type: 'string' },
          date: { type: 'string', enum: ['h', 'd', 'w', 'm', 'y'] },
          country: { type: 'string' },
          images: { type: 'boolean' },
          videos: { type: 'boolean' },
          news: { type: 'boolean' },
        },
      },
    });

    await tool.execute('pi-search-1', args);

    expect(execute).toHaveBeenCalledWith(
      { toolCallId: 'pi-search-1', name: Tools.web_search, args },
      undefined,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unknown field', { query: 'pump', unexpected: true }],
    ['invalid date range', { query: 'pump', date: 'tomorrow' }],
    ['invalid country code', { query: 'pump', country: 'usa' }],
    ['non-boolean media filter', { query: 'pump', images: 'yes' }],
  ])('rejects web_search %s before host execution', async (_label, args) => {
    const execute = hostExecutor();
    const [tool] = createPiTools({ definitions: [webSearchDefinition], execute });

    await expect(tool.execute('pi-search-invalid', args)).rejects.toThrow(
      new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID'),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a web_search host schema with an expanded date enum', () => {
    expect(() =>
      convertPiToolSchema(Tools.web_search, {
        ...WebSearchToolDefinition.schema,
        properties: {
          ...WebSearchToolDefinition.schema.properties,
          date: { type: 'string', enum: ['h', 'd', 'w', 'm', 'y', 'all'] },
        },
      }),
    ).toThrow(new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED'));
  });

  it('accepts the canonical host web_search schema', () => {
    expect(() =>
      convertPiToolSchema(Tools.web_search, WebSearchToolDefinition.schema),
    ).not.toThrow();
  });

  it('rejects a web_search schema with duplicate date values', () => {
    expect(() =>
      convertPiToolSchema(Tools.web_search, {
        ...WebSearchToolDefinition.schema,
        properties: {
          ...WebSearchToolDefinition.schema.properties,
          date: { type: 'string', enum: ['h', 'h', 'w', 'm', 'y'] },
        },
      }),
    ).toThrow(new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED'));
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
        definitions: [{ name: 'search_docs' }],
        execute: async () => successfulResult(),
      }),
    ).toThrow(new PiToolCompatibilityError('PI_TOOL_UNSUPPORTED'));
  });

  it('rejects a set containing a supported tool and an unsupported tool', () => {
    expect(() =>
      createPiTools({
        definitions: [fileSearchDefinition, { name: 'search_docs' }],
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

  it.each([bashDefinition, readFileDefinition])(
    'converts the reviewed code tool schema for $name',
    (definition) => {
      expect(convertPiToolSchema(definition.name, definition.parameters)).toMatchObject({
        type: 'object',
        additionalProperties: false,
      });
    },
  );

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
  it('rejects caller-supplied Code API route, session, and credential arguments', async () => {
    const execute = hostExecutor();

    await expect(
      executePiToolCall({
        execute,
        name: PI_BASH_TOOL_NAME,
        toolCallId: 'pi-bash-2',
        arguments: {
          command: 'echo unsafe',
          baseUrl: 'https://attacker.example',
          session_id: 'attacker-session',
          apiKey: 'secret',
        },
      }),
    ).rejects.toThrow(new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID'));
    expect(execute).not.toHaveBeenCalled();
  });

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
