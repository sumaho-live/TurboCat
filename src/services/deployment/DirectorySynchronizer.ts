import fsp from "fs/promises";
import path from "path";

export interface DirectorySyncOptions {
  preserveRuntimeFolders?: boolean;
  pruneDestination?: boolean;
  onCleanupError?: (message: string) => void;
}

/** Number of file copies a sync runs at the same time. */
export const COPY_CONCURRENCY = 8;

/** Run `task` for every item with at most `limit` tasks in flight. */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        await task(items[next++]);
      }
    },
  );
  await Promise.all(workers);
}

type LayerEntry =
  | { kind: "file"; path: string }
  | { kind: "directory"; paths: string[] };

/** Mirrors one directory without blocking the VS Code extension host. */
export class DirectorySynchronizer {
  public static async sync(
    source: string,
    destination: string,
    options: DirectorySyncOptions = {},
  ): Promise<void> {
    await this.syncLayers([source], destination, options);
  }

  /**
   * Merge multiple Eclipse/WTP resource roots and clean-sync them once.
   * Later sources win when the same file exists in several roots.
   */
  public static async syncAll(
    sources: string[],
    destination: string,
    options: DirectorySyncOptions = {},
  ): Promise<void> {
    await this.syncLayers(sources, destination, options);
  }

  private static async syncLayers(
    sources: string[],
    destination: string,
    options: DirectorySyncOptions,
  ): Promise<void> {
    const merged = new Map<string, LayerEntry>();
    for (const source of sources) {
      const entries = await fsp.readdir(source, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(source, entry.name);
        const existing = merged.get(entry.name);
        if (entry.isDirectory()) {
          if (existing?.kind === "directory") {
            existing.paths.push(entryPath);
          } else {
            merged.set(entry.name, { kind: "directory", paths: [entryPath] });
          }
        } else if (entry.isFile()) {
          merged.set(entry.name, { kind: "file", path: entryPath });
        }
      }
    }

    if (options.pruneDestination !== false) {
      await this.pruneDestination(destination, merged, options);
    }

    await fsp.mkdir(destination, { recursive: true });

    const files: Array<[string, string]> = [];
    for (const [name, entry] of merged) {
      const destinationPath = path.join(destination, name);
      if (entry.kind === "directory") {
        await this.syncLayers(entry.paths, destinationPath, options);
      } else {
        files.push([entry.path, destinationPath]);
      }
    }

    await runWithConcurrency(files, COPY_CONCURRENCY, ([from, to]) =>
      this.copyIfChanged(from, to),
    );
  }

  private static async pruneDestination(
    destination: string,
    keepers: ReadonlyMap<string, LayerEntry>,
    options: DirectorySyncOptions,
  ): Promise<void> {
    const preserved = new Set(["classes", "lib"]);
    let destinationEntries;
    try {
      destinationEntries = await fsp.readdir(destination, {
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of destinationEntries) {
      if (
        !keepers.has(entry.name) &&
        (!options.preserveRuntimeFolders || !preserved.has(entry.name))
      ) {
        const target = path.join(destination, entry.name);
        try {
          await fsp.rm(target, { recursive: true, force: true });
        } catch (error) {
          options.onCleanupError?.(`Failed to clean ${target}: ${error}`);
        }
      }
    }
  }

  /**
   * Copy unless the destination already has the same size and modification
   * time. The source mtime is carried over so the next sync can skip it, and
   * Tomcat only sees files that really changed.
   */
  private static async copyIfChanged(
    source: string,
    destination: string,
  ): Promise<void> {
    const sourceStats = await fsp.stat(source);
    try {
      const destinationStats = await fsp.stat(destination);
      if (
        destinationStats.isFile() &&
        destinationStats.size === sourceStats.size &&
        // utimes keeps sub-millisecond precision only approximately
        Math.abs(destinationStats.mtimeMs - sourceStats.mtimeMs) < 1
      ) {
        return;
      }
    } catch {
      // Destination missing: copy below
    }
    await fsp.copyFile(source, destination);
    await fsp.utimes(destination, sourceStats.atime, sourceStats.mtime);
  }
}
