const TRANSIENT = new Set(["EAI_AGAIN", "ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

function isTransient(err: unknown): boolean {
  const code = (err as any)?.cause?.code ?? (err as any)?.code;
  return TRANSIENT.has(code);
}

/**
 * fetch with retries on network-level failures only (DNS blips, dropped sockets).
 * HTTP error statuses are returned as-is for the caller to handle.
 */
export async function fetchRetry(url: string, init?: RequestInit, attempts = 3): Promise<Response> {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (i >= attempts || !isTransient(err)) throw err;
      await new Promise((r) => setTimeout(r, 400 * 2 ** (i - 1)));
    }
  }
}
