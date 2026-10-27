export type MessageKind = "text" | "voice" | "image" | "video" | "doc" | "other";

export interface InboundMedia {
  /** Telegram file_id, used to download the file. */
  id: string;
  mimeType: string;
  filename?: string;
  /** Size in bytes when Telegram reports it. Bots can only download files up to 20 MB. */
  size?: number;
}

/** A Telegram update reduced to the fields MyPaddy uses. */
export interface InboundMessage {
  /** Unique per chat and message, used to skip duplicate deliveries. */
  id: string;
  /** The private chat id. Replies go here. */
  from: string;
  profileName?: string;
  timestamp: number;
  kind: MessageKind;
  /** Body for text, caption for media. */
  text?: string;
  media?: InboundMedia;
  /** Data of a tapped inline button. */
  buttonId?: string;
  /** Set for button taps: the callback to answer and the message whose buttons to remove. */
  callback?: { id: string; messageId: number };
  /** Telegram's own type name, kept for logging messages MyPaddy does not handle. */
  rawType?: string;
}
