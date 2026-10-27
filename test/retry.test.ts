import { describe, expect, it, vi } from "vitest";
import { retryModelNotFound } from "../src/ai/client.js";

const notFound = () => Object.assign(new Error("404 The requested model was not found."), { status: 404, code: "model_not_found" });

describe("retryModelNotFound", () => {
  it("retries a model_not_found until it succeeds", async () => {
    const fn = vi.fn().mockRejectedValueOnce(notFound()).mockRejectedValueOnce(notFound()).mockResolvedValue("ok");
    await expect(retryModelNotFound(fn, 4, 1)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after the last attempt", async () => {
    const fn = vi.fn().mockRejectedValue(notFound());
    await expect(retryModelNotFound(fn, 3, 1)).rejects.toThrow(/not found/);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry other errors", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("bad request"), { status: 400 }));
    await expect(retryModelNotFound(fn, 4, 1)).rejects.toThrow(/bad request/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
