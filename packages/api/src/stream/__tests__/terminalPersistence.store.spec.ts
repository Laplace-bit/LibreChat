import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { PI_PROVIDER_OWNER_LOST_ERROR } from '../interfaces/IJobStore';
import { PINNED_PI_AGENT_RUNTIME } from '~/agents/runtime/selection';

describe('InMemoryJobStore terminal persistence leases', () => {
  let store: InMemoryJobStore;
  let nextStreamId: number;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    nextStreamId = 0;
    store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
  });

  afterEach(async () => {
    await store.destroy();
    jest.useRealTimers();
  });

  async function createPendingJob(
    options: {
      ownerToken?: string;
      leaseMs?: number;
      startedAt?: number;
    } = {},
  ) {
    const streamId = `terminal-persistence-${nextStreamId++}`;
    const job = await store.createJob(streamId, 'user-1', streamId);
    const completedAt = Date.now();
    const transitioned = await store.transitionStatusAndDrainSteers(streamId, {
      from: 'running',
      to: 'error',
      expectCreatedAt: job.createdAt,
      ...(options.leaseMs != null && { terminalPersistenceLeaseMs: options.leaseMs }),
      patch: {
        completedAt,
        terminalPersistencePending: true,
        terminalPersistenceStartedAt: options.startedAt ?? completedAt,
        ...(options.ownerToken != null && {
          terminalPersistenceOwnerToken: options.ownerToken,
        }),
      },
    });
    expect(transitioned).not.toBeNull();
    return { streamId, job };
  }

  it('writes and renews the owner lease using the store clock', async () => {
    const { streamId, job } = await createPendingJob({ ownerToken: 'owner-a', leaseMs: 5_000 });

    await expect(store.getJob(streamId)).resolves.toMatchObject({
      terminalPersistenceOwnerToken: 'owner-a',
      terminalPersistenceLeaseExpiresAt: 1_005_000,
    });
    await expect(
      store.renewTerminalPersistenceLease(streamId, job.createdAt, 'owner-a', 10_000),
    ).resolves.toBe(true);
    await expect(store.getJob(streamId)).resolves.toMatchObject({
      terminalPersistenceLeaseExpiresAt: 1_010_000,
    });
    await expect(
      store.recoverExpiredTerminalPersistence(
        streamId,
        job.createdAt,
        '{"reconcile":true}',
        `terminal:${job.createdAt}`,
        30_000,
      ),
    ).resolves.toBe(false);
  });

  it('lets expiry recovery win once and fences a late owner finalize', async () => {
    const { streamId, job } = await createPendingJob({ ownerToken: 'owner-a', leaseMs: 1_000 });
    jest.setSystemTime(1_001_000);

    await expect(
      store.recoverExpiredTerminalPersistence(
        streamId,
        job.createdAt,
        '{"event":"reconcile"}',
        `terminal:${job.createdAt}`,
        30_000,
      ),
    ).resolves.toBe(true);
    await expect(store.getJob(streamId)).resolves.toMatchObject({
      terminalPersistencePending: false,
      finalEvent: '{"event":"reconcile"}',
      terminalPublicationId: `terminal:${job.createdAt}`,
    });
    const recovered = await store.getJob(streamId);
    expect(recovered?.terminalPersistenceOwnerToken).toBeUndefined();
    expect(recovered?.terminalPersistenceLeaseExpiresAt).toBeUndefined();

    await expect(
      store.finalizeTerminalPersistence(
        streamId,
        job.createdAt,
        '{"event":"normal"}',
        undefined,
        `terminal:${job.createdAt}`,
        'owner-a',
      ),
    ).resolves.toBe(false);
    await expect(
      store.recoverExpiredTerminalPersistence(
        streamId,
        job.createdAt,
        '{"event":"second-reconcile"}',
        `terminal:${job.createdAt}`,
        30_000,
      ),
    ).resolves.toBe(false);
  });

  it('keeps tokenless history on the startedAt fallback and allows legacy finalization', async () => {
    const { streamId, job } = await createPendingJob({ startedAt: Date.now() - 31_000 });

    await expect(
      store.recoverExpiredTerminalPersistence(
        streamId,
        job.createdAt,
        '{"event":"legacy-reconcile"}',
        `terminal:${job.createdAt}`,
        30_000,
      ),
    ).resolves.toBe(true);

    const { streamId: freshStreamId, job: freshJob } = await createPendingJob();
    await expect(
      store.recoverExpiredTerminalPersistence(
        freshStreamId,
        freshJob.createdAt,
        '{"event":"too-early"}',
        `terminal:${freshJob.createdAt}`,
        30_000,
      ),
    ).resolves.toBe(false);
    await expect(
      store.finalizeTerminalPersistence(
        freshStreamId,
        freshJob.createdAt,
        '{"event":"legacy-owner"}',
      ),
    ).resolves.toBe(true);
  });

  it('finalizes a confirmed Pi owner-loss recovery without waiting for the generic timeout', async () => {
    const streamId = `pi-owner-loss-${nextStreamId++}`;
    const job = await store.createJob(streamId, 'user-1', streamId, undefined, {
      agentRuntime: PINNED_PI_AGENT_RUNTIME,
      providerExecutionId: 'pi-execution-1',
    });
    const owner = await store.acquirePiProviderOwner(
      streamId,
      job.createdAt,
      'pi-execution-1',
      'pi-owner-1',
      1_000,
    );
    expect(owner).not.toBe(false);
    if (owner === false) return;

    jest.setSystemTime(Date.now() + 1_001);
    await expect(store.claimExpiredPiProviderOwner(owner)).resolves.toBe(true);
    await expect(
      store.recoverExpiredTerminalPersistence(
        streamId,
        job.createdAt,
        '{"event":"owner-lost-reconcile"}',
        `terminal:${job.createdAt}`,
        30_000,
      ),
    ).resolves.toBe(true);

    await expect(store.getJob(streamId)).resolves.toMatchObject({
      status: 'error',
      providerRecoveryId: `pi-owner-lost:${job.createdAt}:${owner.fence}`,
      providerRecoveryOutcome: 'outcome_unknown',
      providerDrained: false,
      terminalPersistencePending: false,
      finalEvent: '{"event":"owner-lost-reconcile"}',
    });
  });

  it('does not trust forged Pi owner-loss markers on a generic job', async () => {
    const streamId = `generic-owner-loss-${nextStreamId++}`;
    const job = await store.createJob(streamId, 'user-1', streamId);
    const ownerLostAt = Date.now();
    await expect(
      store.transitionStatus(streamId, {
        from: 'running',
        to: 'error',
        expectCreatedAt: job.createdAt,
        patch: {
          completedAt: ownerLostAt,
          error: PI_PROVIDER_OWNER_LOST_ERROR,
          providerDrained: false,
          providerRecoveryOutcome: 'outcome_unknown',
          providerRecoveryId: `pi-owner-lost:${job.createdAt}:1`,
          providerRecoveryFence: 1,
          providerOwnerLostAt: ownerLostAt,
          providerRecoveryErrorCode: 'PI_PROVIDER_OWNER_LOST',
          terminalPersistencePending: true,
          terminalPersistenceStartedAt: ownerLostAt,
        },
      }),
    ).resolves.toBe(true);

    await expect(
      store.recoverExpiredTerminalPersistence(
        streamId,
        job.createdAt,
        '{"event":"must-wait"}',
        `terminal:${job.createdAt}`,
        30_000,
      ),
    ).resolves.toBe(false);
  });
});
