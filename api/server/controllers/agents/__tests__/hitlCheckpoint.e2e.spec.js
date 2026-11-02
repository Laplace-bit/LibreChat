const { execFile } = require('node:child_process');
const { resolve } = require('node:path');

const repoRoot = resolve(__dirname, '../../../../../');
const integrationPath = resolve(
  repoRoot,
  'packages/api/src/agents/pi/resumeCrossReplica.integration.mjs',
);

function runPiIntegration() {
  return new Promise((resolveOutput, reject) => {
    execFile(
      process.execPath,
      ['--test', '--test-concurrency=1', integrationPath],
      {
        cwd: repoRoot,
        env: process.env,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`;
        if (error) {
          reject(
            new Error(`Pi approval continuation integration failed:\n${output}\n${error.message}`),
          );
          return;
        }
        resolveOutput(output);
      },
    );
  });
}

describe('Pi tool approval resume lifecycle', () => {
  jest.setTimeout(75_000);

  test('the real Pi continuation resumes on another replica with one CAS winner', async () => {
    const output = await runPiIntegration();

    expect(output).toMatch(/pass 1\b/);
    expect(output).toMatch(/fail 0\b/);
    expect(output).toMatch(/skipped 0\b/);
  });
});
