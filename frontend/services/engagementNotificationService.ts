// Removed feature: engagement notification service.
// Stub retained so legacy imports do not break the build.
export const engagementNotificationService = {
  subscribe: (_handler: (...args: unknown[]) => void) => () => {},
};
