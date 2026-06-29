export type LineWebhookBody = {
  events?: LineWebhookEvent[];
};

export type LineWebhookEvent = {
  type: string;
  timestamp: number;
  replyToken?: string;
  source?: {
    type: "user" | "group" | "room";
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  message?: LineMessage;
  // Present on `unsend` events: the id of the message the user revoked.
  unsend?: {
    messageId: string;
  };
};

export type LineMessage =
  | {
      type: "text";
      id: string;
      text: string;
    }
  | {
      type: "file";
      id: string;
      fileName: string;
      fileSize?: number;
    }
  | {
      type: string;
      id?: string;
      [key: string]: unknown;
    };

export type ArchiveEntry = {
  kind: "pdf" | "file" | "url";
  postedAt: Date;
  senderId: string;
  groupId: string;
  title: string;
  originalUrl?: string;
  driveUrl?: string;
  driveFileId?: string;
  summary: string[];
  tags: string[];
  notes?: string[];
};
