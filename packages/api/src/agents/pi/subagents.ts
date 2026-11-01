import type { LCTool, SubagentResolveContext } from '@librechat/agents';
import { validatePiSubagentArguments, type PiSubagentArguments } from './tools';
import { PI_SUBAGENT_TOOL_NAME } from './toolNames';

export const PI_MAX_NESTED_SUBAGENT_DEPTH = 1;

export interface PiSubagentAgent {
  readonly id: string;
  readonly name?: string | null;
  readonly description?: string | null;
  readonly toolDefinitions?: readonly unknown[];
  readonly edges?: readonly unknown[];
  readonly subagents?: {
    readonly enabled?: boolean;
    readonly allowSelf?: boolean;
    readonly agent_ids?: readonly unknown[];
  } | null;
  readonly subagentAgentConfigs?:
    | readonly (PiSubagentAgent | null | undefined)[]
    | Map<unknown, PiSubagentAgent>;
  readonly lazySubagentConfigs?: readonly (PiSubagentDescriptor | null | undefined)[] | null;
  readonly subagentGraphConfigs?: readonly unknown[] | null;
  readonly subagentGraphMemberMetadata?: readonly unknown[] | null;
}

export interface PiSubagentDescriptor extends PiSubagentAgent {
  readonly configId: string;
  readonly resolve: (context: SubagentResolveContext) => Promise<PiSubagentAgent>;
  readonly settle: <T>(
    context: SubagentResolveContext,
    resolveInputs: () => Promise<T>,
  ) => Promise<T>;
  readonly subagentHostArgs?: Readonly<Record<string, unknown>>;
  readonly codeExecutionChoices?: readonly unknown[] | null;
  readonly codeExecutionContext?: {
    readonly environmentId?: unknown;
    readonly environmentType?: unknown;
    readonly codeWorkspace?: unknown;
  } | null;
  readonly statefulCodeEnvironment?: unknown;
}

export interface PiSubagentTarget {
  readonly type: string;
  readonly agent: PiSubagentAgent;
  readonly descriptor?: PiSubagentDescriptor;
  readonly self: boolean;
}

export interface PiSubagentPlan {
  readonly parentAgentId: string;
  readonly targets: ReadonlyMap<string, PiSubagentTarget>;
}

export class PiSubagentCompatibilityError extends Error {
  readonly code = 'PI_SUBAGENT_UNSUPPORTED';

  constructor(message = 'The configured subagent mode is not supported by the Pi runtime.') {
    super(message);
    this.name = 'PiSubagentCompatibilityError';
  }
}

function configuredChildren(agent: PiSubagentAgent): PiSubagentAgent[] {
  const configured = agent.subagentAgentConfigs;
  if (configured != null && !Array.isArray(configured) && !(configured instanceof Map)) {
    throw new PiSubagentCompatibilityError();
  }
  const values = configured instanceof Map ? [...configured.values()] : (configured ?? []);
  if (values.some((child) => child == null)) {
    throw new PiSubagentCompatibilityError();
  }
  return values.filter((child): child is PiSubagentAgent => child != null);
}

function configuredChildCount(agent: PiSubagentAgent): number {
  const configured = agent.subagentAgentConfigs;
  return configured instanceof Map ? configured.size : (configured?.length ?? 0);
}

function configuredLazyDescriptors(agent: PiSubagentAgent): PiSubagentDescriptor[] {
  const configured = agent.lazySubagentConfigs;
  if (
    configured == null ||
    !Array.isArray(configured) ||
    configured.some((descriptor) => descriptor == null)
  ) {
    if (configured == null) {
      return [];
    }
    throw new PiSubagentCompatibilityError('A lazy subagent descriptor is not valid.');
  }
  return configured.filter((descriptor): descriptor is PiSubagentDescriptor => descriptor != null);
}

function hasMachineRoutingTarget(agent: PiSubagentAgent): boolean {
  const descriptor = agent as PiSubagentDescriptor;
  const hostArgs = descriptor.subagentHostArgs;
  return (
    (hostArgs != null && Object.keys(hostArgs).length > 0) ||
    (descriptor.codeExecutionChoices?.length ?? 0) > 0 ||
    descriptor.codeExecutionContext?.environmentId != null ||
    descriptor.codeExecutionContext?.environmentType != null ||
    descriptor.codeExecutionContext?.codeWorkspace != null ||
    (descriptor.statefulCodeEnvironment != null && descriptor.statefulCodeEnvironment !== false)
  );
}

function hasUnsupportedNestedConfig(agent: PiSubagentAgent): boolean {
  return (
    configuredChildCount(agent) > 0 ||
    (agent.lazySubagentConfigs?.length ?? 0) > 0 ||
    (agent.subagentGraphConfigs?.length ?? 0) > 0 ||
    (agent.subagentGraphMemberMetadata?.length ?? 0) > 0 ||
    (agent.edges?.length ?? 0) > 0 ||
    agent.subagents?.enabled === true
  );
}

function assertPiSubagentAgentCompatible(agent: PiSubagentAgent, expectedId: string): void {
  if (agent.id !== expectedId) {
    throw new PiSubagentCompatibilityError(
      'The resolved subagent identity did not match its descriptor.',
    );
  }
  if (hasUnsupportedNestedConfig(agent) || hasMachineRoutingTarget(agent)) {
    throw new PiSubagentCompatibilityError(
      'Nested agents and per-call machine routing are not supported by Pi yet.',
    );
  }
}

/** Build only from server-initialized targets explicitly authorized by the root agent. */
export function createPiSubagentPlan(agent: PiSubagentAgent): PiSubagentPlan | undefined {
  if (!agent || typeof agent.id !== 'string' || agent.id.length === 0) {
    throw new PiSubagentCompatibilityError();
  }
  if (agent.subagents?.enabled !== true) {
    return undefined;
  }
  if ((agent.subagentGraphConfigs?.length ?? 0) > 0) {
    throw new PiSubagentCompatibilityError();
  }

  const children = configuredChildren(agent);
  const descriptors = configuredLazyDescriptors(agent);
  const allowedIds = agent.subagents.agent_ids ?? [];
  const isAuthorizedId = (id: unknown): id is string => typeof id === 'string' && id.length > 0;
  if (!Array.isArray(allowedIds) || !allowedIds.every(isAuthorizedId)) {
    throw new PiSubagentCompatibilityError();
  }
  if (new Set(allowedIds).size !== allowedIds.length) {
    throw new PiSubagentCompatibilityError('Subagent authorization contains duplicate target IDs.');
  }

  const targetsById = new Map<string, PiSubagentTarget>();
  for (const child of children) {
    if (typeof child.id !== 'string' || child.id.length === 0 || targetsById.has(child.id)) {
      throw new PiSubagentCompatibilityError('Subagent targets must have unique initialized IDs.');
    }
    if (hasUnsupportedNestedConfig(child) || hasMachineRoutingTarget(child)) {
      throw new PiSubagentCompatibilityError(
        'Nested agents and per-call machine routing are not supported by Pi yet.',
      );
    }
    targetsById.set(child.id, { type: child.id, agent: child, self: false });
  }
  for (const descriptor of descriptors) {
    if (
      typeof descriptor.id !== 'string' ||
      descriptor.id.length === 0 ||
      typeof descriptor.configId !== 'string' ||
      descriptor.configId.length === 0 ||
      typeof descriptor.resolve !== 'function' ||
      typeof descriptor.settle !== 'function' ||
      targetsById.has(descriptor.id)
    ) {
      throw new PiSubagentCompatibilityError('A lazy subagent descriptor is not valid.');
    }
    if (hasUnsupportedNestedConfig(descriptor) || hasMachineRoutingTarget(descriptor)) {
      throw new PiSubagentCompatibilityError(
        'Nested agents and per-call machine routing are not supported by Pi yet.',
      );
    }
    targetsById.set(descriptor.id, {
      type: descriptor.id,
      agent: descriptor,
      descriptor,
      self: false,
    });
  }
  if (targetsById.size !== allowedIds.length || allowedIds.some((id) => !targetsById.has(id))) {
    throw new PiSubagentCompatibilityError('A configured subagent is not loaded and authorized.');
  }

  const targets = new Map<string, PiSubagentTarget>();
  if (agent.subagents.allowSelf !== false) {
    targets.set('self', { type: 'self', agent, self: true });
  }
  for (const id of allowedIds.filter(isAuthorizedId)) {
    if (id === agent.id) {
      throw new PiSubagentCompatibilityError(
        'A direct subagent target cannot reference its parent.',
      );
    }
    const target = targetsById.get(id);
    if (!target) {
      throw new PiSubagentCompatibilityError('A configured subagent is not loaded and authorized.');
    }
    targets.set(id, target);
  }
  return targets.size === 0 ? undefined : { parentAgentId: agent.id, targets };
}

/** The generated schema carries the exact current authorization set into Pi. */
export function createPiSubagentToolDefinition(plan: PiSubagentPlan): LCTool {
  if (plan.targets.size === 0) {
    throw new PiSubagentCompatibilityError();
  }
  const targets = [...plan.targets.values()];
  return {
    name: PI_SUBAGENT_TOOL_NAME,
    description: 'Delegate a focused task to one of the currently authorized agents.',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'The focused task for the child agent to complete.',
        },
        subagent_type: {
          type: 'string',
          enum: targets.map(({ type }) => type),
          description: targets
            .map(({ type, agent }) => `${type}: ${agent.name ?? agent.id}`)
            .join('; '),
        },
      },
      required: ['description', 'subagent_type'],
      additionalProperties: false,
    },
  } as LCTool;
}

export function resolvePiSubagentTarget(input: {
  plan: PiSubagentPlan;
  args: unknown;
  depth: number;
  ancestry: readonly string[];
}): { target: PiSubagentTarget; args: PiSubagentArguments } {
  const args = validatePiSubagentArguments(input.args);
  const target = input.plan.targets.get(args.subagent_type);
  if (
    target == null ||
    input.depth >= PI_MAX_NESTED_SUBAGENT_DEPTH ||
    (target.self
      ? input.depth !== 0 || input.plan.parentAgentId !== target.agent.id
      : input.ancestry.includes(target.agent.id))
  ) {
    throw new PiSubagentCompatibilityError(
      target == null
        ? 'The requested subagent is not authorized.'
        : 'Subagent recursion is not supported.',
    );
  }
  return { target, args };
}

/** Resolve one server-validated lazy descriptor inside its host settlement scope. */
export async function resolvePiSubagentAgent(input: {
  target: PiSubagentTarget;
  context: SubagentResolveContext;
}): Promise<PiSubagentAgent> {
  const { target, context } = input;
  if (target.descriptor == null) {
    assertPiSubagentAgentCompatible(target.agent, target.type);
    return target.agent;
  }

  const descriptor = target.descriptor;
  const agent = await descriptor.settle(context, () => descriptor.resolve(context));
  if (agent == null || typeof agent !== 'object') {
    throw new PiSubagentCompatibilityError('The subagent descriptor did not resolve an agent.');
  }
  assertPiSubagentAgentCompatible(agent, target.type);
  return agent;
}
