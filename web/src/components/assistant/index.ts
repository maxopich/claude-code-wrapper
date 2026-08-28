// Cebab-8x8.3.2: barrel for the floating assistant widget. App.tsx mounts
// `AssistantProvider` (innermost provider) + `AssistantDock` (sibling of
// AppShell, before NotificationStack); the rest are internal.
export { AssistantProvider, useAssistant, type AssistantContextValue } from './AssistantContext';
export { AssistantDock } from './AssistantDock';
export { assistantReducer } from './assistantReducer';
