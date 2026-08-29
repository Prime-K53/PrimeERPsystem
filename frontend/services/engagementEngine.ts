// Removed feature: engagement engine.
// Stub retained so legacy imports do not break the build.
export const engagementEngine = {
  emit: (_event: string, _payload?: unknown) => {},
  on: (_event: string, _handler: (...args: unknown[]) => void) => () => {},
  off: (_event: string, _handler: (...args: unknown[]) => void) => {},
};
