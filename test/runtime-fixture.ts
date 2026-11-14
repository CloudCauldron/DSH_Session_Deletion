import { DeletionRuntime, type RuntimeContext, type UploadIndex } from '../lib/runtime.js';
import type { DeletionRuntime as RuntimeSource } from '../src/runtime.ts';

type RuntimeStubs = {
  [K in keyof RuntimeContext]?: RuntimeContext[K] extends (...args: never[]) => unknown
    ? RuntimeContext[K] : Partial<RuntimeContext[K]>;
};
type RuntimeInternals = Pick<DeletionRuntime, keyof DeletionRuntime> & {
  operation: RuntimeSource['operation']; snapshots: RuntimeSource['snapshots']; quiescence: RuntimeSource['quiescence'];
  maintenance: RuntimeSource['maintenance']; controller: RuntimeSource['controller']; schedule: RuntimeSource['schedule'];
  handles: RuntimeSource['handles']; stopTimeoutMs: RuntimeSource['stopTimeoutMs']; terminals: RuntimeSource['terminals'];
  manager: RuntimeSource['manager']; activations: RuntimeSource['activations']; stop: RuntimeSource['stop'];
};

class UnusedUploadIndex implements UploadIndex {
  async load(): Promise<never> { throw new Error('Unexpected upload-index access in this unit fixture'); }
  async remove(): Promise<never> { throw new Error('Unexpected upload-index access in this unit fixture'); }
}

/** Each unit supplies only the services used by the operation under test. */
export function makeRuntime(ctx: RuntimeStubs): RuntimeInternals {
  const manager = { resident: new Map(), materializations: new Set(),
    dispose: async () => {}, assertAdmitting() {}, rootOf: (agent: unknown) => agent };
  return new DeletionRuntime({
    subagents: { manager },
    jobs: { start() {}, list: () => [], kill() {}, events: { subscribe: () => () => {} } },
    on: () => () => {}, ...ctx,
  } as RuntimeContext, value => value, UnusedUploadIndex) as unknown as RuntimeInternals;
}
