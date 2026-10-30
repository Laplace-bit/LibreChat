import type { PiModelBinding } from './session';

export type CreatePiModelBinding = () => Promise<PiModelBinding>;

const initializeResultFactories = new WeakMap<object, CreatePiModelBinding>();
const initializedAgentFactories = new WeakMap<object, CreatePiModelBinding>();

/** Keep the credential-bearing resolver off enumerable provider/agent state. */
export function setInitializeResultPiModelBindingFactory(
  initializeResult: object,
  factory: CreatePiModelBinding,
): void {
  initializeResultFactories.set(initializeResult, factory);
}

export function getInitializeResultPiModelBindingFactory(
  initializeResult: object,
): CreatePiModelBinding | undefined {
  return initializeResultFactories.get(initializeResult);
}

/** Move the request-scoped factory onto the final InitializedAgent identity. */
export function transferPiModelBindingFactory(
  initializeResult: object,
  initializedAgent: object,
): void {
  const factory = initializeResultFactories.get(initializeResult);
  if (factory === undefined) {
    return;
  }
  initializeResultFactories.delete(initializeResult);
  initializedAgentFactories.set(initializedAgent, factory);
}

/** AgentClient can resolve the factory only from the exact initialized agent object. */
export function getAgentPiModelBindingFactory(
  initializedAgent: object,
): CreatePiModelBinding | undefined {
  return initializedAgentFactories.get(initializedAgent);
}
