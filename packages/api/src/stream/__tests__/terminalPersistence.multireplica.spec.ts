import type { ServerSentEvent } from '~/types';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '../GenerationJobManager';

describe('GenerationJobManager terminal persistence ownership across replicas', () => {
  let store: InMemoryJobStore;
  let owner: GenerationJobManagerClass;
  let replica: GenerationJobManagerClass;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    store = new InMemoryJobStore({ ttlAfterComplete: 10 * 60_000 });
    owner = new GenerationJobManagerClass();
    replica = new GenerationJobManagerClass();
    owner.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    replica.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
  });

  afterEach(async () => {
    await owner.destroy();
    await replica.destroy();
    await store.destroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  async function claimTerminal() {
    const job = await owner.createJob('shared-terminal-job', 'user-1', 'conversation-1');
    const claim = await owner.claimTerminalJob(job.streamId, 'complete', undefined, job.createdAt, {
      persistencePending: true,
    });
    if (claim == null) throw new Error('Expected the owner replica to claim terminal persistence.');
    return { job, claim };
  }

  it('keeps a live terminal writer fenced while another replica runs cleanup', async () => {
    const { job, claim } = await claimTerminal();
    const originalOwnerToken = claim.persistenceOwnerToken;
    expect(originalOwnerToken).toEqual(expect.any(String));

    // The writer remains active well beyond the old 30-second stale-owner window.
    await jest.advanceTimersByTimeAsync(120_000);
    await replica['cleanup']();

    const pending = await store.getJob(job.streamId);
    expect(pending).toMatchObject({
      terminalPersistencePending: true,
      terminalPersistenceOwnerToken: originalOwnerToken,
    });
    expect(pending?.terminalPersistenceLeaseExpiresAt).toBeGreaterThan(Date.now());

    const finalEvent = {
      final: true,
      terminalStatus: 'complete',
      generationCreatedAt: job.createdAt,
    } as ServerSentEvent;
    const published = await owner.publishTerminalClaim(claim, finalEvent);
    expect(published.persistenceFailed).toBe(false);
    expect(await store.getJob(job.streamId)).toMatchObject({
      terminalPersistencePending: false,
      finalEvent: JSON.stringify(finalEvent),
    });
    await owner.finishTerminalJob(claim);
  });

  it('recovers after the owner stops renewing and rejects its late final', async () => {
    const { job, claim } = await claimTerminal();
    owner['stopTerminalPersistenceLease'](claim);

    await jest.advanceTimersByTimeAsync(90_001);
    await replica['cleanup']();

    const recovered = await store.getJob(job.streamId);
    expect(recovered).toMatchObject({
      terminalPersistencePending: false,
      terminalPublicationId: `terminal:${job.createdAt}`,
    });
    expect(recovered?.finalEvent).toContain('"reconcile":true');

    const lateFinalText = 'must not replace the recovered result';
    const lateFinal = {
      final: true,
      terminalStatus: 'complete',
      generationCreatedAt: job.createdAt,
      text: lateFinalText,
    } as ServerSentEvent;
    const published = await owner.publishTerminalClaim(claim, lateFinal);
    expect(published.persistenceFailed).toBe(true);
    expect(await store.getJob(job.streamId)).toMatchObject({
      terminalPersistencePending: false,
      finalEvent: recovered?.finalEvent,
    });
    expect((await store.getJob(job.streamId))?.finalEvent).not.toContain(lateFinalText);
    await owner.finishTerminalJob(claim);
  });
});
