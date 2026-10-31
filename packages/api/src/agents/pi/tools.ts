import { Tools } from 'librechat-data-provider';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { LCTool } from '@librechat/agents';
import type { TSchema } from 'typebox';
import { isPiSupportedHostToolName, PI_CALCULATOR_TOOL_NAME } from './toolNames';

export type PiFileSearchArguments = Record<string, unknown> & {
  query: string;
};

export type PiCalculatorArguments = Record<string, unknown> & {
  input: string;
};

export type PiToolArguments = PiFileSearchArguments | PiCalculatorArguments;

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
    };

/** The caller owns authorization and execution; this module only supplies Pi's tool contract. */
export type PiHostToolExecutor = (
  input: PiHostToolExecutionInput,
  signal?: AbortSignal,
) => Promise<AgentToolResult>;

type PiSdkToolDefinition = ToolDefinition<TSchema>;
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

/**
 * Converts only the reviewed one-string object schemas used by host file_search
 * and calculator tools. Other JSON Schema features fail closed at admission.
 */
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
  definitions: readonly LCTool[];
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
