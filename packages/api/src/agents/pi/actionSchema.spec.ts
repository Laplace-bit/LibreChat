import { actionDelimiter, Constants } from 'librechat-data-provider';
import {
  createPiActionToolSchema,
  createPiActionToolSchemaRegistry,
  isPiActionToolName,
} from './actionSchema';
import { isPiMcpToolName } from './mcpSchema';

const actionName = `get_inventory${actionDelimiter}api---example---com`;

function flatSchema() {
  return {
    type: 'object',
    description: 'Inventory query.',
    properties: {
      query: { type: 'string', minLength: 2, maxLength: 40, enum: ['pump', 'valve'] },
      page: { type: 'integer', minimum: 1, maximum: 10 },
      includeInactive: { type: 'boolean' },
    },
    required: ['query'],
  };
}

describe('Pi OpenAPI Action schema', () => {
  it('recognizes Action names and rejects MCP delimiter collisions and malformed names', () => {
    expect(isPiActionToolName(actionName)).toBe(true);
    const operationIdWithMcpMarker = `get_mcp_inventory${actionDelimiter}api---example---com`;
    expect(isPiActionToolName(operationIdWithMcpMarker)).toBe(true);
    expect(isPiMcpToolName(operationIdWithMcpMarker)).toBe(false);
    expect(isPiActionToolName(`read_action${Constants.mcp_delimiter}server`)).toBe(false);
    expect(isPiActionToolName(`x${actionDelimiter}y\u0000z`)).toBe(false);
    expect(isPiActionToolName(`x${actionDelimiter}${'d'.repeat(1_020)}`)).toBe(false);
  });

  it('strictly validates supported scalar arguments and emits a closed TypeBox schema', () => {
    const schema = createPiActionToolSchema({ name: actionName, parameters: flatSchema() });

    expect(schema.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 40, enum: ['pump', 'valve'] },
        page: { type: 'integer', minimum: 1, maximum: 10 },
        includeInactive: { type: 'boolean' },
      },
    });
    expect(schema.validateArguments({ query: 'pump', page: 3, includeInactive: false })).toEqual({
      query: 'pump',
      page: 3,
      includeInactive: false,
    });
    expect(() => schema.validateArguments({ query: 'p', extra: true })).toThrow(
      expect.objectContaining({ code: 'PI_TOOL_ARGUMENTS_INVALID' }),
    );
    expect(() => schema.validateArguments({ query: 'valve', page: 11 })).toThrow(
      expect.objectContaining({ code: 'PI_TOOL_ARGUMENTS_INVALID' }),
    );
  });

  it('canonicalizes object key order and binds approvals to current Action identity', () => {
    const schema = flatSchema();
    const reordered = {
      required: ['query'],
      description: 'Inventory query.',
      properties: {
        includeInactive: { type: 'boolean' },
        page: { maximum: 10, minimum: 1, type: 'integer' },
        query: { enum: ['pump', 'valve'], maxLength: 40, minLength: 2, type: 'string' },
      },
      type: 'object',
    };
    const original = createPiActionToolSchema({
      name: actionName,
      description: 'List inventory',
      oauth: false,
      parameters: schema,
    });
    const sameDefinition = createPiActionToolSchema({
      name: actionName,
      oauth: false,
      parameters: reordered,
      description: 'List inventory',
    });
    const changedSchema = createPiActionToolSchema({
      name: actionName,
      description: 'List inventory',
      oauth: false,
      parameters: { ...schema, required: ['query', 'page'] },
    });
    const changedDescription = createPiActionToolSchema({
      name: actionName,
      description: 'Delete inventory',
      oauth: false,
      parameters: schema,
    });
    const changedAuth = createPiActionToolSchema({
      name: actionName,
      description: 'List inventory',
      oauth: true,
      parameters: schema,
    });

    expect(original.fingerprint).toBe(sameDefinition.fingerprint);
    expect(original.fingerprint).not.toBe(changedSchema.fingerprint);
    expect(original.fingerprint).not.toBe(changedDescription.fingerprint);
    expect(original.fingerprint).not.toBe(changedAuth.fingerprint);
  });

  it('rejects nested, array, nullable, reference, pattern, and unknown JSON Schema structures', () => {
    const unsupportedProperties = [
      { type: 'object', properties: { nested: { type: 'object', properties: {} } } },
      { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } } },
      { type: 'object', properties: { value: { type: ['string', 'null'] } } },
      { type: 'object', properties: { value: { $ref: '#/components/schemas/Value' } } },
      { type: 'object', properties: { value: { type: 'string', pattern: '^a' } } },
      { type: 'object', properties: { value: { type: 'string', default: 'a' } } },
      { type: 'object', properties: { value: { type: 'string', format: 'date-time' } } },
      { type: 'object', properties: {}, additionalProperties: true },
      { type: 'object', properties: {}, anyOf: [{ type: 'object' }] },
    ];

    for (const parameters of unsupportedProperties) {
      expect(() => createPiActionToolSchema({ name: actionName, parameters })).toThrow(
        expect.objectContaining({ code: 'PI_TOOL_SCHEMA_UNSUPPORTED' }),
      );
    }
  });

  it('enforces property, enum, description, and schema size limits', () => {
    const tooManyProperties = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [`field${index}`, { type: 'string' }]),
      ),
    };
    const tooManyEnumValues = {
      type: 'object',
      properties: {
        value: { type: 'string', enum: Array.from({ length: 129 }, (_, index) => `v${index}`) },
      },
    };
    const enumOutsideDeclaredBound = {
      type: 'object',
      properties: { value: { type: 'string', maxLength: 2, enum: ['long'] } },
    };
    const tooLongDescription = {
      type: 'object',
      description: 'd'.repeat(4_097),
      properties: {},
    };
    const oversized = {
      type: 'object',
      properties: { value: { type: 'string', description: 'x'.repeat(64 * 1_024) } },
    };

    for (const parameters of [
      tooManyProperties,
      tooManyEnumValues,
      enumOutsideDeclaredBound,
      tooLongDescription,
      oversized,
    ]) {
      expect(() => createPiActionToolSchema({ name: actionName, parameters })).toThrow(
        expect.objectContaining({ code: 'PI_TOOL_SCHEMA_UNSUPPORTED' }),
      );
    }
  });

  it('compiles only current Action definitions and rejects duplicates or missing schemas', () => {
    const registry = createPiActionToolSchemaRegistry([
      { name: actionName, description: 'List inventory', oauth: false, parameters: flatSchema() },
      { name: `lookup${Constants.mcp_delimiter}inventory`, parameters: flatSchema() },
    ]);
    expect(registry.size).toBe(1);
    expect([...registry.values()]).toHaveLength(1);
    expect(() =>
      createPiActionToolSchemaRegistry([
        { name: actionName, parameters: flatSchema() },
        { name: actionName, parameters: flatSchema() },
      ]),
    ).toThrow(expect.objectContaining({ code: 'PI_TOOL_SCHEMA_UNSUPPORTED' }));
    expect(() => createPiActionToolSchemaRegistry([{ name: actionName }])).toThrow(
      expect.objectContaining({ code: 'PI_TOOL_SCHEMA_UNSUPPORTED' }),
    );
  });
});
