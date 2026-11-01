import { createPiCallerToolDefinitions, type PiCallerToolCall } from './callerTools';

const callerTool = {
  name: 'open_service_page',
  description: 'Open a page in the caller application.',
  parameters: {
    type: 'object',
    properties: {
      serviceId: { type: 'string', minLength: 1 },
    },
    required: ['serviceId'],
    additionalProperties: false,
  },
} as const;

describe('createPiCallerToolDefinitions', () => {
  it('accepts required properties and returns the exact call to the API caller', async () => {
    const handoff = jest.fn<void, [PiCallerToolCall]>();
    const [tool] = createPiCallerToolDefinitions([callerTool], handoff);

    await expect(tool.execute('call-1', { serviceId: 'svc-17' })).resolves.toMatchObject({
      terminate: true,
    });
    expect(handoff).toHaveBeenCalledWith({
      callId: 'call-1',
      name: 'open_service_page',
      arguments: '{"serviceId":"svc-17"}',
    });
  });

  it('rejects arguments that omit a required property', async () => {
    const handoff = jest.fn<void, [PiCallerToolCall]>();
    const [tool] = createPiCallerToolDefinitions([callerTool], handoff);

    await expect(tool.execute('call-1', {})).rejects.toMatchObject({
      name: 'PiToolCompatibilityError',
      code: 'PI_TOOL_ARGUMENTS_INVALID',
    });
    expect(handoff).not.toHaveBeenCalled();
  });

  it('enforces caller-supplied JSON Schema patterns before handoff', async () => {
    const handoff = jest.fn<void, [PiCallerToolCall]>();
    const [tool] = createPiCallerToolDefinitions(
      [
        {
          name: 'lookup_asset',
          parameters: {
            type: 'object',
            properties: { assetId: { type: 'string', pattern: '^ASSET-[0-9]+$' } },
            required: ['assetId'],
          },
        },
      ],
      handoff,
    );

    await expect(tool.execute('call-valid', { assetId: 'ASSET-17' })).resolves.toMatchObject({
      terminate: true,
    });
    await expect(tool.execute('call-invalid', { assetId: 'asset-17' })).rejects.toMatchObject({
      code: 'PI_TOOL_ARGUMENTS_INVALID',
    });
    expect(handoff).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unknown schema keyword', { type: 'object', properties: {}, patternProperties: {} }],
    [
      'unsupported format assertion',
      { type: 'object', properties: { value: { type: 'string', format: 'email' } } },
    ],
    ['unsupported property type', { type: 'object', properties: { value: { type: 'callable' } } }],
    [
      'invalid regular expression',
      { type: 'object', properties: { value: { type: 'string', pattern: '[' } } },
    ],
    [
      'negative string bound',
      { type: 'object', properties: { value: { type: 'string', minLength: -1 } } },
    ],
    [
      'duplicate required property',
      { type: 'object', properties: { item: { type: 'string' } }, required: ['item', 'item'] },
    ],
  ])('rejects an invalid or unsupported schema (%s)', (_label, parameters) => {
    expect(() =>
      createPiCallerToolDefinitions([{ name: 'open_service_page', parameters }], () => undefined),
    ).toThrow(
      expect.objectContaining({
        name: 'PiToolCompatibilityError',
        code: 'PI_TOOL_SCHEMA_UNSUPPORTED',
      }),
    );
  });

  it('uses the Responses API caller-tool name pattern and rejects duplicates', () => {
    expect(() =>
      createPiCallerToolDefinitions([{ name: 'not a valid name' }], () => undefined),
    ).toThrow(expect.objectContaining({ code: 'PI_TOOL_UNSUPPORTED' }));

    expect(() =>
      createPiCallerToolDefinitions([{ name: 'refresh' }, { name: 'refresh' }], () => undefined),
    ).toThrow(expect.objectContaining({ code: 'PI_TOOL_UNSUPPORTED' }));
  });
});
