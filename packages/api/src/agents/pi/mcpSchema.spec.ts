import { Constants, Tools } from 'librechat-data-provider';
import {
  createPiMcpToolSchema,
  isPiMcpToolName,
  PiMcpSchemaCompatibilityError,
  type PiMcpSchemaCompatibilityCode,
} from './mcpSchema';

const toolName = `lookup${Constants.mcp_delimiter}inventory`;

function caughtError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectCompatibilityError(run: () => unknown, code: PiMcpSchemaCompatibilityCode) {
  expect(caughtError(run)).toMatchObject({
    name: 'PiMcpSchemaCompatibilityError',
    code,
  });
}

describe('isPiMcpToolName', () => {
  it('recognizes host MCP names, including names whose tool or server contains the delimiter', () => {
    expect(isPiMcpToolName(toolName)).toBe(true);
    expect(
      isPiMcpToolName(`get${Constants.mcp_delimiter}mcp${Constants.mcp_delimiter}server`),
    ).toBe(true);
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'lookup',
    `${Constants.mcp_delimiter}server`,
    `lookup${Constants.mcp_delimiter}`,
    `oauth${Constants.mcp_delimiter}github`,
    `${Constants.mcp_all}${Constants.mcp_delimiter}inventory`,
    `${Constants.mcp_server}${Constants.mcp_delimiter}inventory`,
    `lookup\u0000${Constants.mcp_delimiter}server`,
    `lookup${Constants.mcp_delimiter}server\u007f`,
    `x${Constants.mcp_delimiter}${'s'.repeat(513)}`,
    'x'.repeat(1_025),
    Tools.web_search,
    Tools.file_search,
  ])('rejects a non-MCP, malformed, oversized, or static tool name (%p)', (value) => {
    expect(isPiMcpToolName(value)).toBe(false);
  });
});

describe('createPiMcpToolSchema', () => {
  const schema = {
    type: 'object',
    description: 'Inventory lookup arguments.',
    properties: {
      query: { type: 'string', minLength: 2, maxLength: 20, enum: ['ready', 'blocked'] },
      score: { type: 'number', minimum: 0, maximum: 10 },
      count: { type: 'integer', minimum: 1, maximum: 4, enum: [1, 2, 3, 4] },
      includeDetails: { type: 'boolean', enum: [true, false] },
      note: { type: 'string' },
    },
    required: ['query', 'score', 'count', 'includeDetails'],
  };

  it('creates a strict flat TypeBox-compatible schema and validates scalar arguments', () => {
    const result = createPiMcpToolSchema(toolName, schema);

    expect(result.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['query', 'score', 'count', 'includeDetails'],
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 20, enum: ['ready', 'blocked'] },
        score: { type: 'number', minimum: 0, maximum: 10 },
        count: { type: 'integer', minimum: 1, maximum: 4, enum: [1, 2, 3, 4] },
        includeDetails: { type: 'boolean', enum: [true, false] },
        note: { type: 'string' },
      },
    });
    expect(
      result.validateArguments({
        query: 'ready',
        score: 7.5,
        count: 2,
        includeDetails: false,
        note: 'line A',
      }),
    ).toEqual({
      query: 'ready',
      score: 7.5,
      count: 2,
      includeDetails: false,
      note: 'line A',
    });
    expect(
      result.validateArguments({ query: 'blocked', score: 0, count: 1, includeDetails: true }),
    ).toEqual({ query: 'blocked', score: 0, count: 1, includeDetails: true });
  });

  it('allows omitted required and additionalProperties fields while emitting a closed schema', () => {
    const result = createPiMcpToolSchema(toolName, {
      type: 'object',
      properties: { optional: { type: 'boolean' } },
    });

    expect(result.parameters).toMatchObject({ type: 'object', additionalProperties: false });
    expect(result.validateArguments({})).toEqual({});
    expect(result.validateArguments({ optional: true })).toEqual({ optional: true });
  });

  it('accepts safe special property keys without prototype mutation', () => {
    const properties = Object.fromEntries([['__proto__', { type: 'string' }]]);
    const result = createPiMcpToolSchema(toolName, {
      type: 'object',
      properties,
      required: ['__proto__'],
    });
    const args = JSON.parse('{"__proto__":"safe"}') as unknown;

    expect(result.validateArguments(args)).toEqual(JSON.parse('{"__proto__":"safe"}'));
    expect(Object.getPrototypeOf(result.validateArguments(args))).toBe(Object.prototype);
  });

  it('fingerprints the tool name and raw schema deterministically across object key order', () => {
    const left = createPiMcpToolSchema(toolName, {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1 } },
      required: ['query'],
      description: 'Search',
    });
    const reordered = createPiMcpToolSchema(toolName, {
      description: 'Search',
      required: ['query'],
      properties: { query: { minLength: 1, type: 'string' } },
      type: 'object',
    });
    const otherName = createPiMcpToolSchema(`read${Constants.mcp_delimiter}inventory`, {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1 } },
      required: ['query'],
      description: 'Search',
    });
    const changedSchema = createPiMcpToolSchema(toolName, {
      type: 'object',
      properties: { query: { type: 'string', minLength: 2 } },
      required: ['query'],
      description: 'Search',
    });

    expect(left.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(left.fingerprint).toBe(reordered.fingerprint);
    expect(left.fingerprint).not.toBe(otherName.fingerprint);
    expect(left.fingerprint).not.toBe(changedSchema.fingerprint);
  });

  it.each([
    ['not an object', { type: 'array', properties: {} }],
    ['missing object type', { properties: {} }],
    ['unknown keyword', { type: 'object', properties: {}, patternProperties: {} }],
    [
      'additional properties enabled',
      { type: 'object', properties: {}, additionalProperties: true },
    ],
    [
      'nested object',
      { type: 'object', properties: { filters: { type: 'object', properties: {} } } },
    ],
    [
      'array field',
      { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } } },
    ],
    ['union field', { type: 'object', properties: { value: { type: ['string', 'null'] } } }],
    ['reference field', { type: 'object', properties: { value: { $ref: '#/definitions/value' } } }],
    ['missing scalar type', { type: 'object', properties: { value: { description: 'No type' } } }],
    [
      'unknown property keyword',
      { type: 'object', properties: { value: { type: 'string', pattern: 'x' } } },
    ],
    [
      'non-scalar enum',
      { type: 'object', properties: { value: { type: 'string', enum: ['x', 1] } } },
    ],
    ['empty enum', { type: 'object', properties: { value: { type: 'boolean', enum: [] } } }],
    [
      'duplicate enum values',
      { type: 'object', properties: { value: { type: 'integer', enum: [1, 1] } } },
    ],
    [
      'invalid string bound',
      { type: 'object', properties: { value: { type: 'string', minLength: -1 } } },
    ],
    [
      'reversed string bounds',
      { type: 'object', properties: { value: { type: 'string', minLength: 5, maxLength: 2 } } },
    ],
    [
      'invalid numeric bound',
      { type: 'object', properties: { value: { type: 'number', minimum: Infinity } } },
    ],
    [
      'reversed numeric bounds',
      { type: 'object', properties: { value: { type: 'number', minimum: 5, maximum: 2 } } },
    ],
    [
      'non-integer integer bound',
      { type: 'object', properties: { value: { type: 'integer', minimum: 1.5 } } },
    ],
    ['required unknown property', { type: 'object', properties: {}, required: ['missing'] }],
    [
      'duplicate required property',
      { type: 'object', properties: { value: { type: 'string' } }, required: ['value', 'value'] },
    ],
    ['invalid MCP tool name', { type: 'object', properties: {} }, 'static_tool'],
  ])('rejects unsupported or malformed schema: %s', (_label, candidate, name = toolName) => {
    expect.hasAssertions();
    expectCompatibilityError(
      () => createPiMcpToolSchema(name as string, candidate),
      'PI_TOOL_SCHEMA_UNSUPPORTED',
    );
  });

  it('rejects cyclic, accessor-backed, and oversized definitions at the boundary', () => {
    expect.hasAssertions();
    const cyclic: Record<string, unknown> = { type: 'object', properties: {} };
    cyclic.self = cyclic;
    const accessorBacked = {
      type: 'object',
      get properties() {
        return {};
      },
    };
    const oversized = {
      type: 'object',
      properties: {},
      unexpected: 'x'.repeat(64 * 1_024),
    };
    const tooManyProperties = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [`field${index}`, { type: 'string' }]),
      ),
    };
    const hostileProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('hostile proxy trap');
        },
      },
    );

    for (const candidate of [cyclic, accessorBacked, oversized, tooManyProperties, hostileProxy]) {
      expectCompatibilityError(
        () => createPiMcpToolSchema(toolName, candidate),
        'PI_TOOL_SCHEMA_UNSUPPORTED',
      );
    }
  });

  it.each([
    ['null', null],
    ['array', []],
    ['missing required value', { query: 'ready', score: 5, count: 1 }],
    ['unknown key', { query: 'ready', score: 5, count: 1, includeDetails: true, extra: 'x' }],
    ['wrong string type', { query: 1, score: 5, count: 1, includeDetails: true }],
    ['string below minLength', { query: 'x', score: 5, count: 1, includeDetails: true }],
    ['string outside enum', { query: 'unknown', score: 5, count: 1, includeDetails: true }],
    ['number outside bounds', { query: 'ready', score: 11, count: 1, includeDetails: true }],
    ['non-finite number', { query: 'ready', score: NaN, count: 1, includeDetails: true }],
    ['fractional integer', { query: 'ready', score: 5, count: 1.5, includeDetails: true }],
    ['integer outside enum', { query: 'ready', score: 5, count: 5, includeDetails: true }],
    ['wrong boolean type', { query: 'ready', score: 5, count: 1, includeDetails: 'true' }],
    [
      'oversized string argument',
      { query: 'x'.repeat(64 * 1_024), score: 5, count: 1, includeDetails: true },
    ],
  ])('rejects malformed arguments: %s', (_label, value) => {
    expect.hasAssertions();
    const result = createPiMcpToolSchema(toolName, schema);
    expectCompatibilityError(() => result.validateArguments(value), 'PI_TOOL_ARGUMENTS_INVALID');
  });

  it('rejects non-JSON argument objects instead of reading accessors or inherited fields', () => {
    expect.hasAssertions();
    const result = createPiMcpToolSchema(toolName, {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
    const accessorArgs = Object.defineProperty({}, 'query', {
      enumerable: true,
      get: () => 'ready',
    });
    const inheritedArgs = Object.create({ query: 'ready' }) as unknown;
    const hostileProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('hostile proxy trap');
        },
      },
    );

    expectCompatibilityError(
      () => result.validateArguments(accessorArgs),
      'PI_TOOL_ARGUMENTS_INVALID',
    );
    expectCompatibilityError(
      () => result.validateArguments(inheritedArgs),
      'PI_TOOL_ARGUMENTS_INVALID',
    );
    expectCompatibilityError(
      () => result.validateArguments(hostileProxy),
      'PI_TOOL_ARGUMENTS_INVALID',
    );
  });

  it('exposes a stable typed boundary error', () => {
    const error = caughtError(() => createPiMcpToolSchema('static_tool', schema));
    expect(error).toBeInstanceOf(PiMcpSchemaCompatibilityError);
    expect(error).toMatchObject({ code: 'PI_TOOL_SCHEMA_UNSUPPORTED' });
  });
});
