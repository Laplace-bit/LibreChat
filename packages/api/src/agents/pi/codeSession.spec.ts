import { Constants, type CodeSessionContext, type ToolExecuteResult } from '@librechat/agents';
import { AgentRuntimeUnavailableError } from '../runtime/selection';
import { createPiCodeSessionBridge } from './codeSession';

const initialContext: CodeSessionContext = {
  session_id: 'exec-initial',
  files: [
    {
      id: 'input-file',
      resource_id: 'user-1',
      name: 'input.txt',
      storage_session_id: 'storage-input',
      kind: 'user',
    },
  ],
  lastUpdated: 1,
};

function result(toolCallId: string, artifact?: ToolExecuteResult['artifact']): ToolExecuteResult {
  return {
    toolCallId,
    status: 'success',
    content: 'ok',
    ...(artifact == null ? {} : { artifact }),
  };
}

describe('PiCodeSessionBridge', () => {
  it('serializes code calls and folds Code API refs before the next call is routed', async () => {
    const bridge = createPiCodeSessionBridge(initialContext);
    const firstCall: { id: string; name: string; args: unknown; stepId: string } = {
      id: 'bash-1',
      name: Constants.BASH_TOOL,
      args: { command: 'make output' },
      stepId: 'step-1',
    };
    const secondCall: { id: string; name: string; args: unknown; stepId: string } = {
      id: 'read-1',
      name: Constants.READ_FILE,
      args: { path: 'output.txt' },
      stepId: 'step-2',
    };
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const observed: Array<{ id: string; context?: { session_id: string; files?: unknown[] } }> = [];

    const first = bridge.execute(firstCall, async (call) => {
      observed.push({ id: call.id, context: call.codeSessionContext });
      await firstGate;
      return result('bash-1', {
        session_id: 'exec-after-bash',
        files: [
          {
            id: 'input-file',
            name: 'input.txt',
          },
          {
            id: 'output-file',
            name: 'output.txt',
            storage_session_id: 'storage-output',
          },
        ],
      });
    });
    const second = bridge.execute(secondCall, async (call) => {
      observed.push({ id: call.id, context: call.codeSessionContext });
      return result('read-1', {
        session_id: 'must-not-fold-read-result',
        files: [{ id: 'wrong', name: 'wrong.txt', storage_session_id: 'wrong-storage' }],
      });
    });

    await Promise.resolve();
    expect(observed.map(({ id }) => id)).toEqual(['bash-1']);
    releaseFirst();
    await Promise.all([first, second]);

    expect(observed[0]?.context).toEqual({
      session_id: 'exec-initial',
      files: initialContext.files,
    });
    expect(observed[1]?.context).toEqual({
      session_id: 'exec-after-bash',
      files: [
        initialContext.files![0],
        {
          id: 'output-file',
          resource_id: 'output-file',
          name: 'output.txt',
          storage_session_id: 'storage-output',
          kind: 'user',
        },
      ],
    });
    expect(bridge.snapshot()).toEqual(observed[1]?.context);
  });

  it('removes only explicitly deleted refs and keeps a file owner across worker echoes', async () => {
    const bridge = createPiCodeSessionBridge({
      ...initialContext,
      files: [
        ...initialContext.files!,
        {
          id: 'skill-file',
          resource_id: 'skill-resource',
          name: 'guide.md',
          storage_session_id: 'storage-skill',
          kind: 'skill',
          version: 3,
        },
      ],
    });
    await bridge.execute(
      { id: 'bash-2', name: Constants.BASH_TOOL, args: { command: 'rm guide.md' }, stepId: 's2' },
      async () =>
        result('bash-2', {
          session_id: 'exec-deleted',
          files: [
            {
              id: 'input-file',
              name: 'input.txt',
              storage_session_id: 'storage-input',
            },
          ],
          deleted_files: ['guide.md'],
        }),
    );

    expect(bridge.snapshot()).toEqual({
      session_id: 'exec-deleted',
      files: [
        {
          ...initialContext.files![0],
        },
      ],
    });
  });

  it('does not fold a read_file result into the Code API session', async () => {
    const bridge = createPiCodeSessionBridge(initialContext);
    await bridge.execute(
      { id: 'read-2', name: Constants.READ_FILE, args: { path: 'input.txt' }, stepId: 's3' },
      async () => result('read-2', { session_id: 'untrusted', files: [] }),
    );

    expect(bridge.snapshot()).toEqual({
      session_id: 'exec-initial',
      files: initialContext.files,
    });
  });

  it('serializes skill file artifacts into the next managed Code API context', async () => {
    const bridge = createPiCodeSessionBridge(initialContext);
    let observedContext: unknown;
    await bridge.execute(
      { id: 'skill-1', name: Constants.SKILL_TOOL, args: { skillName: 'maintenance' } },
      async (call) => {
        observedContext = call.codeSessionContext;
        return result('skill-1', {
          session_id: 'exec-after-skill',
          files: [
            {
              id: 'guide-file',
              resource_id: 'skill-resource',
              name: 'guide.md',
              storage_session_id: 'storage-skill',
              kind: 'skill',
              version: 4,
            },
          ],
        });
      },
    );

    expect(observedContext).toEqual({
      session_id: initialContext.session_id,
      files: initialContext.files,
    });
    expect(bridge.snapshot()).toEqual({
      session_id: 'exec-after-skill',
      files: [
        ...initialContext.files!,
        {
          id: 'guide-file',
          resource_id: 'skill-resource',
          name: 'guide.md',
          storage_session_id: 'storage-skill',
          kind: 'skill',
          version: 4,
        },
      ],
    });
  });

  it('rejects malformed initial refs instead of silently losing caller files', () => {
    expect(() =>
      createPiCodeSessionBridge({ session_id: 'exec-initial', files: [{ id: 'missing-name' }] }),
    ).toThrow();
  });

  it('fails closed and keeps the previous snapshot when a bash artifact has malformed refs', async () => {
    const bridge = createPiCodeSessionBridge(initialContext);
    await expect(
      bridge.execute(
        { id: 'bash-malformed', name: Constants.BASH_TOOL, args: { command: 'make report' } },
        async () =>
          result('bash-malformed', {
            session_id: 'exec-after-malformed',
            files: [{ id: 'new-file', name: 'new.txt' }],
          }),
      ),
    ).rejects.toBeInstanceOf(AgentRuntimeUnavailableError);

    expect(bridge.snapshot()).toEqual({
      session_id: initialContext.session_id,
      files: initialContext.files,
    });
  });
});
