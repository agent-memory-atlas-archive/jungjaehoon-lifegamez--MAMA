import type { IConnector } from './types.js';

export type AttachmentMatchRule = 'metadata_file_id' | 'text_marker' | 'message_id' | 'upload_time';

export interface AttachmentDescriptor {
  fileId: string;
  name: string;
  size: number;
  uploadTime: number;
  matchedBy: AttachmentMatchRule;
}

export interface AttachmentListRequest {
  roomId: string;
  messageId?: string;
  sourceAtMs?: number | null;
  fileIds?: readonly string[];
  fileIdRule?: Extract<AttachmentMatchRule, 'metadata_file_id' | 'text_marker'>;
}

export interface AttachmentDownloadRequest {
  roomId: string;
  fileId: string;
  targetPath: string;
}

export interface AttachmentConnector {
  listAttachments(request: AttachmentListRequest): Promise<AttachmentDescriptor[]>;
  downloadAttachment(
    request: AttachmentDownloadRequest
  ): Promise<{ descriptor: AttachmentDescriptor; size: number }>;
}

export function attachmentConnector(connector: IConnector): AttachmentConnector {
  const candidate = connector as Partial<AttachmentConnector>;
  if (
    typeof candidate.listAttachments !== 'function' ||
    typeof candidate.downloadAttachment !== 'function'
  ) {
    const error = new Error(`Connector ${connector.name} does not support attachments`);
    error.name = 'attachment_connector_unsupported';
    throw error;
  }
  return candidate as AttachmentConnector;
}
