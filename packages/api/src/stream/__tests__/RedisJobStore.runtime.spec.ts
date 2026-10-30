import type { SerializableJobData } from '~/stream/interfaces/IJobStore';
import {
  LEGACY_AGENT_RUNTIME,
  PINNED_PI_AGENT_RUNTIME,
  resolveStoredAgentRuntime,
} from '~/agents/runtime/selection';
import { RedisJobStore } from '../implementations/RedisJobStore';

type JobSerializer = (job: Partial<SerializableJobData>) => Record<string, string>;
type JobDeserializer = (data: Record<string, string>) => SerializableJobData;
type JobUpdater = (this: RedisJobStore, streamId: string, updates: unknown) => Promise<void>;
type StatusTransition = (this: RedisJobStore, streamId: string, args: unknown) => Promise<boolean>;

describe('RedisJobStore runtime identity persistence', () => {
  const store = Object.create(RedisJobStore.prototype) as RedisJobStore;
  Reflect.set(store, 'scheduleMembershipRevisions', new WeakMap<SerializableJobData, string>());
  const serializeJob = Reflect.get(store, 'serializeJob') as JobSerializer;
  const deserializeJob = Reflect.get(store, 'deserializeJob') as JobDeserializer;
  const updateJob = Reflect.get(store, 'updateJob') as JobUpdater;
  const transitionStatus = Reflect.get(store, 'transitionStatus') as StatusTransition;
  const readJob = (data: Record<string, string>) => deserializeJob.call(store, data);

  const job = (agentRuntime?: unknown): Partial<SerializableJobData> => ({
    streamId: 'stream-1',
    userId: 'user-1',
    status: 'requires_action',
    createdAt: 1000,
    syncSent: false,
    ...(agentRuntime !== undefined && { agentRuntime }),
  });

  it('round-trips legacy and pinned Pi identities without changing old jobs', () => {
    const legacy = readJob(serializeJob(job(LEGACY_AGENT_RUNTIME)));
    const pi = readJob(serializeJob(job(PINNED_PI_AGENT_RUNTIME)));
    const oldJobHash = serializeJob(job());
    delete oldJobHash.agentRuntime;
    const oldJob = readJob(oldJobHash);

    expect(legacy.agentRuntime).toEqual(LEGACY_AGENT_RUNTIME);
    expect(pi.agentRuntime).toEqual(PINNED_PI_AGENT_RUNTIME);
    expect(oldJob.agentRuntime).toBeUndefined();
    expect(resolveStoredAgentRuntime(oldJob.agentRuntime)).toEqual({
      status: 'resolved',
      selection: LEGACY_AGENT_RUNTIME,
    });
  });

  it('preserves future or malformed identities so the resolver fails closed', () => {
    const future = readJob(serializeJob(job({ engine: 'pi', sdkVersion: '99.0.0' })));
    const malformed = readJob({
      ...serializeJob(job()),
      agentRuntime: '{not-json',
    });

    expect(resolveStoredAgentRuntime(future.agentRuntime)).toEqual({ status: 'unsupported' });
    expect(malformed.agentRuntime).toBe('{not-json');
    expect(resolveStoredAgentRuntime(malformed.agentRuntime)).toEqual({ status: 'unsupported' });
  });

  it('rejects runtime identity changes before attempting a Redis write', async () => {
    await expect(
      updateJob.call(store, 'stream-1', { agentRuntime: LEGACY_AGENT_RUNTIME }),
    ).rejects.toThrow('Generation runtime identity is immutable');
    await expect(
      updateJob.call(store, 'stream-1', {
        patch: {},
        agentRuntime: LEGACY_AGENT_RUNTIME,
      }),
    ).rejects.toThrow('Generation runtime identity is immutable');
    await expect(
      transitionStatus.call(store, 'stream-1', {
        from: 'requires_action',
        to: 'running',
        patch: { agentRuntime: LEGACY_AGENT_RUNTIME },
      }),
    ).rejects.toThrow('Generation runtime identity is immutable');
    await expect(
      transitionStatus.call(store, 'stream-1', {
        from: 'requires_action',
        to: 'running',
        patch: { patch: {}, agentRuntime: LEGACY_AGENT_RUNTIME },
      }),
    ).rejects.toThrow('Generation runtime identity is immutable');
    await expect(
      transitionStatus.call(store, 'stream-1', {
        from: 'requires_action',
        to: 'running',
        patch: { clear: [] },
        clear: ['agentRuntime'],
      }),
    ).rejects.toThrow('Generation runtime identity is immutable');
    await expect(
      transitionStatus.call(store, 'stream-1', {
        from: 'requires_action',
        to: 'running',
        clear: ['agentRuntime'],
      }),
    ).rejects.toThrow('Generation runtime identity is immutable');
  });
});
