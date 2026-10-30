#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const packages = lock.packages;
const rootDependencies = packages.api?.dependencies;
const piVersion = rootDependencies?.['@earendil-works/pi-coding-agent'];

if (piVersion !== '1.4.0') {
  throw new Error(`Expected the pinned Pi SDK 1.4.0, found ${String(piVersion)}`);
}

function resolveDependencyPath(parentPath, dependencyName) {
  let ancestor = parentPath;
  while (ancestor !== '') {
    const candidate = `${ancestor}/node_modules/${dependencyName}`;
    if (packages[candidate] != null) {
      return candidate;
    }
    const nestedIndex = ancestor.lastIndexOf('/node_modules/');
    if (nestedIndex >= 0) {
      ancestor = ancestor.slice(0, nestedIndex);
    } else {
      ancestor = '';
    }
  }
  const rootCandidate = `node_modules/${dependencyName}`;
  return packages[rootCandidate] == null ? undefined : rootCandidate;
}

const pending = [
  {
    parentPath: 'api',
    dependencyName: '@earendil-works/pi-coding-agent',
  },
];
const seenPaths = new Set();
const missing = [];

while (pending.length > 0) {
  const next = pending.pop();
  const packagePath = resolveDependencyPath(next.parentPath, next.dependencyName);
  if (packagePath == null) {
    missing.push(`${next.parentPath} -> ${next.dependencyName}`);
    continue;
  }
  if (seenPaths.has(packagePath)) {
    continue;
  }
  seenPaths.add(packagePath);

  const entry = packages[packagePath];
  for (const dependencyName of Object.keys(entry.dependencies ?? {})) {
    pending.push({ parentPath: packagePath, dependencyName });
  }
  for (const dependencyName of Object.keys(entry.optionalDependencies ?? {})) {
    pending.push({ parentPath: packagePath, dependencyName });
  }
}

if (missing.length > 0) {
  throw new Error(`Pi dependency graph has missing lock entries:\n${missing.join('\n')}`);
}

const entries = await Promise.all(
  [...seenPaths].map(async (packagePath) => {
    const entry = packages[packagePath];
    let manifestLicense;
    try {
      const manifest = JSON.parse(
        await readFile(new URL(`../${packagePath}/package.json`, import.meta.url), 'utf8'),
      );
      manifestLicense = manifest.license;
    } catch {
      manifestLicense = undefined;
    }
    const license = entry.license ?? manifestLicense;
    return {
      path: packagePath,
      version: entry.version,
      license: typeof license === 'string' ? license : (license?.type ?? 'UNKNOWN'),
    };
  }),
);
entries.sort((left, right) => left.path.localeCompare(right.path));
const licenses = Object.groupBy(entries, ({ license }) => license);
const unknown = entries.filter(({ license }) => license === 'UNKNOWN' || license === 'UNLICENSED');

process.stdout.write(
  `${JSON.stringify(
    {
      piVersion,
      packageCount: entries.length,
      licenseCounts: Object.fromEntries(
        Object.entries(licenses).map(([license, rows]) => [license, rows.length]),
      ),
      unknownLicenseCount: unknown.length,
      packages: entries,
    },
    null,
    2,
  )}\n`,
);

if (unknown.length > 0) {
  process.exitCode = 1;
}
