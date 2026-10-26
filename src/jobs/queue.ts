import PQueue from "p-queue";

/**
 * One queue per user so a user's messages are handled in the order sent,
 * plus a global cap so a burst cannot open dozens of model calls at once.
 */
const global = new PQueue({ concurrency: 4 });
const perUser = new Map<string, PQueue>();

export function enqueueForUser(userKey: string, job: () => Promise<void>): void {
  let q = perUser.get(userKey);
  if (!q) {
    q = new PQueue({ concurrency: 1 });
    perUser.set(userKey, q);
    q.addEventListener("idle", () => {
      if (q!.size === 0 && q!.pending === 0) perUser.delete(userKey);
    });
  }
  void q.add(() => global.add(job));
}
