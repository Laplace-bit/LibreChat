import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const jestCli = fileURLToPath(new URL('../../node_modules/jest/bin/jest.js', import.meta.url));
const piEsmTestFiles = ['src/agents/pi/model.spec.ts', 'src/endpoints/openai/initialize.spec.ts'];
const forwardedArgs = process.argv.slice(2);
console.log('Running the API Jest suite without the Pi ESM-only test files.');
const regularTests = spawnSync(
  process.execPath,
  [
    jestCli,
    '--coverage',
    '--ci',
    '--testPathIgnorePatterns',
    '\\.*integration\\.|\\.*helper\\.|__tests__/helpers/|\\.*manual\\.spec\\.|src/agents/pi/model\\.spec\\.ts$|src/endpoints/openai/initialize\\.spec\\.ts$',
    ...forwardedArgs,
  ],
  { stdio: 'inherit' },
);

const piArgs = forwardedArgs.filter((argument) => !argument.startsWith('--maxWorkers'));
console.log('Running the Pi ESM-only Jest test files with VM modules enabled.');
const piEsmTests = spawnSync(
  process.execPath,
  [
    '--experimental-vm-modules',
    jestCli,
    '--coverage=false',
    '--ci',
    '--runInBand',
    '--runTestsByPath',
    ...piEsmTestFiles,
    ...piArgs,
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, JEST_JUNIT_OUTPUT_NAME: 'pi-esm-junit.xml' },
  },
);

process.exitCode = regularTests.status === 0 && piEsmTests.status === 0 ? 0 : 1;
