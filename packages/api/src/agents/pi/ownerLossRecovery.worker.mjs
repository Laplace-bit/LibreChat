import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const Redis = require('ioredis');
const {
  GenerationJobManagerClass,
  PINNED_PI_AGENT_RUNTIME,
  RedisEventTransport,
  RedisJobStore,
} = require(resolve(repoRoot, 'packages/api/dist/index.cjs'));

const keyPrefix = process.env.PI_OWNER_RECOVERY_REDIS_PREFIX;
const streamId = process.env.PI_OWNER_RECOVERY_STREAM_ID;
const userId = `pi-owner-recovery-user-${process.pid}`;
const url = new URL(process.env.REDIS_URI ?? 'redis://127.0.0.1:6379');
const redis = new Redis(url.href, { keyPrefix, maxRetriesPerRequest: 2, lazyConnect: true });
const subscriber = redis.duplicate();
const manager = new GenerationJobManagerClass();

try {
  await Promise.all([redis.connect(), subscriber.connect()]);
  const jobStore = new RedisJobStore(redis);
  const eventTransport = new RedisEventTransport(redis, subscriber);
  manager.configure({ jobStore, eventTransport, isRedis: true, cleanupOnComplete: false });
  manager.initialize();

  const created = await manager.createJob(streamId, userId, streamId, {
    initialMetadata: {
      agentRuntime: PINNED_PI_AGENT_RUNTIME,
      agent_id: 'pi-owner-loss-recovery-test-agent',
    },
  });
  const job = await jobStore.getJob(streamId);
  if (job?.createdAt !== created.createdAt || !job.providerExecutionId) {
    throw new Error('Pi generation identity was not durably created');
  }
  if (!(await manager.beginProviderExecution(streamId, job.createdAt, job.providerExecutionId))) {
    throw new Error('The child process could not acquire its Pi provider owner lease');
  }
  await manager.emitChunk(
    streamId,
    {
      event: 'on_message_delta',
      data: { id: 'crash-owner-message', delta: { content: { type: 'text', text: 'started' } } },
    },
    { expectedCreatedAt: job.createdAt },
  );

  const owned = await jobStore.getJob(streamId);
  process.stdout.write(
    JSON.stringify({
      type: 'owner-ready',
      streamId,
      createdAt: owned.createdAt,
      providerExecutionId: owned.providerExecutionId,
      ownerId: owned.providerOwnerId,
      fence: owned.providerOwnerFence,
      leaseExpiresAt: owned.providerLeaseExpiresAt,
      userId: owned.userId,
    }) + '\n',
  );

  setTimeout(async () => {
    const renewed = await jobStore.getJob(streamId);
    process.stdout.write(
      JSON.stringify({
        type: 'owner-heartbeat',
        leaseExpiresAt: renewed?.providerLeaseExpiresAt,
      }) + '\n',
    );
  }, 11_000).unref?.();

  setInterval(() => undefined, 60_000);
} catch (error) {
  process.stderr.write(String(error?.stack ?? error) + '\n');
  process.exitCode = 1;
  await manager.destroy({ settlementBudgetMs: 100 });
} finally {
  if (process.exitCode != null) {
    await Promise.allSettled([redis.quit(), subscriber.quit()]);
  }
}
