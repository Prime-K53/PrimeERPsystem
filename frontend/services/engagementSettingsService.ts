// Removed feature: engagement settings service.
// Stub retained so legacy imports do not break the build.
export const DEFAULT_ENGAGEMENT_SETTINGS = {};
export const engagementSettingsService = {
  get: () => ({}),
  set: (_patch: unknown) => {},
  subscribe: (_handler: (...args: unknown[]) => void) => () => {},
};
