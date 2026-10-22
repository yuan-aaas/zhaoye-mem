export { AssistantFramework, openAssistantFramework, type AssistantApi, type MemoryWriteOptions } from './framework/assistant.js';
export { initRoot as initializeAssistantData } from './infrastructure/runtime.js';
export type { AdapterContext, IdentitySnapshot, IdentityPatch, IdentityPreview, IdentityUpdateRequest, IdentityUpdateReceipt } from './contracts/identity.js';
export { IdentityPatchSchema } from './contracts/identity.js';
export type { MemoryInput, SaveReceipt } from './memory-core/memory.js';
export type { MemoryItem, RouteEntry } from './contracts/schemas.js';
export { defaultLeadKernel, identityTemplates, profileQuestions } from './memory-core/identity-templates.js';
export { AssistantError, userMessage, type ErrorCode } from './contracts/errors.js';
