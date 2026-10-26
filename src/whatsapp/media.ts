import { fetchRetry } from "../net.js";
import { config } from "../config.js";

const graph = () => `https://graph.facebook.com/${config.WHATSAPP_GRAPH_VERSION}`;
const auth = () => ({ Authorization: `Bearer ${config.WHATSAPP_TOKEN}` });

export interface DownloadedMedia {
  data: Buffer;
  mimeType: string;
}

/** Two steps: resolve the media id to a short-lived URL, then fetch the bytes with the same token. */
export async function downloadMedia(mediaId: string): Promise<DownloadedMedia> {
  const metaRes = await fetchRetry(`${graph()}/${mediaId}`, { headers: auth() });
  if (!metaRes.ok) throw new Error(`media lookup failed: HTTP ${metaRes.status}`);
  const meta = (await metaRes.json()) as { url: string; mime_type: string };

  const fileRes = await fetchRetry(meta.url, { headers: auth() });
  if (!fileRes.ok) throw new Error(`media download failed: HTTP ${fileRes.status}`);
  return { data: Buffer.from(await fileRes.arrayBuffer()), mimeType: meta.mime_type };
}

/** Uploads a file so it can be sent as a document. Returns the media id. */
export async function uploadMedia(data: Buffer, mimeType: string, filename: string): Promise<string> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([new Uint8Array(data)], { type: mimeType }), filename);
  const res = await fetchRetry(`${graph()}/${config.WHATSAPP_PHONE_NUMBER_ID}/media`, { method: "POST", headers: auth(), body: form });
  const json = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!res.ok || !json.id) throw new Error(`media upload failed: HTTP ${res.status} ${json.error?.message ?? ""}`.trim());
  return json.id;
}
