import { execFile } from "child_process";
import * as crypto from "crypto";
import fsp from "fs/promises";
import path from "path";
import { promisify } from "util";
import { getActiveWorkspaceFolder } from "../core/workspace";

const execFileAsync = promisify(execFile);

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

  /** Command line of a live process, or null when it cannot be determined. */
  public async readCommandLine(pid: number): Promise<string | null> {
    try {
      if (process.platform === "linux") {
        const raw = await fsp.readFile(`/proc/${pid}/cmdline`, "utf8");
        return raw.replace(/\0/g, " ").trim() || null;
      }
      if (process.platform === "win32") {
        const { stdout } = await execFileAsync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
          ],
          { windowsHide: true },
        );
        return stdout.trim() || null;
      }
      const { stdout } = await execFileAsync("ps", [
        "-ww",
        "-o",
        "command=",
        "-p",
        String(pid),
      ]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * True only when the recorded PID is alive AND still runs Tomcat for the
   * recorded CATALINA_BASE. A PID left behind by a crash or reboot may have
   * been reused by an unrelated process, which must never be killed.
   */
  public async isRecordedTomcatAlive(
    record: TomcatProcessRecord,
  ): Promise<boolean> {
    if (!this.isProcessAlive(record.pid)) {
      return false;
    }
    const commandLine = await this.readCommandLine(record.pid);
    if (!commandLine) {
      return false;
    }
    const marker = `-Dcatalina.base=${record.catalinaBase}`;
    return process.platform === "win32"
      ? commandLine.toLowerCase().includes(marker.toLowerCase())
      : commandLine.includes(marker);
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
