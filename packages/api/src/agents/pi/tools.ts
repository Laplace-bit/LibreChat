import { Tools } from 'librechat-data-provider';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { LCTool } from '@librechat/agents';
import type { TSchema } from 'typebox';

export type PiFileSearchArguments = Record<string, unknown> & {
  query: string;
};

export interface PiHostToolExecutionInput {
  toolCallId: string;
  name: typeof Tools.file_search;
  args: PiFileSearchArguments;
}

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
 * The first Pi tool slice intentionally accepts only the existing file_search schema:
 * one required string query and no additional properties. This converts the trusted
 * LCTool JSON Schema into a Pi TypeBox schema and rejects widening/complexity at the edge.
 */
export function convertPiToolSchema(schema: unknown): TSchema {
  if (
    !isRecord(schema) ||
    !hasOnlyKeys(schema, [
      'type',
      'properties',
      'required',
      'additionalProperties',
      'description',
    ]) ||
    schema.type !== 'object' ||
    !isRecord(schema.properties) ||
    !hasOnlyKeys(schema.properties, ['query']) ||
    !isRecord(schema.properties.query)
  ) {
    throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
  }

  const objectDescription = validateDescription(schema.description);
  const querySchema = schema.properties.query;
  if (!hasOnlyKeys(querySchema, ['type', 'description']) || querySchema.type !== 'string') {
    throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
  }

  const queryDescription = validateDescription(querySchema.description);
  const required = schema.required;
  if (
    !Array.isArray(required) ||
    required.length !== 1 ||
    required[0] !== 'query' ||
    (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
  ) {
    throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
  }

  return {
    type: 'object',
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        ...(queryDescription === undefined ? {} : { description: queryDescription }),
      },
    },
    additionalProperties: false,
    ...(objectDescription === undefined ? {} : { description: objectDescription }),
  } satisfies TSchema;
}

function parsePiFileSearchArguments(value: unknown): PiFileSearchArguments {
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

/**
 * Invoke the host-owned callback with validated file_search arguments. Kept separate
 * from Pi's ExtensionToolContext so the host callback receives no ambient Pi capabilities.
 */
export async function executePiToolCall(input: {
  execute?: PiHostToolExecutor;
  toolCallId: string;
  arguments: unknown;
  signal?: AbortSignal;
}): Promise<AgentToolResult> {
  if (typeof input.execute !== 'function') {
    throw new PiToolCompatibilityError('PI_TOOL_EXECUTION_UNAVAILABLE');
  }
  if (input.toolCallId.length === 0) {
    throw new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID');
  }

  return input.execute(
    {
      toolCallId: input.toolCallId,
      name: Tools.file_search,
      args: parsePiFileSearchArguments(input.arguments),
    },
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
  if (input.definitions.length !== 1 || input.definitions[0]?.name !== Tools.file_search) {
    throw new PiToolCompatibilityError('PI_TOOL_UNSUPPORTED');
  }
  if (typeof input.execute !== 'function') {
    throw new PiToolCompatibilityError('PI_TOOL_EXECUTION_UNAVAILABLE');
  }

  const [definition] = input.definitions;
  if (definition.parameters === undefined) {
    throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
  }

  const parameters = convertPiToolSchema(definition.parameters);
  return [
    {
      name: Tools.file_search,
      label: 'File Search',
      description:
        validateDescription(definition.description) ??
        'Search files the current agent is authorized to access.',
      parameters,
      executionMode: 'sequential',
      execute: (toolCallId, args, signal) =>
        executePiToolCall({
          execute: input.execute,
          toolCallId,
          arguments: args,
          signal,
        }),
    },
  ];
}
