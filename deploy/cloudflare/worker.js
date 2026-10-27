// Cloudflare Worker that relays requests to the Meta Model API.
// Calls from Render's free servers get an empty model list, while calls from Cloudflare work.
// It holds no Meta key: the caller sends its own Authorization header, plus x-relay-key,
// which must match the RELAY_KEY secret so the relay is useless to anyone else.
const UPSTREAM = "https://api.meta.ai";
const DROP = ["host", "x-relay-key", "x-forwarded-for", "x-forwarded-proto", "x-real-ip", "forwarded", "cf-connecting-ip", "true-client-ip"];

function sameKey(given, expected) {
  if (!given || !expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request, env) {
    if (!sameKey(request.headers.get("x-relay-key"), env.RELAY_KEY)) return new Response("Forbidden", { status: 403 });

    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v1/")) return new Response("Not found", { status: 404 });

    const headers = new Headers(request.headers);
    for (const h of DROP) headers.delete(h);

    return fetch(UPSTREAM + url.pathname + url.search, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
    });
  },
};
