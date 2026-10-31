import { Tools } from 'librechat-data-provider';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { LCTool } from '@librechat/agents';
import type { TSchema } from 'typebox';
import {
  isPiSupportedHostToolName,
  PI_BASH_TOOL_NAME,
  PI_CALCULATOR_TOOL_NAME,
  PI_READ_FILE_TOOL_NAME,
} from './toolNames';

export type PiFileSearchArguments = { query: string };

export type PiCalculatorArguments = { input: string };

export type PiBashArguments = {
  command: string;
  args?: string[];
  intent?: string;
};

export type PiReadFileArguments = {
  path: string;
  start_line?: number;
  max_lines?: number;
  intent?: string;
};

export type PiToolArguments =
  | PiFileSearchArguments
  | PiCalculatorArguments
  | PiBashArguments
  | PiReadFileArguments;

const MAX_PI_READ_FILE_LINES = 500;

export type PiHostToolExecutionInput =
  | {
      toolCallId: string;
      name: typeof Tools.file_search;
      args: PiFileSearchArguments;
    }
  | {
      toolCallId: string;
      name: typeof PI_CALCULATOR_TOOL_NAME;
      args: PiCalculatorArguments;
    }
  | {
      toolCallId: string;
      name: typeof PI_BASH_TOOL_NAME;
      args: PiBashArguments;
    }
  | {
      toolCallId: string;
      name: typeof PI_READ_FILE_TOOL_NAME;
      args: PiReadFileArguments;
    };

/** The caller owns authorization and execution; this module only supplies Pi's tool contract. */
export type PiHostToolExecutor = (
  input: PiHostToolExecutionInput,
  signal?: AbortSignal,
) => Promise<AgentToolResult>;

type PiSdkToolDefinition = ToolDefinition<TSchema>;
export type PiHostToolDefinition = Omit<LCTool, 'parameters'> & { parameters?: unknown };
type PiHostToolExecute = (
  toolCallId: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<AgentToolResult>;

/** No Pi extension context is exposed to the host executor. */
export type PiToolDefinition = Omit<PiSdkToolDefinition, 'execute'> & {
  execute: PiHostToolExecute;
};

export type PiToolCompatibilityCode =
  | 'PI_TOOL_UNSUPPORTED'
  | 'PI_TOOL_SCHEMA_UNSUPPORTED'
  | 'PI_TOOL_EXECUTION_UNAVAILABLE'
  | 'PI_TOOL_ARGUMENTS_INVALID';

const ERROR_MESSAGES: Record<PiToolCompatibilityCode, string> = {
  PI_TOOL_UNSUPPORTED: 'This tool is not supported by the Pi runtime.',
  PI_TOOL_SCHEMA_UNSUPPORTED: 'This tool schema is not supported by the Pi runtime.',
  PI_TOOL_EXECUTION_UNAVAILABLE: 'Authorized host tool execution is unavailable.',
  PI_TOOL_ARGUMENTS_INVALID: 'The Pi tool arguments are invalid.',
};

const TOOL_FIELDS = {
  [Tools.file_search]: {
    argument: 'query',
    label: 'File Search',
    description: 'Search files the current agent is authorized to access.',
  },
  [PI_CALCULATOR_TOOL_NAME]: {
    argument: 'input',
    label: 'Calculator',
    description: 'Evaluate a mathematical expression using the authorized host calculator.',
  },
  [PI_BASH_TOOL_NAME]: {
    label: 'Code execution',
    description: 'Run a command through the authorized Code API execution service.',
  },
  [PI_READ_FILE_TOOL_NAME]: {
    label: 'Read file',
    description: 'Read a file from the authorized code-execution environment.',
  },
} as const;

export class PiToolCompatibilityError extends Error {
  readonly code: PiToolCompatibilityCode;

  constructor(code: PiToolCompatibilityCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'PiToolCompatibilityError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function validateDescription(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 16_384) {
    throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
  }
  return value;
}

function optionalDescription(value: Record<string, unknown>): string | undefined {
  return validateDescription(value.description);
}

function isStringProperty(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && hasOnlyKeys(value, ['type', 'description']) && value.type === 'string';
}

function isIntegerProperty(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'minimum', 'maximum', 'description']) &&
    value.type === 'integer' &&
    (value.minimum === undefined ||
      (Number.isSafeInteger(value.minimum) && (value.minimum as number) >= 1)) &&
    (value.maximum === undefined ||
      (Number.isSafeInteger(value.maximum) &&
        (value.maximum as number) >= ((value.minimum as number | undefined) ?? 1)))
  );
}

function isReadFileMaxLinesProperty(value: unknown): value is Record<string, unknown> {
  return (
    isIntegerProperty(value) &&
    Number.isSafeInteger(value.maximum) &&
    (value.maximum as number) <= MAX_PI_READ_FILE_LINES
  );
}

function convertPiCodeToolSchema(name: string, schema: Record<string, unknown>): TSchema {
  const properties = schema.properties;
  const required = schema.required;
  if (!isRecord(properties) || !Array.isArray(required)) {
    throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
  }
  const objectDescription = optionalDescription(schema);
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
  }

  if (name === PI_BASH_TOOL_NAME) {
    if (
      !hasOnlyKeys(properties, ['command', 'args', 'intent']) ||
      required.length !== 1 ||
      required[0] !== 'command' ||
      !isStringProperty(properties.command)
    ) {
      throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
    }
    const argsSchema = properties.args;
    if (
      argsSchema !== undefined &&
      (!isRecord(argsSchema) ||
        !hasOnlyKeys(argsSchema, ['type', 'items', 'description']) ||
        argsSchema.type !== 'array' ||
        !isRecord(argsSchema.items) ||
        !hasOnlyKeys(argsSchema.items, ['type', 'description']) ||
        argsSchema.items.type !== 'string')
    ) {
      throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
    }
    if (properties.intent !== undefined && !isStringProperty(properties.intent)) {
      throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
    }
    return {
      type: 'object',
      required: ['command'],
      properties: {
        command: {
          type: 'string',
          ...(optionalDescription(properties.command) == null
            ? {}
            : { description: optionalDescription(properties.command) }),
        },
        ...(argsSchema == null
          ? {}
          : {
              args: {
                type: 'array',
                items: {
                  type: 'string',
                  ...(optionalDescription(argsSchema.items as Record<string, unknown>) == null
                    ? {}
                    : {
                        description: optionalDescription(
                          argsSchema.items as Record<string, unknown>,
                        ),
                      }),
                },
                ...(optionalDescription(argsSchema) == null
                  ? {}
                  : { description: optionalDescription(argsSchema) }),
              },
            }),
        ...(properties.intent == null
          ? {}
          : {
              intent: {
                type: 'string',
                ...(optionalDescription(properties.intent as Record<string, unknown>) == null
                  ? {}
                  : {
                      description: optionalDescription(
                        properties.intent as Record<string, unknown>,
                      ),
                    }),
              },
            }),
      },
      additionalProperties: false,
      ...(objectDescription == null ? {} : { description: objectDescription }),
    } satisfies TSchema;
  }

  if (
    name !== PI_READ_FILE_TOOL_NAME ||
    !hasOnlyKeys(properties, ['path', 'start_line', 'max_lines', 'intent']) ||
    required.length !== 1 ||
    required[0] !== 'path' ||
    !isStringProperty(properties.path) ||
    (properties.start_line !== undefined && !isIntegerProperty(properties.start_line)) ||
    (properties.max_lines !== undefined && !isReadFileMaxLinesProperty(properties.max_lines)) ||
    (properties.intent !== undefined && !isStringProperty(properties.intent))
  ) {
    throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
  }
  const optionalProperties = ['start_line', 'max_lines', 'intent'] as const;
  return {
    type: 'object',
    required: ['path'],
    properties: {
      path: {
        type: 'string',
        ...(optionalDescription(properties.path) == null
          ? {}
          : { description: optionalDescription(properties.path) }),
      },
      ...Object.fromEntries(
        optionalProperties.flatMap((key) => {
          const property = properties[key];
          if (property == null) return [];
          if (!isRecord(property)) {
            throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
          }
          return [
            [
              key,
              {
                type: property.type,
                ...(property.minimum == null ? {} : { minimum: property.minimum }),
                ...(property.maximum == null ? {} : { maximum: property.maximum }),
                ...(optionalDescription(property) == null
                  ? {}
                  : { description: optionalDescription(property) }),
              },
            ],
          ];
        }),
      ),
    },
    additionalProperties: false,
    ...(objectDescription == null ? {} : { description: objectDescription }),
  } satisfies TSchema;
}

/** Converts reviewed host schemas only; unrecognized JSON Schema fails closed. */
export function convertPiToolSchema(name: string, schema: unknown): TSchema {
  if (
    !isPiSupportedHostToolName(name) ||
    !isRecord(schema) ||
    !hasOnlyKeys(schema, [
      'type',
      'properties',
      'required',
      'additionalProperties',
      'description',
    ]) ||
    schema.type !== 'object' ||
    !isRecord(schema.properties)
  ) {
    throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
  }

  if (name === PI_BASH_TOOL_NAME || name === PI_READ_FILE_TOOL_NAME) {
    return convertPiCodeToolSchema(name, schema);
  }

  const { argument } = TOOL_FIELDS[name];
  const propertySchema = schema.properties[argument];
  if (
    !hasOnlyKeys(schema.properties, [argument]) ||
    !isRecord(propertySchema) ||
    !hasOnlyKeys(propertySchema, ['type', 'description']) ||
    propertySchema.type !== 'string'
  ) {
    throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
  }

  const required = schema.required;
  if (
    !Array.isArray(required) ||
    required.length !== 1 ||
    required[0] !== argument ||
    (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
  ) {
    throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
  }

  const objectDescription = validateDescription(schema.description);
  const propertyDescription = validateDescription(propertySchema.description);
  if (name === Tools.file_search) {
    return {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          ...(propertyDescription === undefined ? {} : { description: propertyDescription }),
        },
      },
      additionalProperties: false,
      ...(objectDescription === undefined ? {} : { description: objectDescription }),
    } satisfies TSchema;
  }

  return {
    type: 'object',
    required: ['input'],
    properties: {
      input: {
        type: 'string',
        ...(propertyDescription === undefined ? {} : { description: propertyDescription }),
      },
    },
    additionalProperties: false,
    ...(objectDescription === undefined ? {} : { description: objectDescription }),
  } satisfies TSchema;
}

export function validatePiFileSearchArguments(value: unknown): PiFileSearchArguments {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['query']) ||
    typeof value.query !== 'string' ||
    value.query.length === 0
  ) {
    throw new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID');
  }
  return { query: value.query };
}

export function validatePiCalculatorArguments(value: unknown): PiCalculatorArguments {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['input']) ||
    typeof value.input !== 'string' ||
    value.input.length === 0
  ) {
    throw new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID');
  }
  return { input: value.input };
}

export function validatePiBashArguments(value: unknown): PiBashArguments {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['command', 'args', 'intent']) ||
    typeof value.command !== 'string' ||
    value.command.length === 0 ||
    value.command.length > 131_072 ||
    (value.args !== undefined &&
      (!Array.isArray(value.args) ||
        value.args.length > 128 ||
        !value.args.every((arg) => typeof arg === 'string' && arg.length <= 16_384))) ||
    (value.intent !== undefined &&
      (typeof value.intent !== 'string' || value.intent.length > 1_000))
  ) {
    throw new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID');
  }
  return {
    command: value.command,
    ...(value.args == null ? {} : { args: [...value.args] as string[] }),
    ...(value.intent == null ? {} : { intent: value.intent }),
  };
}

export function validatePiReadFileArguments(value: unknown): PiReadFileArguments {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['path', 'start_line', 'max_lines', 'intent']) ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    value.path.length > 4_096 ||
    (value.start_line !== undefined &&
      (!Number.isSafeInteger(value.start_line) || (value.start_line as number) < 1)) ||
    (value.max_lines !== undefined &&
      (!Number.isSafeInteger(value.max_lines) ||
        (value.max_lines as number) < 1 ||
        (value.max_lines as number) > MAX_PI_READ_FILE_LINES)) ||
    (value.intent !== undefined &&
      (typeof value.intent !== 'string' || value.intent.length > 1_000))
  ) {
    throw new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID');
  }
  return {
    path: value.path,
    ...(value.start_line == null ? {} : { start_line: value.start_line as number }),
    ...(value.max_lines == null ? {} : { max_lines: value.max_lines as number }),
    ...(value.intent == null ? {} : { intent: value.intent }),
  };
}

export function validatePiToolExecutionInput(
  name: string,
  toolCallId: string,
  args: unknown,
): PiHostToolExecutionInput {
  if (toolCallId.length === 0) {
    throw new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID');
  }

  switch (name) {
    case Tools.file_search:
      return {
        toolCallId,
        name: Tools.file_search,
        args: validatePiFileSearchArguments(args),
      };
    case PI_CALCULATOR_TOOL_NAME:
      return {
        toolCallId,
        name: PI_CALCULATOR_TOOL_NAME,
        args: validatePiCalculatorArguments(args),
      };
    case PI_BASH_TOOL_NAME:
      return {
        toolCallId,
        name: PI_BASH_TOOL_NAME,
        args: validatePiBashArguments(args),
      };
    case PI_READ_FILE_TOOL_NAME:
      return {
        toolCallId,
        name: PI_READ_FILE_TOOL_NAME,
        args: validatePiReadFileArguments(args),
      };
    default:
      throw new PiToolCompatibilityError('PI_TOOL_UNSUPPORTED');
  }
}

/**
 * Invoke the host-owned callback with validated arguments. No Pi extension
 * context is exposed, and no local shell or filesystem fallback exists.
 */
export async function executePiToolCall(input: {
  execute?: PiHostToolExecutor;
  name: string;
  toolCallId: string;
  arguments: unknown;
  signal?: AbortSignal;
}): Promise<AgentToolResult> {
  if (typeof input.execute !== 'function') {
    throw new PiToolCompatibilityError('PI_TOOL_EXECUTION_UNAVAILABLE');
  }
  if (!isPiSupportedHostToolName(input.name)) {
    throw new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID');
  }
  return input.execute(
    validatePiToolExecutionInput(input.name, input.toolCallId, input.arguments),
    input.signal,
  );
}

export function createPiTools(input: {
  definitions: readonly PiHostToolDefinition[];
  execute?: PiHostToolExecutor;
}): PiToolDefinition[] {
  if (!Array.isArray(input.definitions)) {
    throw new PiToolCompatibilityError('PI_TOOL_UNSUPPORTED');
  }
  if (input.definitions.length === 0) {
    return [];
  }
  if (typeof input.execute !== 'function') {
    throw new PiToolCompatibilityError('PI_TOOL_EXECUTION_UNAVAILABLE');
  }

  const seenNames = new Set<string>();
  return input.definitions.map((definition) => {
    const candidateName: unknown = definition.name;
    if (!isPiSupportedHostToolName(candidateName) || seenNames.has(candidateName)) {
      throw new PiToolCompatibilityError('PI_TOOL_UNSUPPORTED');
    }
    seenNames.add(candidateName);
    if (definition.parameters === undefined) {
      throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
    }

    const name = candidateName;
    const parameters = convertPiToolSchema(name, definition.parameters);
    return {
      name,
      label: TOOL_FIELDS[name].label,
      description: validateDescription(definition.description) ?? TOOL_FIELDS[name].description,
      parameters,
      executionMode: 'sequential',
      execute: (toolCallId, args, signal) =>
        executePiToolCall({
          execute: input.execute,
          name,
          toolCallId,
          arguments: args,
          signal,
        }),
    };
  });
}
