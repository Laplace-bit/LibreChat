import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const Redis = require('ioredis');
const { GenerationJobManagerClass, RedisEventTransport, RedisJobStore } = require(
  resolve(repoRoot, 'packages/api/dist/index.cjs'),
);

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createRedisClient(keyPrefix) {
  const url = new URL(process.env.REDIS_URI ?? 'redis://127.0.0.1:6379');
  return new Redis(url.href, { keyPrefix, maxRetriesPerRequest: 2, lazyConnect: true });
}

async function closeRedisClient(redis) {
  if (!redis || redis.status === 'end') return;
  let timer;
  try {
    await Promise.race([
      redis.quit().catch(() => undefined),
      new Promise((resolveClose) => {
        timer = setTimeout(resolveClose, 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (redis.reconnectTimeout != null) {
      clearTimeout(redis.reconnectTimeout);
      redis.reconnectTimeout = null;
    }
    const stream = redis.connector?.stream;
    if (stream != null) {
      redis.manuallyClosing = true;
      stream.destroy();
    } else {
      redis.disconnect();
    }
  }
}

async function clearRedisPrefix(redis, keyPrefix) {
  const physicalKeys = await redis.keys('*');
  const logicalKeys = physicalKeys
    .filter((key) => key.startsWith(keyPrefix))
    .map((key) => key.slice(keyPrefix.length));
  if (logicalKeys.length > 0) await redis.del(...logicalKeys);
}

function startOwnerProcess(keyPrefix, streamId) {
  const child = spawn(
    process.execPath,
    [resolve(dirname(fileURLToPath(import.meta.url)), 'ownerLossRecovery.worker.mjs')],
    {
      env: {
        ...process.env,
        PI_OWNER_RECOVERY_REDIS_PREFIX: keyPrefix,
        PI_OWNER_RECOVERY_STREAM_ID: streamId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  const messages = [];
  const waiters = new Map();
  const exit = new Promise((resolveExit) =>
    child.once('exit', (code, signal) => resolveExit({ code, signal })),
  );

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    let newline;
    while ((newline = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        messages.push(message);
        waiters.get(message.type)?.resolve(message);
      } catch (error) {
        waiters.get('malformed')?.reject(error);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  return {
    child,
    messages,
    async waitFor(type, timeoutMs) {
      const existing = messages.find((message) => message.type === type);
      if (existing) return existing;
      const waiter = deferred();
      waiters.set(type, waiter);
      try {
        return await withTimeout(
          waiter.promise,
          timeoutMs,
          `owner process did not emit ${type}: ${stderr}`,
        );
      } finally {
        if (waiters.get(type) === waiter) waiters.delete(type);
      }
    },
    exit,
    get stderr() {
      return stderr;
    },
  };
}

async function stopOwnerProcess(worker) {
  if (!worker) return;
  if (worker.child.exitCode == null && worker.child.signalCode == null) {
    worker.child.kill('SIGTERM');
  }
  try {
    await withTimeout(worker.exit, 1_000, 'owner process did not exit after SIGTERM');
    return;
  } catch {
    if (worker.child.exitCode == null && worker.child.signalCode == null)
      worker.child.kill('SIGKILL');
  }
  await withTimeout(worker.exit, 1_000, 'owner process did not exit after SIGKILL').catch(
    () => undefined,
  );
}

test('Pi provider owner loss survives process crash and terminal publication retry', async () => {
  const keyPrefix = `Pi-Owner-Loss-Recovery-${process.pid}-${Date.now()}:`;
  const streamId = `pi-owner-loss-recovery-${Date.now()}`;
  const [storeRedisA, storeRedisB, publisher, subscriber, adminRedis] = [
    createRedisClient(keyPrefix),
    createRedisClient(keyPrefix),
    createRedisClient(keyPrefix),
    createRedisClient(keyPrefix),
    createRedisClient(keyPrefix),
  ];
  const worker = startOwnerProcess(keyPrefix, streamId);
  const storeA = new RedisJobStore(storeRedisA);
  const storeB = new RedisJobStore(storeRedisB);
  const transport = new RedisEventTransport(publisher, subscriber);
  const recoveryManager = new GenerationJobManagerClass();
  let subscription;
  const terminalEvents = [];
  const deliveredTerminal = deferred();
  const redisClients = [storeRedisA, storeRedisB, publisher, subscriber, adminRedis];

  try {
    await Promise.all(redisClients.map((redis) => redis.connect()));
    await clearRedisPrefix(adminRedis, keyPrefix);

    recoveryManager.configure({
      jobStore: storeB,
      eventTransport: transport,
      isRedis: true,
      cleanupOnComplete: false,
    });
    recoveryManager.initialize();
    subscription = transport.subscribe(streamId, {
      onDone(event, generationId) {
        terminalEvents.push({ event, generationId });
        if (event?.reconcileReason === 'provider_owner_lost') deliveredTerminal.resolve(event);
      },
      onError(error, generationId) {
        terminalEvents.push({ error, generationId });
      },
    });
    await withTimeout(subscription.ready, 5_000, 'recovery replica failed to subscribe');

    const ready = await worker.waitFor('owner-ready', 10_000);
    assert.notEqual(worker.child.pid, process.pid, 'Pi provider owner ran in a child OS process');
    assert.ok(ready.ownerId && ready.providerExecutionId && ready.fence > 0);
    assert.equal(
      await storeA.transitionStatus(streamId, {
        from: 'running',
        to: 'error',
        expectCreatedAt: ready.createdAt,
      }),
      false,
      'an ownerless terminal CAS cannot complete an active Pi provider generation',
    );
    await assert.rejects(
      transport.emitDone(streamId, { final: true }, ready.createdAt),
      /fenced/i,
      'ownerless terminal publication cannot bypass the active Pi owner',
    );
    assert.equal(await storeA.admitPiToolInvocation(ready, 'once-only-tool-call'), true);
    assert.equal(await storeB.admitPiToolInvocation(ready, 'once-only-tool-call'), false);
    const heartbeat = await worker.waitFor('owner-heartbeat', 20_000);
    assert.ok(
      heartbeat.leaseExpiresAt > ready.leaseExpiresAt + 5_000,
      'a silent Pi provider wait renews its Redis lease from the child process',
    );

    worker.child.kill('SIGKILL');
    const childExit = await withTimeout(
      worker.exit,
      3_000,
      'SIGKILL did not stop the owner process',
    );
    assert.equal(childExit.signal, 'SIGKILL');

    const owner = {
      streamId,
      createdAt: ready.createdAt,
      providerExecutionId: ready.providerExecutionId,
      ownerId: ready.ownerId,
      fence: ready.fence,
    };
    await adminRedis.hset(`stream:{${streamId}}:job`, 'providerLeaseExpiresAt', '1');

    const reaperClaims = await Promise.all([
      storeA.claimExpiredPiProviderOwner(owner),
      storeB.claimExpiredPiProviderOwner(owner),
    ]);
    assert.equal(reaperClaims.filter(Boolean).length, 1, 'Redis CAS elects one reaper winner');
    const claimed = await storeA.getJob(streamId);
    assert.equal(claimed.status, 'error');
    assert.equal(claimed.terminalPersistencePending, true);
    assert.equal(claimed.providerRecoveryOutcome, 'outcome_unknown');
    assert.equal(claimed.providerRecoveryId, `pi-owner-lost:${ready.createdAt}:${ready.fence}`);
    assert.equal(claimed.providerRecoveryErrorCode, 'PI_PROVIDER_OWNER_LOST');
    assert.equal(
      claimed.providerDrained,
      false,
      'crash is not misreported as a confirmed provider drain',
    );
    assert.ok(claimed.providerOwnerLostAt > 0, 'owner-loss time came from the Redis CAS');

    assert.equal(
      await storeB.appendChunk(
        streamId,
        { event: 'on_message_delta', data: { delta: { content: 'late stale chunk' } } },
        ready.createdAt,
        undefined,
        undefined,
        owner,
      ),
      false,
      'stale durable appends are fenced after owner loss',
    );
    assert.equal(await storeB.admitPiToolInvocation(owner, 'late-tool-call'), false);
    assert.equal(
      await storeB.markProviderExecutionDrained(
        streamId,
        ready.createdAt,
        ready.providerExecutionId,
        owner,
      ),
      false,
      'a stale owner cannot claim that its provider drained',
    );
    assert.equal(
      await storeA.transitionStatus(streamId, {
        from: 'error',
        to: 'complete',
        expectCreatedAt: ready.createdAt,
        expectProviderOwner: owner,
      }),
      false,
      'a late owner terminal claim is rejected by the owner fence',
    );
    assert.equal(
      await storeA.finalizeTerminalPersistence(
        streamId,
        ready.createdAt,
        JSON.stringify({ final: true, terminalStatus: 'complete' }),
        owner,
      ),
      false,
      'the expired owner cannot finalize after the reaper claim',
    );
    await assert.rejects(
      transport.emitDone(
        streamId,
        { final: true, terminalStatus: 'complete' },
        ready.createdAt,
        owner,
      ),
      /fenced/i,
    );

    // Model a reaper process dying after the owner-loss CAS but before final persistence.
    // A fresh manager discovers the retained generation index and completes the outbox.
    await recoveryManager.cleanup();
    const recoveryEvent = await withTimeout(
      deliveredTerminal.promise,
      5_000,
      'fresh replica did not publish the owner-loss terminal recovery',
    );
    assert.equal(recoveryEvent.providerRecoveryId, claimed.providerRecoveryId);
    assert.equal(recoveryEvent.providerRecoveryOutcome, 'outcome_unknown');
    assert.equal(recoveryEvent.providerRecoveryFence, ready.fence);
    assert.equal(recoveryEvent.providerRecoveryErrorCode, 'PI_PROVIDER_OWNER_LOST');
    assert.equal(recoveryEvent.terminalStatus, 'error');

    const recovered = await storeB.getJob(streamId);
    assert.equal(recovered.terminalPersistencePending, false);
    assert.equal(recovered.providerRecoveryPublishedId, claimed.providerRecoveryId);
    assert.equal(recovered.providerDrained, false);
    assert.equal(JSON.parse(recovered.finalEvent).providerRecoveryId, claimed.providerRecoveryId);
    const [seconds, microseconds] = await adminRedis.time();
    const redisNow = Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
    assert.ok(Math.abs(recovered.providerOwnerLostAt - redisNow) < 5_000);

    await transport.emitDone(
      streamId,
      JSON.parse(recovered.finalEvent),
      ready.createdAt,
      undefined,
      claimed.providerRecoveryId,
    );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    assert.equal(
      terminalEvents.filter(({ event }) => event?.reconcileReason === 'provider_owner_lost').length,
      1,
      'the recovery id makes a late terminal publication idempotent across replicas',
    );
    assert.equal(
      await adminRedis.sismember(
        'stream:terminal_persistence:v1',
        JSON.stringify([streamId, ready.createdAt]),
      ),
      0,
      'recovery retry index is removed only after the terminal has been published',
    );
  } finally {
    await stopOwnerProcess(worker);
    subscription?.unsubscribe();
    await recoveryManager.destroy({ settlementBudgetMs: 100 });
    await clearRedisPrefix(adminRedis, keyPrefix).catch(() => undefined);
    await Promise.allSettled(redisClients.map(closeRedisClient));
  }
});
