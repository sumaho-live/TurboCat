import fsp from "fs/promises";

/** Error codes that indicate a transient lock (editor still writing, Tomcat/AV reading). */
const TRANSIENT_LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES", "EAGAIN"]);

export function isTransientLockError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && TRANSIENT_LOCK_CODES.has(code);
}

/**
 * Reduce watch roots to the outermost directories so that one file is never
 * covered by two watchers (e.g. `src` already contains `src/main/webapp`).
 */
export function collapseWatchRoots(roots: Iterable<string>): string[] {
  const normalized = new Set<string>();
  for (const root of roots) {
    const value = (root ?? "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    if (value && !value.includes("*")) {
      normalized.add(value);
    }
  }

  const sorted = [...normalized].sort((a, b) => a.length - b.length);
  const result: string[] = [];
  for (const candidate of sorted) {
    const covered = result.some(
      (parent) => candidate === parent || candidate.startsWith(`${parent}/`),
    );
    if (!covered) {
      result.push(candidate);
    }
  }
  return result;
}

/** Copy a file, retrying while the source or target is briefly locked. */
export async function copyFileWithRetry(
  source: string,
  target: string,
  options: { retries?: number; delayMs?: number } = {},
): Promise<void> {
  const retries = options.retries ?? 5;
  const delayMs = options.delayMs ?? 100;
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.copyFile(source, target);
      return;
    } catch (error) {
      if (attempt >= retries || !isTransientLockError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
}

/**
 * Per-key debouncer that also serializes execution: events for the same key
 * collapse into one run, and a key never runs concurrently with itself.
 */
export class KeyedDebouncer {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<void>>();

  public schedule(key: string, delayMs: number, task: () => Promise<void>): void {
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        const previous = this.running.get(key) ?? Promise.resolve();
        const next: Promise<void> = previous
          .then(task)
          .catch(() => undefined)
          .finally(() => {
            if (this.running.get(key) === next) {
              this.running.delete(key);
            }
          });
        this.running.set(key, next);
      }, delayMs),
    );
  }

  public get pendingCount(): number {
    return this.timers.size;
  }

  public dispose(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
  }
}
