import { DATE_RANGE } from '@librechat/agents';
import { Tools } from 'librechat-data-provider';
import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { LCTool } from '@librechat/agents';
import type { TSchema } from 'typebox';
import {
  createPiMcpToolSchema,
  createPiMcpToolSchemaRegistry,
  isPiMcpToolName,
  PiMcpSchemaCompatibilityError,
  type PiMcpSchemaFingerprint,
  type PiMcpToolArguments,
  type PiMcpToolName,
  type PiMcpToolSchema,
  type PiMcpToolSchemaRegistry,
} from './mcpSchema';
import {
  isPiSupportedHostToolName,
  PI_BASH_TOOL_NAME,
  PI_CALCULATOR_TOOL_NAME,
  PI_READ_FILE_TOOL_NAME,
  PI_SKILL_TOOL_NAME,
  PI_WEB_SEARCH_TOOL_NAME,
} from './toolNames';

export type PiFileSearchArguments = { query: string };

export type PiWebSearchArguments = {
  intent?: string;
  query: string;
  date?: DATE_RANGE;
  country?: string;
  images?: boolean;
  videos?: boolean;
  news?: boolean;
};

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

export type PiSkillArguments = {
  intent?: string;
  skillName: string;
  args?: string;
};

export type PiBuiltInToolArguments =
  | PiFileSearchArguments
  | PiWebSearchArguments
  | PiCalculatorArguments
  | PiBashArguments
  | PiReadFileArguments
  | PiSkillArguments;

export type PiToolArguments = PiBuiltInToolArguments | PiMcpToolArguments;

const MAX_PI_READ_FILE_LINES = 500;

export type PiHostToolExecutionInput =
  | {
      toolCallId: string;
      name: typeof Tools.file_search;
      args: PiFileSearchArguments;
    }
  | {
      toolCallId: string;
      name: typeof PI_WEB_SEARCH_TOOL_NAME;
      args: PiWebSearchArguments;
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
    }
  | {
      toolCallId: string;
      name: typeof PI_SKILL_TOOL_NAME;
      args: PiSkillArguments;
    }
  | {
      kind: 'mcp';
      toolCallId: string;
      name: PiMcpToolName;
      args: PiMcpToolArguments;
      schemaFingerprint: PiMcpSchemaFingerprint;
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
  [PI_WEB_SEARCH_TOOL_NAME]: {
    label: 'Web Search',
    description: 'Search the web using the administrator-configured provider.',
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
  [PI_SKILL_TOOL_NAME]: {
    label: 'Load skill',
    description: 'Load an accessible LibreChat skill into this conversation.',
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

export interface PiToolValidationContext {
  mcpToolSchemas?: PiMcpToolSchemaRegistry;
  mcpToolSchema?: PiMcpToolSchema;
  expectedSchemaFingerprint?: PiMcpSchemaFingerprint;
}

function validateMcpSchemaResult<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof PiMcpSchemaCompatibilityError) {
      throw new PiToolCompatibilityError(error.code);
    }
    throw error;
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

function isBooleanProperty(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && hasOnlyKeys(value, ['type', 'description']) && value.type === 'boolean';
}

const WEB_SEARCH_DATE_RANGES = Object.values(DATE_RANGE);
const WEB_SEARCH_DATE_RANGE_SET = new Set<string>(WEB_SEARCH_DATE_RANGES);

function isWebSearchDateRange(value: unknown): value is DATE_RANGE {
  return typeof value === 'string' && WEB_SEARCH_DATE_RANGE_SET.has(value);
}

function convertPiWebSearchSchema(schema: Record<string, unknown>): TSchema {
  const properties = schema.properties;
  const required = schema.required;
  if (
    !isRecord(properties) ||
    !hasOnlyKeys(properties, ['intent', 'query', 'date', 'country', 'images', 'videos', 'news']) ||
    !Array.isArray(required) ||
    required.length !== 1 ||
    required[0] !== 'query' ||
    !isStringProperty(properties.query) ||
    (properties.intent !== undefined && !isStringProperty(properties.intent)) ||
    (properties.country !== undefined && !isStringProperty(properties.country)) ||
    (properties.images !== undefined && !isBooleanProperty(properties.images)) ||
    (properties.videos !== undefined && !isBooleanProperty(properties.videos)) ||
    (properties.news !== undefined && !isBooleanProperty(properties.news)) ||
    (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
  ) {
    throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
  }

  const dateSchema = properties.date;
  if (
    dateSchema !== undefined &&
    (!isRecord(dateSchema) ||
      !hasOnlyKeys(dateSchema, ['type', 'enum', 'description']) ||
      dateSchema.type !== 'string' ||
      !Array.isArray(dateSchema.enum) ||
      dateSchema.enum.length !== WEB_SEARCH_DATE_RANGES.length ||
      new Set(dateSchema.enum).size !== WEB_SEARCH_DATE_RANGES.length ||
      !dateSchema.enum.every(isWebSearchDateRange))
  ) {
    throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
  }

  const stringProperty = (property: Record<string, unknown> | undefined) => ({
    type: 'string' as const,
    ...(optionalDescription(property ?? {}) == null
      ? {}
      : { description: optionalDescription(property ?? {}) }),
  });
  const booleanProperty = (property: Record<string, unknown> | undefined) => ({
    type: 'boolean' as const,
    ...(optionalDescription(property ?? {}) == null
      ? {}
      : { description: optionalDescription(property ?? {}) }),
  });
  const dateDescription = isRecord(dateSchema) ? optionalDescription(dateSchema) : undefined;

  return {
    type: 'object',
    required: ['query'],
    properties: {
      ...(properties.intent == null ? {} : { intent: stringProperty(properties.intent) }),
      query: stringProperty(properties.query),
      ...(dateSchema == null
        ? {}
        : {
            date: {
              type: 'string' as const,
              enum: WEB_SEARCH_DATE_RANGES,
              ...(dateDescription == null ? {} : { description: dateDescription }),
            },
          }),
      ...(properties.country == null ? {} : { country: stringProperty(properties.country) }),
      ...(properties.images == null ? {} : { images: booleanProperty(properties.images) }),
      ...(properties.videos == null ? {} : { videos: booleanProperty(properties.videos) }),
      ...(properties.news == null ? {} : { news: booleanProperty(properties.news) }),
    },
    additionalProperties: false,
    ...(optionalDescription(schema) == null ? {} : { description: optionalDescription(schema) }),
  } satisfies TSchema;
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

function convertPiSkillSchema(schema: Record<string, unknown>): TSchema {
  const properties = schema.properties;
  const required = schema.required;
  if (
    !isRecord(properties) ||
    !hasOnlyKeys(properties, ['intent', 'skillName', 'args']) ||
    !Array.isArray(required) ||
    required.length !== 1 ||
    required[0] !== 'skillName' ||
    (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
  ) {
    throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
  }

  for (const property of Object.values(properties)) {
    if (!isStringProperty(property)) {
      throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
    }
    optionalDescription(property);
  }

  const stringProperty = (property: unknown) => {
    if (!isStringProperty(property)) {
      throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
    }
    const description = optionalDescription(property);
    return {
      type: 'string' as const,
      ...(description == null ? {} : { description }),
    };
  };
  return {
    type: 'object',
    required: ['skillName'],
    properties: {
      ...(properties.intent == null ? {} : { intent: stringProperty(properties.intent) }),
      skillName: stringProperty(properties.skillName),
      ...(properties.args == null ? {} : { args: stringProperty(properties.args) }),
    },
    additionalProperties: false,
    ...(optionalDescription(schema) == null ? {} : { description: optionalDescription(schema) }),
  } satisfies TSchema;
}

/** Converts reviewed host schemas only; unrecognized JSON Schema fails closed. */
export function convertPiToolSchema(name: string, schema: unknown): TSchema {
  if (isPiMcpToolName(name)) {
    return validateMcpSchemaResult(() => createPiMcpToolSchema(name, schema).parameters);
  }
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
  if (name === PI_SKILL_TOOL_NAME) {
    return convertPiSkillSchema(schema);
  }
  if (name === PI_WEB_SEARCH_TOOL_NAME) {
    return convertPiWebSearchSchema(schema);
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

export function validatePiWebSearchArguments(value: unknown): PiWebSearchArguments {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['intent', 'query', 'date', 'country', 'images', 'videos', 'news'])
  ) {
    throw new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID');
  }

  const { intent, query, date, country, images, videos, news } = value;
  if (
    typeof query !== 'string' ||
    query.length === 0 ||
    query.length > 16_384 ||
    (intent !== undefined &&
      (typeof intent !== 'string' || intent.length === 0 || intent.length > 1_000)) ||
    (date !== undefined && !isWebSearchDateRange(date)) ||
    (country !== undefined && (typeof country !== 'string' || !/^[a-z]{2}$/i.test(country))) ||
    (images !== undefined && typeof images !== 'boolean') ||
    (videos !== undefined && typeof videos !== 'boolean') ||
    (news !== undefined && typeof news !== 'boolean')
  ) {
    throw new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID');
  }

  return {
    ...(intent === undefined ? {} : { intent }),
    query,
    ...(date === undefined ? {} : { date }),
    ...(country === undefined ? {} : { country }),
    ...(images === undefined ? {} : { images }),
    ...(videos === undefined ? {} : { videos }),
    ...(news === undefined ? {} : { news }),
  };
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

export function validatePiSkillArguments(value: unknown): PiSkillArguments {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['intent', 'skillName', 'args']) ||
    typeof value.skillName !== 'string' ||
    value.skillName.length === 0 ||
    value.skillName.length > 200 ||
    (value.intent !== undefined &&
      (typeof value.intent !== 'string' || value.intent.length > 1_000)) ||
    (value.args !== undefined && (typeof value.args !== 'string' || value.args.length > 131_072))
  ) {
    throw new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID');
  }
  return {
    ...(value.intent == null ? {} : { intent: value.intent }),
    skillName: value.skillName,
    ...(value.args == null ? {} : { args: value.args }),
  };
}

export function validatePiToolExecutionInput(
  name: string,
  toolCallId: string,
  args: unknown,
  context: PiToolValidationContext = {},
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
    case PI_WEB_SEARCH_TOOL_NAME:
      return {
        toolCallId,
        name: PI_WEB_SEARCH_TOOL_NAME,
        args: validatePiWebSearchArguments(args),
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
    case PI_SKILL_TOOL_NAME:
      return {
        toolCallId,
        name: PI_SKILL_TOOL_NAME,
        args: validatePiSkillArguments(args),
      };
    default: {
      if (!isPiMcpToolName(name)) {
        throw new PiToolCompatibilityError('PI_TOOL_UNSUPPORTED');
      }
      const schema = context.mcpToolSchema ?? context.mcpToolSchemas?.get(name);
      if (schema == null) {
        throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
      }
      if (
        context.expectedSchemaFingerprint != null &&
        schema.fingerprint !== context.expectedSchemaFingerprint
      ) {
        throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
      }
      return {
        kind: 'mcp',
        toolCallId,
        name,
        args: validateMcpSchemaResult(() => schema.validateArguments(args)),
        schemaFingerprint: schema.fingerprint,
      };
    }
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
  mcpToolSchema?: PiMcpToolSchema;
  signal?: AbortSignal;
}): Promise<AgentToolResult> {
  if (typeof input.execute !== 'function') {
    throw new PiToolCompatibilityError('PI_TOOL_EXECUTION_UNAVAILABLE');
  }
  if (!isPiSupportedHostToolName(input.name) && !isPiMcpToolName(input.name)) {
    throw new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID');
  }
  return input.execute(
    validatePiToolExecutionInput(input.name, input.toolCallId, input.arguments, {
      ...(input.mcpToolSchema == null ? {} : { mcpToolSchema: input.mcpToolSchema }),
    }),
    input.signal,
  );
}

/** Compile schemas once per isolated Pi generation and translate boundary errors. */
export function compilePiMcpToolSchemaRegistry(
  definitions: readonly PiHostToolDefinition[],
): PiMcpToolSchemaRegistry {
  return validateMcpSchemaResult(() => createPiMcpToolSchemaRegistry(definitions));
}

export function createPiTools(input: {
  definitions: readonly PiHostToolDefinition[];
  execute?: PiHostToolExecutor;
  mcpToolSchemas?: PiMcpToolSchemaRegistry;
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

  const definitionNames = new Set<string>();
  for (const definition of input.definitions) {
    const candidateName: unknown = definition.name;
    if (
      typeof candidateName !== 'string' ||
      (!isPiSupportedHostToolName(candidateName) && !isPiMcpToolName(candidateName)) ||
      definitionNames.has(candidateName)
    ) {
      throw new PiToolCompatibilityError('PI_TOOL_UNSUPPORTED');
    }
    definitionNames.add(candidateName);
  }

  const mcpToolSchemas = input.mcpToolSchemas ?? compilePiMcpToolSchemaRegistry(input.definitions);

  const seenNames = new Set<string>();
  return input.definitions.map((definition) => {
    const candidateName: unknown = definition.name;
    if (
      (!isPiSupportedHostToolName(candidateName) && !isPiMcpToolName(candidateName)) ||
      seenNames.has(candidateName)
    ) {
      throw new PiToolCompatibilityError('PI_TOOL_UNSUPPORTED');
    }
    seenNames.add(candidateName);
    if (definition.parameters === undefined) {
      throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
    }

    const name = candidateName;
    if (isPiMcpToolName(name)) {
      const schema = mcpToolSchemas.get(name);
      if (schema == null) {
        throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
      }
      const description = validateDescription(definition.description);
      return {
        name,
        label: name,
        description: description ?? name,
        parameters: schema.parameters,
        executionMode: 'sequential',
        execute: (toolCallId, args, signal) =>
          executePiToolCall({
            execute: input.execute,
            name,
            toolCallId,
            arguments: args,
            mcpToolSchema: schema,
            signal,
          }),
      };
    }
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
