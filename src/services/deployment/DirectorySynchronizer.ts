import fsp from "fs/promises";
import path from "path";

export interface DirectorySyncOptions {
  preserveRuntimeFolders?: boolean;
  onCleanupError?: (message: string) => void;
}

/** Mirrors one directory without blocking the VS Code extension host. */
export class DirectorySynchronizer {
  public static async sync(
    source: string,
    destination: string,
    options: DirectorySyncOptions = {},
  ): Promise<void> {
    const sourceEntries = await fsp.readdir(source, { withFileTypes: true });
    const keepers = new Set(sourceEntries.map((entry) => entry.name));
    const preserved = new Set(["classes", "lib"]);

    try {
      const destinationEntries = await fsp.readdir(destination, {
        withFileTypes: true,
      });
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    await fsp.mkdir(destination, { recursive: true });
    for (const entry of sourceEntries) {
      const sourcePath = path.join(source, entry.name);
      const destinationPath = path.join(destination, entry.name);
      if (entry.isDirectory()) {
        await this.sync(sourcePath, destinationPath, options);
      } else if (entry.isFile()) {
        await fsp.copyFile(sourcePath, destinationPath);
      }
    }
  }
}
