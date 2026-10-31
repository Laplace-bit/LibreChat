import { createHash } from 'node:crypto';
import { Constants, isActionTool, Tools } from 'librechat-data-provider';
import type { TSchema } from 'typebox';
import { PI_SUPPORTED_HOST_TOOLS } from './toolNames';

const MAX_TOOL_NAME_LENGTH = 1_024;
const MAX_TOOL_NAME_PART_LENGTH = 512;
const MAX_SCHEMA_BYTES = 64 * 1_024;
const MAX_ARGUMENT_BYTES = 64 * 1_024;
const MAX_OBJECT_PROPERTIES = 64;
const MAX_PROPERTY_NAME_LENGTH = 256;
const MAX_DESCRIPTION_LENGTH = 4_096;
const MAX_ENUM_VALUES = 128;
const MAX_STRING_BOUND = 65_536;
const MAX_JSON_DEPTH = 8;

export type PiScalarToolValue = string | number | boolean;
type PiMcpScalarType = 'string' | 'number' | 'integer' | 'boolean';
type JsonValue = null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
export type PiScalarToolArguments = Record<string, PiScalarToolValue>;
export type PiMcpToolArguments = PiScalarToolArguments;
declare const piMcpToolNameBrand: unique symbol;
export type PiMcpToolName = `${string}${typeof Constants.mcp_delimiter}${string}` & {
  readonly [piMcpToolNameBrand]: true;
};
declare const piScalarToolSchemaFingerprintBrand: unique symbol;
export type PiScalarToolSchemaFingerprint = string & {
  readonly [piScalarToolSchemaFingerprintBrand]: true;
};
export type PiMcpSchemaFingerprint = PiScalarToolSchemaFingerprint;
export type PiMcpSchemaCompatibilityCode =
  | 'PI_TOOL_SCHEMA_UNSUPPORTED'
  | 'PI_TOOL_ARGUMENTS_INVALID';

const ERROR_MESSAGES: Record<PiMcpSchemaCompatibilityCode, string> = {
  PI_TOOL_SCHEMA_UNSUPPORTED: 'This tool schema is not supported by the Pi runtime.',
  PI_TOOL_ARGUMENTS_INVALID: 'The Pi tool arguments are invalid.',
};

/** A local boundary error; the host adapter can translate it without a module cycle. */
export class PiMcpSchemaCompatibilityError extends Error {
  readonly code: PiMcpSchemaCompatibilityCode;

  constructor(code: PiMcpSchemaCompatibilityCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'PiMcpSchemaCompatibilityError';
    this.code = code;
  }
}

interface ScalarProperty {
  type: PiMcpScalarType;
  description?: string;
  enum?: readonly PiScalarToolValue[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

export interface PiScalarToolSchema {
  parameters: TSchema;
  fingerprint: PiScalarToolSchemaFingerprint;
  validateArguments(value: unknown): PiScalarToolArguments;
}

export type PiMcpToolSchema = PiScalarToolSchema;

export type PiMcpToolSchemaRegistry = ReadonlyMap<PiMcpToolName, PiMcpToolSchema>;

const STATIC_TOOL_NAMES = new Set<string>([
  ...Object.values(Tools).map(String),
  ...PI_SUPPORTED_HOST_TOOLS.map(String),
  String(Constants.mcp_all),
  String(Constants.mcp_clear),
  String(Constants.mcp_server),
]);

function fail(code: PiMcpSchemaCompatibilityCode): never {
  throw new PiMcpSchemaCompatibilityError(code);
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Recognizes a host MCP tool key without accepting product-owned static tools. */
export function isPiMcpToolName(value: unknown): value is PiMcpToolName {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TOOL_NAME_LENGTH ||
    hasControlCharacters(value) ||
    isActionTool(value) ||
    STATIC_TOOL_NAMES.has(value)
  ) {
    return false;
  }

  const delimiter = Constants.mcp_delimiter;
  const firstDelimiter = value.indexOf(delimiter);
  const lastDelimiter = value.lastIndexOf(delimiter);
  if (firstDelimiter <= 0 || lastDelimiter + delimiter.length >= value.length) {
    return false;
  }

  const rawToolName = value.slice(0, firstDelimiter);
  const serverName = value.slice(lastDelimiter + delimiter.length);
  return (
    rawToolName !== 'oauth' &&
    rawToolName !== Constants.mcp_all &&
    rawToolName !== Constants.mcp_clear &&
    rawToolName !== Constants.mcp_server &&
    rawToolName.length <= MAX_TOOL_NAME_PART_LENGTH &&
    serverName.length <= MAX_TOOL_NAME_PART_LENGTH
  );
}

export function isPiScalarToolSchemaFingerprint(
  value: unknown,
): value is PiScalarToolSchemaFingerprint {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

export function isPiMcpSchemaFingerprint(value: unknown): value is PiMcpSchemaFingerprint {
  return isPiScalarToolSchemaFingerprint(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor != null && descriptor.enumerable && 'value' in descriptor;
  });
}

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalizeJson(
  value: unknown,
  errorCode: PiMcpSchemaCompatibilityCode,
  active: Set<object> = new Set(),
  depth = 0,
  budget: { bytes: number; nodes: number; maxBytes: number } = {
    bytes: 0,
    nodes: 0,
    maxBytes: errorCode === 'PI_TOOL_SCHEMA_UNSUPPORTED' ? MAX_SCHEMA_BYTES : MAX_ARGUMENT_BYTES,
  },
): JsonValue {
  budget.nodes += 1;
  if (depth > MAX_JSON_DEPTH || budget.nodes > 2_048) {
    return fail(errorCode);
  }
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value, 'utf8');
    if (budget.bytes > budget.maxBytes) {
      return fail(errorCode);
    }
    return value;
  }
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return fail(errorCode);
    }
    return value;
  }
  if (typeof value !== 'object') {
    return fail(errorCode);
  }
  if (active.has(value)) {
    return fail(errorCode);
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_ENUM_VALUES || Reflect.ownKeys(value).length !== value.length + 1) {
        return fail(errorCode);
      }
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor == null || !descriptor.enumerable || !('value' in descriptor)) {
          return fail(errorCode);
        }
        result.push(canonicalizeJson(descriptor.value, errorCode, active, depth + 1, budget));
      }
      return result;
    }
    if (!isPlainRecord(value)) {
      return fail(errorCode);
    }

    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > MAX_OBJECT_PROPERTIES) {
      return fail(errorCode);
    }
    const entries = ownKeys
      .map((key) => {
        if (typeof key !== 'string') {
          return fail(errorCode);
        }
        budget.bytes += Buffer.byteLength(key, 'utf8');
        if (budget.bytes > budget.maxBytes) {
          return fail(errorCode);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor == null || !('value' in descriptor)) {
          return fail(errorCode);
        }
        return [key, descriptor.value] as const;
      })
      .sort(([left], [right]) => {
        if (left < right) {
          return -1;
        }
        if (left > right) {
          return 1;
        }
        return 0;
      });

    return Object.fromEntries(
      entries.map(([key, entryValue]) => [
        key,
        canonicalizeJson(entryValue, errorCode, active, depth + 1, budget),
      ]),
    );
  } finally {
    active.delete(value);
  }
}

function parseBoundaryJson(value: unknown, errorCode: PiMcpSchemaCompatibilityCode): JsonValue {
  try {
    return canonicalizeJson(value, errorCode);
  } catch (error) {
    if (error instanceof PiMcpSchemaCompatibilityError) {
      throw error;
    }
    return fail(errorCode);
  }
}

/** Validates the bounded JSON shape before the current MCP schema is reloaded. */
export function normalizePiScalarToolArguments(value: unknown): PiScalarToolArguments {
  const canonical = parseBoundaryJson(value, 'PI_TOOL_ARGUMENTS_INVALID');
  if (!isRecord(canonical)) {
    return fail('PI_TOOL_ARGUMENTS_INVALID');
  }
  const entries: Array<[string, string | number | boolean]> = [];
  for (const [key, argument] of Object.entries(canonical)) {
    if (
      key.length === 0 ||
      key.length > MAX_PROPERTY_NAME_LENGTH ||
      hasControlCharacters(key) ||
      !(
        typeof argument === 'string' ||
        typeof argument === 'boolean' ||
        (typeof argument === 'number' && Number.isFinite(argument))
      )
    ) {
      return fail('PI_TOOL_ARGUMENTS_INVALID');
    }
    entries.push([key, argument]);
  }
  return Object.fromEntries(entries);
}

export function normalizePiMcpToolArguments(value: unknown): PiMcpToolArguments {
  return normalizePiScalarToolArguments(value);
}

function hasOnlyKeys(value: Record<string, JsonValue>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validateDescription(value: JsonValue | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > MAX_DESCRIPTION_LENGTH) {
    return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
  }
  return value;
}

function isScalarForType(value: JsonValue, type: PiMcpScalarType): value is PiScalarToolValue {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
  }
}

function validateScalarProperty(value: JsonValue): ScalarProperty {
  if (!isRecord(value)) {
    return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
  }
  const type = value.type;
  if (type !== 'string' && type !== 'number' && type !== 'integer' && type !== 'boolean') {
    return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
  }

  const allowed = ['type', 'description', 'enum'];
  if (type === 'string') {
    allowed.push('minLength', 'maxLength');
  } else if (type === 'number' || type === 'integer') {
    allowed.push('minimum', 'maximum');
  }
  if (!hasOnlyKeys(value, allowed)) {
    return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
  }

  const property: ScalarProperty = { type };
  const description = validateDescription(value.description);
  if (description !== undefined) {
    property.description = description;
  }

  if (type === 'string') {
    for (const key of ['minLength', 'maxLength'] as const) {
      const bound = value[key];
      if (bound !== undefined) {
        if (
          typeof bound !== 'number' ||
          !Number.isSafeInteger(bound) ||
          bound < 0 ||
          bound > MAX_STRING_BOUND
        ) {
          return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
        }
        property[key] = bound;
      }
    }
    if (
      property.minLength !== undefined &&
      property.maxLength !== undefined &&
      property.minLength > property.maxLength
    ) {
      return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
    }
  } else if (type === 'number' || type === 'integer') {
    for (const key of ['minimum', 'maximum'] as const) {
      const bound = value[key];
      if (bound !== undefined) {
        if (
          typeof bound !== 'number' ||
          !Number.isFinite(bound) ||
          (type === 'integer' && !Number.isSafeInteger(bound))
        ) {
          return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
        }
        property[key] = bound;
      }
    }
    if (
      property.minimum !== undefined &&
      property.maximum !== undefined &&
      property.minimum > property.maximum
    ) {
      return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
    }
  }

  if (value.enum !== undefined) {
    if (
      !Array.isArray(value.enum) ||
      value.enum.length === 0 ||
      value.enum.length > MAX_ENUM_VALUES ||
      new Set(value.enum).size !== value.enum.length
    ) {
      return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
    }
    const scalarValues = value.enum.filter((entry): entry is PiScalarToolValue =>
      isScalarForType(entry, type),
    );
    if (scalarValues.length !== value.enum.length) {
      return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
    }
    property.enum = scalarValues;
    if (!property.enum.every((entry) => scalarValueIsValid(entry, property))) {
      return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
    }
  }

  return property;
}

function toTypeBoxProperty(property: ScalarProperty): TSchema {
  return {
    type: property.type,
    ...(property.description === undefined ? {} : { description: property.description }),
    ...(property.enum === undefined ? {} : { enum: [...property.enum] }),
    ...(property.minLength === undefined ? {} : { minLength: property.minLength }),
    ...(property.maxLength === undefined ? {} : { maxLength: property.maxLength }),
    ...(property.minimum === undefined ? {} : { minimum: property.minimum }),
    ...(property.maximum === undefined ? {} : { maximum: property.maximum }),
  } satisfies TSchema;
}

function scalarValueIsValid(value: unknown, property: ScalarProperty): value is PiScalarToolValue {
  let scalar: PiScalarToolValue;
  switch (property.type) {
    case 'string':
      if (typeof value !== 'string') return false;
      scalar = value;
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return false;
      scalar = value;
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return false;
      scalar = value;
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      scalar = value;
      break;
  }

  if (typeof scalar === 'string') {
    const length = Array.from(scalar).length;
    if (
      (property.minLength !== undefined && length < property.minLength) ||
      (property.maxLength !== undefined && length > property.maxLength)
    ) {
      return false;
    }
  } else if (typeof scalar === 'number') {
    if (
      (property.minimum !== undefined && scalar < property.minimum) ||
      (property.maximum !== undefined && scalar > property.maximum)
    ) {
      return false;
    }
  }

  return property.enum === undefined || property.enum.includes(scalar);
}

/** Builds a bounded flat scalar schema for one named host tool. */
export function createPiScalarToolSchema(
  name: string,
  schema: unknown,
  fingerprintValue?: unknown,
): PiScalarToolSchema {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > MAX_TOOL_NAME_LENGTH ||
    hasControlCharacters(name)
  ) {
    return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
  }

  const canonicalSchema = parseBoundaryJson(schema, 'PI_TOOL_SCHEMA_UNSUPPORTED');
  if (
    !isRecord(canonicalSchema) ||
    Buffer.byteLength(JSON.stringify(canonicalSchema), 'utf8') > MAX_SCHEMA_BYTES ||
    !hasOnlyKeys(canonicalSchema, [
      'type',
      'properties',
      'required',
      'additionalProperties',
      'description',
    ]) ||
    canonicalSchema.type !== 'object' ||
    !isRecord(canonicalSchema.properties) ||
    Object.keys(canonicalSchema.properties).length > MAX_OBJECT_PROPERTIES ||
    (canonicalSchema.additionalProperties !== undefined &&
      canonicalSchema.additionalProperties !== false)
  ) {
    return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
  }

  const properties: Record<string, ScalarProperty> = {};
  for (const [propertyName, propertyValue] of Object.entries(canonicalSchema.properties)) {
    if (
      propertyName.length === 0 ||
      propertyName.length > MAX_PROPERTY_NAME_LENGTH ||
      hasControlCharacters(propertyName)
    ) {
      return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
    }
    Object.defineProperty(properties, propertyName, {
      configurable: true,
      enumerable: true,
      value: validateScalarProperty(propertyValue),
      writable: true,
    });
  }

  let required: string[] = [];
  if (canonicalSchema.required !== undefined) {
    if (
      !Array.isArray(canonicalSchema.required) ||
      canonicalSchema.required.length > MAX_OBJECT_PROPERTIES
    ) {
      return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
    }
    const requiredNames = canonicalSchema.required.filter(
      (entry): entry is string => typeof entry === 'string',
    );
    if (
      requiredNames.length !== canonicalSchema.required.length ||
      new Set(requiredNames).size !== requiredNames.length ||
      !requiredNames.every((entry) => hasOwn(properties, entry))
    ) {
      return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
    }
    required = requiredNames;
  }

  const description = validateDescription(canonicalSchema.description);
  const parameters = {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(properties).map(([propertyName, property]) => [
        propertyName,
        toTypeBoxProperty(property),
      ]),
    ),
    ...(required.length === 0 ? {} : { required }),
    additionalProperties: false,
    ...(description === undefined ? {} : { description }),
  } satisfies TSchema;

  const fingerprintInput = JSON.stringify(
    canonicalizeJson(
      fingerprintValue === undefined ? { name, schema: canonicalSchema } : fingerprintValue,
      'PI_TOOL_SCHEMA_UNSUPPORTED',
    ),
  );
  const fingerprint = createHash('sha256').update(fingerprintInput, 'utf8').digest('hex');
  if (!isPiScalarToolSchemaFingerprint(fingerprint)) {
    return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
  }

  function validateArguments(value: unknown): PiScalarToolArguments {
    const canonicalArguments = parseBoundaryJson(value, 'PI_TOOL_ARGUMENTS_INVALID');
    if (
      !isRecord(canonicalArguments) ||
      Buffer.byteLength(JSON.stringify(canonicalArguments), 'utf8') > MAX_ARGUMENT_BYTES
    ) {
      return fail('PI_TOOL_ARGUMENTS_INVALID');
    }

    const argumentNames = Object.keys(canonicalArguments);
    if (
      argumentNames.some((argumentName) => !hasOwn(properties, argumentName)) ||
      required.some((argumentName) => !hasOwn(canonicalArguments, argumentName))
    ) {
      return fail('PI_TOOL_ARGUMENTS_INVALID');
    }

    const validatedEntries: Array<[string, PiScalarToolValue]> = [];
    for (const argumentName of argumentNames) {
      const argumentValue = canonicalArguments[argumentName];
      const property = properties[argumentName];
      if (
        argumentValue === undefined ||
        property == null ||
        !scalarValueIsValid(argumentValue, property)
      ) {
        return fail('PI_TOOL_ARGUMENTS_INVALID');
      }
      validatedEntries.push([argumentName, argumentValue]);
    }
    return Object.fromEntries(validatedEntries);
  }

  return { parameters, fingerprint, validateArguments };
}

/** Builds the same bounded schema adapter for a current host-authorized MCP definition. */
export function createPiMcpToolSchema(name: string, schema: unknown): PiMcpToolSchema {
  if (!isPiMcpToolName(name)) {
    return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
  }
  return createPiScalarToolSchema(name, schema);
}

/** Compiles the exact MCP definitions supplied by the current authorized host context. */
export function createPiMcpToolSchemaRegistry(
  definitions: readonly { name?: unknown; parameters?: unknown }[],
): Map<PiMcpToolName, PiMcpToolSchema> {
  const registry = new Map<PiMcpToolName, PiMcpToolSchema>();
  for (const definition of definitions) {
    if (typeof definition.name !== 'string' || !isPiMcpToolName(definition.name)) {
      continue;
    }
    if (definition.parameters === undefined || registry.has(definition.name)) {
      return fail('PI_TOOL_SCHEMA_UNSUPPORTED');
    }
    registry.set(definition.name, createPiMcpToolSchema(definition.name, definition.parameters));
  }
  return registry;
}
