import { RE2JS } from 're2js';
import type { TSchema } from 'typebox';
import type { PiToolDefinition } from './tools';
import { PiToolCompatibilityError } from './tools';

export interface PiCallerToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface PiCallerToolDefinition {
  name: string;
  description?: string;
  parameters?: unknown;
}

const EMPTY_PARAMETERS = { type: 'object', properties: {} } as const;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 10_000;
const MAX_SCHEMA_PROPERTIES = 256;
const MAX_SCHEMA_COLLECTION_SIZE = 256;
const MAX_SCHEMA_BOUND = 65_536;
const MAX_SCHEMA_STRING_LENGTH = 4_096;
const CLIENT_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/u;
const JSON_SCHEMA_KEYS = new Set([
  'type',
  'title',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
]);
const JSON_SCHEMA_TYPES = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > MAX_SCHEMA_DEPTH) {
    return false;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_SCHEMA_COLLECTION_SIZE &&
      value.every((entry) => isJsonValue(entry, depth + 1))
    );
  }
  if (!isRecord(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_SCHEMA_PROPERTIES &&
    entries.every(([key, entry]) => isSafeSchemaPropertyName(key) && isJsonValue(entry, depth + 1))
  );
}

function isSafeSchemaPropertyName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    !['__proto__', 'constructor', 'prototype'].includes(value)
  );
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

const compiledPatterns = new WeakMap<object, ReturnType<typeof RE2JS.compile>>();

/** Bounds the JSON Schema subset that TypeBox compiles for caller-owned tools. */
function validateJsonSchema(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): value is Record<string, unknown> {
  state.nodes += 1;
  if (
    !isRecord(value) ||
    depth > MAX_SCHEMA_DEPTH ||
    state.nodes > MAX_SCHEMA_NODES ||
    !hasOnlyKeys(value, JSON_SCHEMA_KEYS)
  ) {
    return false;
  }

  if (
    value.type !== undefined &&
    (typeof value.type !== 'string' || !JSON_SCHEMA_TYPES.has(value.type))
  ) {
    return false;
  }
  if (
    (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 256)) ||
    (value.description !== undefined &&
      (typeof value.description !== 'string' ||
        value.description.length > MAX_SCHEMA_STRING_LENGTH)) ||
    (value.pattern !== undefined &&
      (typeof value.pattern !== 'string' || value.pattern.length > 2_048))
  ) {
    return false;
  }

  if (value.pattern !== undefined) {
    try {
      compiledPatterns.set(value, RE2JS.compile(value.pattern));
    } catch {
      return false;
    }
  }

  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) {
      return false;
    }
    const properties = Object.entries(value.properties);
    if (
      properties.length > MAX_SCHEMA_PROPERTIES ||
      !properties.every(
        ([key, schema]) =>
          isSafeSchemaPropertyName(key) && validateJsonSchema(schema, state, depth + 1),
      )
    ) {
      return false;
    }
  }

  if (value.required !== undefined) {
    if (
      !Array.isArray(value.required) ||
      value.required.length > MAX_SCHEMA_PROPERTIES ||
      !value.required.every(
        (entry) => typeof entry === 'string' && isSafeSchemaPropertyName(entry),
      ) ||
      new Set(value.required).size !== value.required.length
    ) {
      return false;
    }
  }

  if (
    value.additionalProperties !== undefined &&
    typeof value.additionalProperties !== 'boolean' &&
    !validateJsonSchema(value.additionalProperties, state, depth + 1)
  ) {
    return false;
  }
  if (value.items !== undefined && !validateJsonSchema(value.items, state, depth + 1)) {
    return false;
  }

  if (value.enum !== undefined) {
    const enumValues = value.enum;
    if (!Array.isArray(enumValues) || enumValues.length === 0 || enumValues.length > 256) {
      return false;
    }
    if (!enumValues.every((entry) => isJsonValue(entry))) {
      return false;
    }
    if (
      enumValues.some((entry, index) =>
        enumValues.slice(0, index).some((prior) => jsonEqual(prior, entry)),
      )
    ) {
      return false;
    }
  }

  for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = value[keyword];
    if (
      variants !== undefined &&
      (!Array.isArray(variants) ||
        variants.length === 0 ||
        variants.length > 64 ||
        !variants.every((variant) => validateJsonSchema(variant, state, depth + 1)))
    ) {
      return false;
    }
  }
  if (value.not !== undefined && !validateJsonSchema(value.not, state, depth + 1)) {
    return false;
  }

  for (const keyword of [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
  ] as const) {
    if (
      value[keyword] !== undefined &&
      (typeof value[keyword] !== 'number' ||
        !Number.isFinite(value[keyword]) ||
        (keyword === 'multipleOf' && value[keyword] <= 0))
    ) {
      return false;
    }
  }

  for (const keyword of [
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
  ] as const) {
    const maximum =
      keyword === 'minLength' || keyword === 'maxLength'
        ? MAX_SCHEMA_BOUND
        : MAX_SCHEMA_COLLECTION_SIZE;
    if (
      value[keyword] !== undefined &&
      (!Number.isSafeInteger(value[keyword]) ||
        Number(value[keyword]) < 0 ||
        Number(value[keyword]) > maximum)
    ) {
      return false;
    }
  }

  for (const [minimum, maximum] of [
    ['minLength', 'maxLength'],
    ['minItems', 'maxItems'],
    ['minProperties', 'maxProperties'],
  ] as const) {
    if (
      typeof value[minimum] === 'number' &&
      typeof value[maximum] === 'number' &&
      value[minimum] > value[maximum]
    ) {
      return false;
    }
  }

  if (value.uniqueItems !== undefined && typeof value.uniqueItems !== 'boolean') {
    return false;
  }
  if (value.const !== undefined && !isJsonValue(value.const)) {
    return false;
  }
  return true;
}

function compileCallerToolSchema(parameters: unknown): {
  schema: TSchema;
  check(value: unknown): boolean;
} {
  const schema = parameters ?? EMPTY_PARAMETERS;
  let serialized: string;
  try {
    serialized = JSON.stringify(schema) ?? '';
  } catch {
    throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
  }
  if (
    Buffer.byteLength(serialized, 'utf8') > MAX_SCHEMA_BYTES ||
    !isRecord(schema) ||
    schema.type !== 'object' ||
    !validateJsonSchema(schema, { nodes: 0 })
  ) {
    throw new PiToolCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
  }

  return {
    /** The bounded validator above establishes the structural TSchema contract. */
    schema: schema as TSchema,
    check: (value) => matchesJsonSchema(schema, value),
  };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => jsonEqual(entry, right[index]))
    );
  }
  if (!isJsonRecord(left) || !isJsonRecord(right)) {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]))
  );
}

function matchesJsonType(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isJsonRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function matchesJsonSchema(schema: Record<string, unknown>, value: unknown): boolean {
  if (schema.type !== undefined && !matchesJsonType(schema.type, value)) {
    return false;
  }
  if (schema.const !== undefined && !jsonEqual(schema.const, value)) {
    return false;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((allowedValue) => jsonEqual(allowedValue, value))
  ) {
    return false;
  }

  if (typeof value === 'string') {
    if (
      (typeof schema.minLength === 'number' && [...value].length < schema.minLength) ||
      (typeof schema.maxLength === 'number' && [...value].length > schema.maxLength)
    ) {
      return false;
    }
    const pattern = compiledPatterns.get(schema);
    if (pattern != null && !pattern.test(value)) {
      return false;
    }
  }

  if (typeof value === 'number') {
    if (
      (typeof schema.minimum === 'number' && value < schema.minimum) ||
      (typeof schema.maximum === 'number' && value > schema.maximum) ||
      (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) ||
      (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum)
    ) {
      return false;
    }
    if (typeof schema.multipleOf === 'number') {
      const quotient = value / schema.multipleOf;
      if (
        Math.abs(quotient - Math.round(quotient)) >
        Number.EPSILON * Math.max(1, Math.abs(quotient))
      ) {
        return false;
      }
    }
  }

  if (Array.isArray(value)) {
    if (
      (typeof schema.minItems === 'number' && value.length < schema.minItems) ||
      (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
    ) {
      return false;
    }
    if (
      schema.uniqueItems === true &&
      new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length
    ) {
      return false;
    }
    if (
      isRecord(schema.items) &&
      !value.every((entry) => matchesJsonSchema(schema.items as Record<string, unknown>, entry))
    ) {
      return false;
    }
  }

  if (isJsonRecord(value)) {
    const keys = Object.keys(value);
    if (
      (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) ||
      (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties)
    ) {
      return false;
    }
    if (
      Array.isArray(schema.required) &&
      !schema.required.every((key) => hasOwn(value, key as string))
    ) {
      return false;
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, propertyValue] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (isRecord(propertySchema)) {
        if (!matchesJsonSchema(propertySchema, propertyValue)) {
          return false;
        }
      } else if (schema.additionalProperties === false) {
        return false;
      } else if (isRecord(schema.additionalProperties)) {
        if (!matchesJsonSchema(schema.additionalProperties, propertyValue)) {
          return false;
        }
      }
    }
  }

  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const variants = schema[keyword];
    if (!Array.isArray(variants)) {
      continue;
    }
    const matches = variants.filter(
      (variant) => isRecord(variant) && matchesJsonSchema(variant, value),
    ).length;
    if (
      (keyword === 'allOf' && matches !== variants.length) ||
      (keyword === 'anyOf' && matches === 0) ||
      (keyword === 'oneOf' && matches !== 1)
    ) {
      return false;
    }
  }
  if (isRecord(schema.not) && matchesJsonSchema(schema.not, value)) {
    return false;
  }
  return true;
}

function validateCallerArguments(
  check: (value: unknown) => boolean,
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID');
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
    if (
      serialized === undefined ||
      Buffer.byteLength(serialized, 'utf8') > MAX_ARGUMENT_BYTES ||
      !check(value)
    ) {
      throw new Error('Invalid caller function arguments');
    }
  } catch {
    throw new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID');
  }
  return value;
}

/** Builds model-visible tools that return to the API caller without server execution. */
export function createPiCallerToolDefinitions(
  definitions: readonly PiCallerToolDefinition[],
  handoff: (call: PiCallerToolCall) => void,
): PiToolDefinition[] {
  const seenNames = new Set<string>();
  return definitions.map((definition) => {
    if (
      typeof definition.name !== 'string' ||
      definition.name.length === 0 ||
      !CLIENT_TOOL_NAME_PATTERN.test(definition.name) ||
      seenNames.has(definition.name)
    ) {
      throw new PiToolCompatibilityError('PI_TOOL_UNSUPPORTED');
    }
    seenNames.add(definition.name);
    const { schema, check } = compileCallerToolSchema(definition.parameters);
    const description =
      typeof definition.description === 'string' ? definition.description : definition.name;
    const seenCalls = new Set<string>();

    return {
      name: definition.name,
      label: definition.name,
      description,
      parameters: schema,
      executionMode: 'sequential' as const,
      execute: async (toolCallId, args) => {
        if (
          typeof toolCallId !== 'string' ||
          toolCallId.length === 0 ||
          seenCalls.has(toolCallId)
        ) {
          throw new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID');
        }
        seenCalls.add(toolCallId);
        const validArguments = validateCallerArguments(check, args);
        const serializedArguments = JSON.stringify(validArguments);
        if (serializedArguments === undefined) {
          throw new PiToolCompatibilityError('PI_TOOL_ARGUMENTS_INVALID');
        }
        handoff({ callId: toolCallId, name: definition.name, arguments: serializedArguments });
        return {
          content: [{ type: 'text', text: 'Caller-owned function call handed back.' }],
          details: { status: 'completed' },
          terminate: true,
        };
      },
    };
  });
}
