/**
 * erpQuery/index.ts — Public surface of the Copilot ERP query layer.
 *
 * Extension point: to support a new ERP entity, add its definition to
 * entityRegistry.ts (+ synonyms in queryInterpreter.ts) and pass its dataset
 * via CopilotDatasets. No Copilot redesign required.
 */
export * from './erpQueryTypes';
export * from './entityRegistry';
export * from './dateScope';
export * from './fieldResolvers';
export * from './queryExecutor';
export * from './queryInterpreter';
export * from './conversationContext';
export * from './copilotQueryService';
