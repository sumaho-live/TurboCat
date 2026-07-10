import { spawn } from "child_process";

export class CommandRunner {
  public static execute(
    command: string,
    args: string[],
    cwd: string,
    extraEnv?: Record<string, string>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        stdio: "pipe",
        shell: false,
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      });
      let stderr = "";
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr.trim() || `Command exited with code ${code}`));
        }
      });
      child.on("error", reject);
    });
  }
}
