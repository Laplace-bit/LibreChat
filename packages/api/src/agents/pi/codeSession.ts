import { Constants } from '@librechat/agents';
import type { CodeEnvFile, CodeSessionContext, ToolExecuteResult } from '@librechat/agents';
import { AgentRuntimeUnavailableError } from '../runtime/selection';
import { PI_BASH_TOOL_NAME } from './toolNames';

export interface PiCodeSessionSnapshot {
  session_id: CodeSessionContext['session_id'];
  files?: CodeEnvFile[];
}

const MAX_SESSION_ID_LENGTH = 512;
const MAX_FILE_REFS = 128;
const MAX_FILE_FIELD_LENGTH = 1_024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FILE_FIELD_LENGTH;
}

function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH;
}

function normalizeFileRef(value: unknown, trustedPrior?: CodeEnvFile): CodeEnvFile | undefined {
  if (!isRecord(value) || !isBoundedString(value.id) || !isBoundedString(value.name)) {
    return undefined;
  }
  const storageSessionId =
    value.storage_session_id === undefined
      ? trustedPrior?.storage_session_id
      : value.storage_session_id;
  if (!isBoundedString(storageSessionId)) {
    return undefined;
  }
  const kind = value.kind === undefined ? (trustedPrior?.kind ?? 'user') : value.kind;
  const resourceId =
    value.resource_id === undefined
      ? (trustedPrior?.resource_id ?? (kind === 'user' ? value.id : undefined))
      : value.resource_id;
  if (!isBoundedString(resourceId)) {
    return undefined;
  }
  if (kind === 'skill') {
    let version = value.version;
    if (version === undefined && trustedPrior?.kind === 'skill') {
      version = trustedPrior.version;
    }
    if (!Number.isSafeInteger(version) || (version as number) < 1) {
      return undefined;
    }
    return {
      id: value.id,
      resource_id: resourceId,
      name: value.name,
      storage_session_id: storageSessionId,
      kind: 'skill',
      version: version as number,
    };
  }
  if (kind === 'agent') {
    return {
      id: value.id,
      resource_id: resourceId,
      name: value.name,
      storage_session_id: storageSessionId,
      kind: 'agent',
    };
  }
  if (kind !== 'user') {
    return undefined;
  }
  return {
    id: value.id,
    resource_id: resourceId,
    name: value.name,
    storage_session_id: storageSessionId,
    kind: 'user',
  };
}

function identity(file: Pick<CodeEnvFile, 'storage_session_id' | 'id'>): string {
  return `${file.storage_session_id}\0${file.id}`;
}

function preserveTrustedFileOwnership(file: CodeEnvFile, trustedPrior?: CodeEnvFile): CodeEnvFile {
  if (trustedPrior == null) {
    return file;
  }
  switch (trustedPrior.kind) {
    case 'skill':
      return {
        ...file,
        resource_id: trustedPrior.resource_id,
        storage_session_id: trustedPrior.storage_session_id,
        kind: 'skill',
        version: trustedPrior.version,
      };
    case 'agent':
      return {
        ...file,
        resource_id: trustedPrior.resource_id,
        storage_session_id: trustedPrior.storage_session_id,
        kind: 'agent',
      };
    case 'user':
      return {
        ...file,
        resource_id: trustedPrior.resource_id,
        storage_session_id: trustedPrior.storage_session_id,
        kind: 'user',
      };
  }
}

function cloneSnapshot(value: unknown): PiCodeSessionSnapshot | undefined {
  if (value == null) return undefined;
  if (!isRecord(value) || !isSessionId(value.session_id)) {
    throw new AgentRuntimeUnavailableError();
  }
  if (value.files !== undefined && !Array.isArray(value.files)) {
    throw new AgentRuntimeUnavailableError();
  }
  const inputFiles = (value.files ?? []) as unknown[];
  if (inputFiles.length > MAX_FILE_REFS) {
    throw new AgentRuntimeUnavailableError();
  }
  const files: CodeEnvFile[] = [];
  for (const inputFile of inputFiles) {
    const file = normalizeFileRef(inputFile);
    if (file == null) {
      throw new AgentRuntimeUnavailableError();
    }
    files.push(file);
  }
  if (
    new Set(files.map(identity)).size !== files.length ||
    new Set(files.map((file) => file.name)).size !== files.length
  ) {
    throw new AgentRuntimeUnavailableError();
  }
  return {
    session_id: value.session_id,
    ...(files.length === 0 ? {} : { files }),
  };
}

/** Validates and clones the server-only snapshot stored with a paused Pi run. */
export function parsePiCodeSessionSnapshot(value: unknown): PiCodeSessionSnapshot | undefined {
  return cloneSnapshot(value);
}

function foldCodeExecutionArtifact(
  prior: PiCodeSessionSnapshot | undefined,
  artifact: unknown,
): PiCodeSessionSnapshot | undefined {
  if (!isRecord(artifact) || !isSessionId(artifact.session_id)) {
    throw new AgentRuntimeUnavailableError();
  }
  if (artifact.files !== undefined && !Array.isArray(artifact.files)) {
    throw new AgentRuntimeUnavailableError();
  }
  if (
    artifact.deleted_files !== undefined &&
    (!Array.isArray(artifact.deleted_files) ||
      artifact.deleted_files.length > MAX_FILE_REFS ||
      !artifact.deleted_files.every(isBoundedString))
  ) {
    throw new AgentRuntimeUnavailableError();
  }
  if ((artifact.files?.length ?? 0) > MAX_FILE_REFS) {
    throw new AgentRuntimeUnavailableError();
  }

  const sessionId = artifact.session_id;
  const priorFiles = prior?.files ?? [];
  const priorByName = new Map(priorFiles.map((file) => [file.name, file]));
  const priorIdentityByName = new Map(priorFiles.map((file) => [file.name, identity(file)]));
  const deletedIdentityByName = new Map<string, string>();
  for (const name of (artifact.deleted_files ?? []) as string[]) {
    const fileIdentity = priorIdentityByName.get(name);
    if (fileIdentity != null) deletedIdentityByName.set(name, fileIdentity);
  }

  const incoming: CodeEnvFile[] = [];
  const incomingIdentities = new Set<string>();
  const incomingNames = new Set<string>();
  for (const rawFile of (artifact.files ?? []) as unknown[]) {
    if (!isRecord(rawFile)) {
      throw new AgentRuntimeUnavailableError();
    }
    const priorFile = typeof rawFile.name === 'string' ? priorByName.get(rawFile.name) : undefined;
    const baselineIdentity =
      typeof rawFile.name === 'string' ? priorIdentityByName.get(rawFile.name) : undefined;
    const rawIdentityMatchesBaseline =
      baselineIdentity != null &&
      typeof rawFile.id === 'string' &&
      baselineIdentity.endsWith(`\0${rawFile.id}`);
    if (
      rawFile.inherited === true &&
      rawIdentityMatchesBaseline &&
      (priorFile == null || deletedIdentityByName.get(rawFile.name as string) === baselineIdentity)
    ) {
      continue;
    }
    const trustedPrior =
      priorFile != null &&
      typeof rawFile.id === 'string' &&
      priorFile.id === rawFile.id &&
      (rawFile.storage_session_id === undefined ||
        rawFile.storage_session_id === priorFile.storage_session_id)
        ? priorFile
        : undefined;
    const normalized = normalizeFileRef(rawFile, trustedPrior);
    if (normalized == null || incomingNames.has(normalized.name)) {
      throw new AgentRuntimeUnavailableError();
    }
    const identityKey = identity(normalized);
    if (incomingIdentities.has(identityKey)) continue;

    /* A Code API worker echo is not authority to change the resource owner or
     * kind that was signed when the file entered the managed storage bucket. */
    const merged = preserveTrustedFileOwnership(normalized, trustedPrior);
    incoming.push(merged);
    incomingIdentities.add(identity(merged));
    incomingNames.add(merged.name);
  }

  const retained = priorFiles.filter((file) => {
    const deleted = deletedIdentityByName.get(file.name) === identity(file);
    return !incomingNames.has(file.name) && !deleted;
  });
  const nextFiles = [...retained, ...incoming];
  if (nextFiles.length > MAX_FILE_REFS) {
    throw new AgentRuntimeUnavailableError();
  }
  return {
    session_id: sessionId,
    files: nextFiles,
  };
}

/** Run-local, serial Code API session state for Pi's managed execution tools. */
export class PiCodeSessionBridge {
  private context: PiCodeSessionSnapshot | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(initialContext?: unknown) {
    this.context = cloneSnapshot(initialContext);
  }

  snapshot(): PiCodeSessionSnapshot | undefined {
    return this.context == null ? undefined : cloneSnapshot(this.context);
  }

  async execute<T extends { name: string }>(
    call: T,
    executeHostCall: (
      call: T & { codeSessionContext?: PiCodeSessionSnapshot },
    ) => Promise<ToolExecuteResult>,
  ): Promise<ToolExecuteResult> {
    if (call.name !== PI_BASH_TOOL_NAME && call.name !== Constants.READ_FILE) {
      return executeHostCall(call);
    }

    const execution = this.queue.then(async () => {
      const context = this.snapshot();
      const hostCall = {
        ...call,
        ...(context == null ? {} : { codeSessionContext: context }),
      } as T & { codeSessionContext?: PiCodeSessionSnapshot };
      const result = await executeHostCall(hostCall);
      if (call.name === PI_BASH_TOOL_NAME && result.status === 'success') {
        this.context = foldCodeExecutionArtifact(this.context, result.artifact);
      }
      return result;
    });
    this.queue = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }
}

export function createPiCodeSessionBridge(initialContext?: unknown): PiCodeSessionBridge {
  return new PiCodeSessionBridge(initialContext);
}
