export type {
  IConnector,
  NormalizedItem,
  ConnectorConfig,
  ChannelConfig,
  AuthConfig,
  AuthRequirement,
  ConnectorHealth,
  ConnectorsConfig,
} from './types.js';
export {
  attachmentConnector,
  type AttachmentConnector,
  type AttachmentDescriptor,
  type AttachmentListRequest,
  type AttachmentDownloadRequest,
  type AttachmentMatchRule,
} from './attachments.js';
export { ConnectorRegistry } from './connector-registry.js';
export { PollingScheduler } from './polling-scheduler.js';
export type {
  PollingSchedulerOptions,
  RawBatchCommittedCallback,
  SourceDelta,
  SourceObservationRef,
} from './polling-scheduler.js';
export { RawStore } from '../../storage/source-archive.js';
