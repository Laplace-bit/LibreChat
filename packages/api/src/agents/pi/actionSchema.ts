import { actionDelimiter, isActionTool } from 'librechat-data-provider';
import {
  createPiScalarToolSchema,
  isPiScalarToolSchemaFingerprint,
  normalizePiScalarToolArguments,
  PiMcpSchemaCompatibilityError,
  type PiScalarToolArguments,
  type PiScalarToolSchema,
  type PiScalarToolSchemaFingerprint,
} from './mcpSchema';

const MAX_ACTION_TOOL_NAME_LENGTH = 1_024;
const MAX_ACTION_DESCRIPTION_LENGTH = 4_096;

declare const piActionToolNameBrand: unique symbol;
export type PiActionToolName = string & { readonly [piActionToolNameBrand]: true };

export type PiActionToolArguments = PiScalarToolArguments;
export type PiActionSchemaFingerprint = PiScalarToolSchemaFingerprint;
export type PiActionToolSchema = PiScalarToolSchema;
export type PiActionToolSchemaRegistry = ReadonlyMap<PiActionToolName, PiActionToolSchema>;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** Recognizes the exact product Action name family, excluding MCP collisions. */
export function isPiActionToolName(value: unknown): value is PiActionToolName {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ACTION_TOOL_NAME_LENGTH ||
    hasControlCharacters(value) ||
    !isActionTool(value)
  ) {
    return false;
  }
  const delimiterIndex = value.indexOf(actionDelimiter);
  return delimiterIndex > 0 && delimiterIndex + actionDelimiter.length < value.length;
}

export function isPiActionSchemaFingerprint(value: unknown): value is PiActionSchemaFingerprint {
  return isPiScalarToolSchemaFingerprint(value);
}

export function normalizePiActionToolArguments(value: unknown): PiActionToolArguments {
  return normalizePiScalarToolArguments(value);
}

function definitionFingerprintInput(definition: {
  name: string;
  description?: unknown;
  oauth?: unknown;
  parameters: unknown;
}): unknown {
  const { description, oauth } = definition;
  if (
    (description !== undefined &&
      (typeof description !== 'string' || description.length > MAX_ACTION_DESCRIPTION_LENGTH)) ||
    (oauth !== undefined && typeof oauth !== 'boolean')
  ) {
    throw new PiMcpSchemaCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
  }
  return {
    name: definition.name,
    description: description ?? null,
    oauth: oauth ?? null,
    parameters: definition.parameters,
  };
}

/** Binds argument validation to the current server-built Action definition. */
export function createPiActionToolSchema(definition: {
  name: string;
  description?: unknown;
  oauth?: unknown;
  parameters: unknown;
}): PiActionToolSchema {
  if (!isPiActionToolName(definition.name)) {
    throw new PiMcpSchemaCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
  }
  return createPiScalarToolSchema(
    definition.name,
    definition.parameters,
    definitionFingerprintInput(definition),
  );
}

/** Compiles only Actions in the exact host-authorized definition snapshot. */
export function createPiActionToolSchemaRegistry(
  definitions: readonly {
    name?: unknown;
    description?: unknown;
    oauth?: unknown;
    parameters?: unknown;
  }[],
): Map<PiActionToolName, PiActionToolSchema> {
  const registry = new Map<PiActionToolName, PiActionToolSchema>();
  for (const candidate of definitions) {
    if (typeof candidate.name !== 'string' || !isPiActionToolName(candidate.name)) {
      continue;
    }
    if (candidate.parameters === undefined || registry.has(candidate.name)) {
      throw new PiMcpSchemaCompatibilityError('PI_TOOL_SCHEMA_UNSUPPORTED');
    }
    registry.set(
      candidate.name,
      createPiActionToolSchema({
        name: candidate.name,
        description: candidate.description,
        oauth: candidate.oauth,
        parameters: candidate.parameters,
      }),
    );
  }
  return registry;
}
