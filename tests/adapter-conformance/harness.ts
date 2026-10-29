import assert from 'node:assert/strict';

export interface FakeHost {
  readonly registeredTools: string[];
  registerTool(name: string, handler: (...args: unknown[]) => unknown): void;
}

export function createFakeHost(): FakeHost {
  const registeredTools: string[] = [];
  return {
    registeredTools,
    registerTool(name) {
      registeredTools.push(name);
    },
  };
}

export function assertPublicEntrySpecifier(specifier: string): void {
  assert.doesNotMatch(specifier, /(^|\/)src\//);
  assert.doesNotMatch(specifier, /\/internal\//);
}

export async function assertErrorPassThrough(
  action: () => Promise<unknown>,
  expectedError: Error,
): Promise<void> {
  await assert.rejects(action, (error: unknown) => error === expectedError);
}
