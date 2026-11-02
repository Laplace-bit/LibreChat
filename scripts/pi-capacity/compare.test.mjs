import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./compare.mjs', import.meta.url));

function metrics(seed) {
  return {
    throughput: seed,
    p50: seed + 1,
    p95: seed + 2,
    errorRate: seed + 3,
    memory: seed + 4,
    cpu: seed + 5,
  };
}

function result(revision, seed) {
  return {
    deploymentForm: 'same-shape',
    revision,
    ...metrics(seed),
    samples: [metrics(seed + 100)],
  };
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

test('missing result file exits unmeasured', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-capacity-'));
  try {
    const missing = join(dir, 'previous-release.json');
    const present = join(dir, 'this-branch.json');
    writeFileSync(present, JSON.stringify(result('this-branch', 20)));
    const outcome = run([missing, present]);
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stdout, /未测量/);
    assert.doesNotMatch(`${outcome.stdout}${outcome.stderr}`, /容量达标/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('complete result files print the supplied comparison and no capacity verdict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-capacity-'));
  try {
    const baseline = join(dir, 'previous-release.json');
    const candidate = join(dir, 'this-branch.json');
    writeFileSync(baseline, JSON.stringify(result('previous-release', 10)));
    writeFileSync(candidate, JSON.stringify(result('this-branch', 20)));
    const outcome = run([baseline, candidate]);
    assert.equal(outcome.status, 0, outcome.stderr);
    assert.match(outcome.stdout, /\| 指标 \| 上一发布 \| 本分支 \|/);
    assert.match(outcome.stdout, /\| 部署形态 \| same-shape \| same-shape \|/);
    assert.match(outcome.stdout, /\| 修订 \| previous-release \| this-branch \|/);
    assert.match(outcome.stdout, /\| 吞吐 \| 10 \| 20 \|/);
    assert.match(outcome.stdout, /\| p50 \| 11 \| 21 \|/);
    assert.match(outcome.stdout, /\| p95 \| 12 \| 22 \|/);
    assert.match(outcome.stdout, /\| 错误率 \| 13 \| 23 \|/);
    assert.match(outcome.stdout, /\| 内存 \| 14 \| 24 \|/);
    assert.match(outcome.stdout, /\| CPU \| 15 \| 25 \|/);
    assert.doesNotMatch(outcome.stdout, /\| 吞吐 \| 110 \| 120 \|/);
    assert.doesNotMatch(`${outcome.stdout}${outcome.stderr}`, /容量达标/);
    assert.doesNotMatch(outcome.stdout, /未测量/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('empty samples and missing fields exit unmeasured', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-capacity-'));
  try {
    const baseline = join(dir, 'previous-release.json');
    const emptySamples = join(dir, 'empty-samples.json');
    const missingCpu = join(dir, 'missing-cpu.json');
    writeFileSync(baseline, JSON.stringify(result('previous-release', 10)));
    writeFileSync(emptySamples, JSON.stringify({ ...result('this-branch', 20), samples: [] }));
    const emptyOutcome = run([baseline, emptySamples]);
    assert.notEqual(emptyOutcome.status, 0);
    assert.match(emptyOutcome.stdout, /未测量/);

    const incomplete = result('this-branch', 20);
    delete incomplete.cpu;
    incomplete.samples[0] = metrics(120);
    writeFileSync(missingCpu, JSON.stringify(incomplete));
    const missingOutcome = run([baseline, missingCpu]);
    assert.notEqual(missingOutcome.status, 0);
    assert.match(missingOutcome.stdout, /未测量/);
    assert.doesNotMatch(`${emptyOutcome.stdout}${missingOutcome.stdout}`, /容量达标/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
