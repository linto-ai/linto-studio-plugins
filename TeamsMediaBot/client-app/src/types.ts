export interface Caption {
  id: string;
  sessionId: string;
  channelId: string;
  text: string;
  speakerId?: string;
  language?: string;
  isFinal: boolean;
  timestamp: string;
  start?: number;
  end?: number;
  translations?: Record<string, string>;
}

export interface SessionInfo {
  sessionId: string;
  channelId: string;
  threadId?: string;
  enableDisplaySub: boolean;
}

export interface MeetingContext {
  meetingId?: string;
  conversationId?: string;
  threadId?: string;
}
