import { existsSync, readFileSync, writeSync } from 'node:fs';

const METRICS = [
  ['throughput', '吞吐'],
  ['p50', 'p50'],
  ['p95', 'p95'],
  ['errorRate', '错误率'],
  ['memory', '内存'],
  ['cpu', 'CPU'],
];

function failUnmeasured() {
  writeSync(1, '未测量\n');
  process.exit(1);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isLabel(value) {
  return typeof value === 'string' && value.trim() !== '' && !/[\n\r|]/.test(value);
}

function hasMetrics(record) {
  return METRICS.every(([key]) => isFiniteNumber(record[key]));
}

function readResult(path) {
  if (typeof path !== 'string' || path === '' || !existsSync(path)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  if (!isLabel(parsed.deploymentForm) || !isLabel(parsed.revision) || !hasMetrics(parsed)) {
    return null;
  }
  if (!Array.isArray(parsed.samples) || parsed.samples.length === 0) {
    return null;
  }
  for (const sample of parsed.samples) {
    const isRecord = sample != null && typeof sample === 'object' && !Array.isArray(sample);
    if (!isRecord || !hasMetrics(sample)) {
      return null;
    }
  }
  return parsed;
}

function renderTable(baseline, candidate) {
  const lines = ['| 指标 | 上一发布 | 本分支 |', '| --- | --- | --- |'];
  lines.push(`| 部署形态 | ${baseline.deploymentForm} | ${candidate.deploymentForm} |`);
  lines.push(`| 修订 | ${baseline.revision} | ${candidate.revision} |`);
  lines.push(`| 样本数 | ${baseline.samples.length} | ${candidate.samples.length} |`);
  for (const [key, label] of METRICS) {
    lines.push(`| ${label} | ${baseline[key]} | ${candidate[key]} |`);
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    failUnmeasured();
  }
  const baseline = readResult(args[0]);
  const candidate = readResult(args[1]);
  const sameDeployment = baseline != null && baseline.deploymentForm === candidate?.deploymentForm;
  if (baseline == null || candidate == null || !sameDeployment) {
    failUnmeasured();
  }
  writeSync(1, renderTable(baseline, candidate));
}

main();
