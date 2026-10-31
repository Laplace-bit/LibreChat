import { spawnSync } from 'node:child_process';

/**
 * Check whether a child is gone without assuming the host exposes Linux `/proc`.
 * `kill(pid, 0)` distinguishes a missing process, while POSIX `ps` identifies
 * zombies that still answer that probe. Windows reaps process handles without
 * a zombie state, so a successful signal probe means the process is alive.
 */
export function isProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = error.code;
      if (code === 'ESRCH') {
        return true;
      }
      if (code !== 'EPERM') {
        throw error;
      }
    } else {
      throw error;
    }
  }

  if (process.platform === 'win32') {
    return false;
  }

  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status === 1 && result.stdout.trim() === '') {
    /* The process exited between the signal probe and the `ps` snapshot. */
    return true;
  }
  if (result.status !== 0) {
    throw new Error(`Unable to inspect process ${pid}: ps exited with status ${result.status}`);
  }

  const state = result.stdout.trimStart().split(/\s+/, 1)[0];
  if (state === undefined || state.length === 0) {
    throw new Error(`Unable to inspect process ${pid}: ps returned no process state`);
  }
  return state.startsWith('Z');
}
