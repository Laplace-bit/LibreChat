import {
  createPiSubagentPlan,
  createPiSubagentToolDefinition,
  resolvePiSubagentAgent,
  resolvePiSubagentTarget,
  type PiSubagentDescriptor,
} from './subagents';
import { convertPiToolSchema, validatePiToolExecutionInput } from './tools';
import { PI_SUBAGENT_TOOL_NAME } from './toolNames';

const child = {
  id: 'agent-child',
  name: 'Analyst',
  tools: ['file_search'],
  toolDefinitions: [],
};

function root(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-root',
    name: 'Root',
    subagents: { enabled: true, allowSelf: false, agent_ids: ['agent-child'] },
    subagentAgentConfigs: [child],
    ...overrides,
  };
}

describe('Pi foreground subagent plan', () => {
  it('exposes only the initialized, explicitly authorized eager target', () => {
    const plan = createPiSubagentPlan(root());
    expect(plan?.targets.get('agent-child')).toMatchObject({
      type: 'agent-child',
      agent: { id: 'agent-child' },
      self: false,
    });
    expect(createPiSubagentToolDefinition(plan!).parameters).toMatchObject({
      properties: { subagent_type: { enum: ['agent-child'] } },
      required: ['description', 'subagent_type'],
      additionalProperties: false,
    });
    const definition = createPiSubagentToolDefinition(plan!);
    expect(definition.name).toBe(PI_SUBAGENT_TOOL_NAME);
    expect(convertPiToolSchema(definition.name, definition.parameters)).toMatchObject({
      properties: { subagent_type: { enum: ['agent-child'] } },
    });
    expect(
      validatePiToolExecutionInput(PI_SUBAGENT_TOOL_NAME, 'call', {
        subagent_type: 'agent-child',
        description: 'Inspect the issue',
      }),
    ).toMatchObject({
      name: PI_SUBAGENT_TOOL_NAME,
      args: { subagent_type: 'agent-child', description: 'Inspect the issue' },
    });
  });

  it('rejects unauthorized targets, cycles, and recursive depth', () => {
    const plan = createPiSubagentPlan(root());
    expect(() =>
      resolvePiSubagentTarget({
        plan: plan!,
        args: { subagent_type: 'agent-other', description: 'task' },
        depth: 0,
        ancestry: ['agent-root'],
      }),
    ).toThrow(/not authorized/i);
    expect(() =>
      resolvePiSubagentTarget({
        plan: plan!,
        args: { subagent_type: 'agent-child', description: 'task' },
        depth: 1,
        ancestry: ['agent-root'],
      }),
    ).toThrow(/recursion/i);
    expect(() =>
      createPiSubagentPlan(
        root({
          subagents: { enabled: true, allowSelf: false, agent_ids: ['agent-root'] },
          subagentAgentConfigs: [{ id: 'agent-root' }],
        }),
      ),
    ).toThrow(/parent/i);
    expect(() =>
      resolvePiSubagentTarget({
        plan: plan!,
        args: {
          subagent_type: 'agent-child',
          description: 'run in the background',
          background: true,
        },
        depth: 0,
        ancestry: ['agent-root'],
      }),
    ).toThrow();
  });

  it('rejects unresolved, lazy, graph, and nested child configurations', () => {
    expect(() => createPiSubagentPlan(root({ subagentAgentConfigs: [] }))).toThrow(/not loaded/i);
    expect(() => createPiSubagentPlan(root({ lazySubagentConfigs: [{ id: 'lazy' }] }))).toThrow();
    expect(() =>
      createPiSubagentPlan(root({ subagentGraphConfigs: [{ memberConfigs: [] }] })),
    ).toThrow();
    expect(() =>
      createPiSubagentPlan(
        root({
          subagentAgentConfigs: [
            {
              ...child,
              subagentAgentConfigs: [{ id: 'grandchild' }],
            },
          ],
        }),
      ),
    ).toThrow(/nested/i);
  });

  it('accepts only an authorized lazy metadata descriptor and settles its resolved config', async () => {
    const resolvedChild = { ...child, model_parameters: { model: 'gpt-4o-mini' } };
    const resolve = jest.fn().mockResolvedValue(resolvedChild);
    const settle = jest.fn((_context, resolveInputs) => resolveInputs());
    const descriptor: PiSubagentDescriptor = {
      id: child.id,
      name: child.name,
      description: 'Analyze maintenance evidence.',
      configId: 'agent-child:v3',
      resolve,
      settle,
    };
    const plan = createPiSubagentPlan(
      root({ subagentAgentConfigs: [], lazySubagentConfigs: [descriptor] }),
    );
    const target = plan!.targets.get(child.id)!;
    const context = {
      descriptor: {
        type: child.id,
        name: descriptor.name!,
        description: descriptor.description!,
        configId: descriptor.configId,
      },
      executionId: 'child-execution',
      parentRunId: 'parent-run',
      parentAgentId: 'agent-root',
      parentToolCallId: 'call-child',
      threadId: 'conversation-1',
      signal: new AbortController().signal,
      configurable: { requestBody: { conversationId: 'conversation-1' }, user_id: 'user-1' },
    };

    await expect(resolvePiSubagentAgent({ target, context })).resolves.toBe(resolvedChild);
    expect(settle).toHaveBeenCalledWith(context, expect.any(Function));
    expect(resolve).toHaveBeenCalledWith(context);
  });

  it('rejects a lazy descriptor if the resolved agent changes identity or adds nested behavior', async () => {
    const makeTarget = (resolvedAgent: Record<string, unknown>) => {
      const descriptor: PiSubagentDescriptor = {
        id: child.id,
        configId: 'agent-child:v3',
        resolve: jest.fn().mockResolvedValue(resolvedAgent),
        settle: jest.fn((_context, resolveInputs) => resolveInputs()),
      };
      const plan = createPiSubagentPlan(
        root({ subagentAgentConfigs: [], lazySubagentConfigs: [descriptor] }),
      );
      return plan!.targets.get(child.id)!;
    };
    const context = {
      descriptor: { type: child.id, name: 'Analyst', description: '', configId: 'agent-child:v3' },
      executionId: 'child-execution',
      parentRunId: 'parent-run',
      signal: new AbortController().signal,
    };

    await expect(
      resolvePiSubagentAgent({ target: makeTarget({ ...child, id: 'agent-other' }), context }),
    ).rejects.toThrow(/identity/i);
    await expect(
      resolvePiSubagentAgent({
        target: makeTarget({ ...child, subagentAgentConfigs: [{ id: 'grandchild' }] }),
        context,
      }),
    ).rejects.toThrow(/nested/i);
    await expect(
      resolvePiSubagentAgent({
        target: makeTarget({ ...child, subagentHostArgs: { workspace: { enum: ['host'] } } }),
        context,
      }),
    ).rejects.toThrow(/routing/i);
  });

  it('rejects lazy descriptors with nested targets, host arguments, or machine routes', () => {
    const makeDescriptor = (overrides: Record<string, unknown> = {}) => ({
      id: child.id,
      configId: 'agent-child:v3',
      resolve: jest.fn(),
      settle: jest.fn(),
      ...overrides,
    });
    for (const descriptor of [
      makeDescriptor({ lazySubagentConfigs: [{ id: 'grandchild' }] }),
      makeDescriptor({ subagentGraphMemberMetadata: [{ id: 'grandchild' }] }),
      makeDescriptor({ edges: [{ from: 'agent-child', to: 'grandchild' }] }),
      makeDescriptor({ subagents: { enabled: true, agent_ids: ['grandchild'] } }),
      makeDescriptor({ subagentHostArgs: { machine: { enum: ['worker'] } } }),
      makeDescriptor({ codeExecutionChoices: [{ environmentId: 'worker' }] }),
      makeDescriptor({ codeExecutionContext: { environmentId: 'worker' } }),
    ]) {
      expect(() =>
        createPiSubagentPlan(root({ subagentAgentConfigs: [], lazySubagentConfigs: [descriptor] })),
      ).toThrow();
    }
  });

  it('supports an explicitly allowed isolated self child without enabling recursion', () => {
    const plan = createPiSubagentPlan(
      root({
        subagents: { enabled: true, allowSelf: true, agent_ids: [] },
        subagentAgentConfigs: [],
      }),
    );
    expect([...plan!.targets.keys()]).toEqual(['self']);
    expect(
      resolvePiSubagentTarget({
        plan: plan!,
        args: { subagent_type: 'self', description: 'separate task' },
        depth: 0,
        ancestry: ['agent-root'],
      }).target.self,
    ).toBe(true);
  });
});
