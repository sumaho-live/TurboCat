import { spawn } from "child_process";

/** Keep only the tail of long build logs; errors are reported at the end. */
const MAX_CAPTURED_OUTPUT = 512 * 1024;

// cmd.exe metacharacters, escaped with ^ (same rules as cross-spawn)
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

export interface SpawnInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

function escapeCmdArgument(arg: string): string {
  const quoted = arg
    // Double backslashes before a quote, then escape the quote
    .replace(/(\\*)"/g, '$1$1\\"')
    // Double trailing backslashes so they don't escape the closing quote
    .replace(/(\\*)$/, "$1$1");
  return `"${quoted}"`.replace(CMD_META_CHARS, "^$1");
}

/**
 * Node refuses to spawn .cmd/.bat files without a shell (CVE-2024-27980) and
 * does not apply PATHEXT, so `mvn` / `mvn.cmd` / `gradlew.bat` must go through
 * cmd.exe on Windows. Arguments are escaped instead of using `shell: true`.
 */
export function buildSpawnInvocation(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string = process.env.ComSpec || "cmd.exe",
): SpawnInvocation {
  const needsCmd =
    platform === "win32" && !/\.(exe|com)$/i.test(command);
  if (!needsCmd) {
    return { command, args, windowsVerbatimArguments: false };
  }
  const commandLine = [
    command.replace(CMD_META_CHARS, "^$1"),
    ...args.map(escapeCmdArgument),
  ].join(" ");
  return {
    command: comspec,
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

export class CommandRunner {
  public static execute(
    command: string,
    args: string[],
    cwd: string,
    extraEnv?: Record<string, string>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const invocation = buildSpawnInvocation(command, args);
      const child = spawn(invocation.command, invocation.args, {
        cwd,
        stdio: "pipe",
        shell: false,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      });
      // Both streams must be drained, otherwise a chatty build (Maven) fills
      // the pipe and blocks forever. Maven prints [ERROR] lines to stdout.
      let output = "";
      const capture = (data: Buffer) => {
        output += data.toString();
        if (output.length > MAX_CAPTURED_OUTPUT) {
          output = output.slice(-MAX_CAPTURED_OUTPUT);
        }
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(output.trim() || `Command exited with code ${code}`));
        }
      });
      child.on("error", reject);
    });
  }
}
