import * as crypto from "crypto";
import fsp from "fs/promises";
import path from "path";
import { getActiveWorkspaceFolder } from "../core/workspace";

export interface TomcatProcessRecord {
  version: 1;
  pid: number;
  workspaceUri: string;
  catalinaHome: string;
  catalinaBase: string;
  httpPort: number;
  shutdownPort: number;
  mode: "run" | "debug";
  sessionId: string;
  startedAt: string;
}

/** Persists enough identity to ensure one project never terminates another. */
export class ProcessOwnership {
  private readonly sessionId = crypto.randomUUID();

  private getRecordPath(catalinaBase: string): string {
    return path.join(catalinaBase, ".turbocat-runtime.json");
  }

  public async record(
    data: Omit<TomcatProcessRecord, "version" | "sessionId" | "startedAt">,
  ): Promise<TomcatProcessRecord> {
    const record: TomcatProcessRecord = {
      ...data,
      version: 1,
      sessionId: this.sessionId,
      startedAt: new Date().toISOString(),
    };
    await fsp.writeFile(
      this.getRecordPath(data.catalinaBase),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );
    return record;
  }

  public async read(catalinaBase: string): Promise<TomcatProcessRecord | null> {
    try {
      const parsed = JSON.parse(
        await fsp.readFile(this.getRecordPath(catalinaBase), "utf8"),
      ) as Partial<TomcatProcessRecord>;
      if (
        parsed.version !== 1 ||
        typeof parsed.pid !== "number" ||
        typeof parsed.workspaceUri !== "string" ||
        typeof parsed.catalinaBase !== "string"
      ) {
        return null;
      }
      return parsed as TomcatProcessRecord;
    } catch {
      return null;
    }
  }

  public isCurrentWorkspaceOwner(
    record: TomcatProcessRecord,
    catalinaBase: string,
    workspaceUri = getActiveWorkspaceFolder()?.uri.toString(),
  ): boolean {
    return Boolean(
      workspaceUri &&
        record.workspaceUri === workspaceUri &&
        path.resolve(record.catalinaBase) === path.resolve(catalinaBase),
    );
  }

  public isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  public async removeIfOwned(
    catalinaBase: string,
    pid?: number,
    workspaceUri = getActiveWorkspaceFolder()?.uri.toString(),
  ): Promise<void> {
    const record = await this.read(catalinaBase);
    if (
      !record ||
      !this.isCurrentWorkspaceOwner(record, catalinaBase, workspaceUri) ||
      (pid !== undefined && record.pid !== pid)
    ) {
      return;
    }
    await fsp.rm(this.getRecordPath(catalinaBase), { force: true });
  }
}
