export type MessageKind = "text" | "voice" | "image" | "video" | "doc" | "other";

export interface InboundMedia {
  id: string;
  mimeType: string;
  filename?: string;
}

/** A WhatsApp message reduced to the fields Errand uses. */
export interface InboundMessage {
  id: string;
  from: string;
  profileName?: string;
  timestamp: number;
  kind: MessageKind;
  /** Body for text, caption for media, title for button replies. */
  text?: string;
  media?: InboundMedia;
  /** The id of a tapped reply button or list row. */
  buttonId?: string;
  /** WhatsApp's own type name, kept for logging messages Errand does not handle. */
  rawType?: string;
}
