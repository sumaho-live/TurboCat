import * as assert from "assert";
import {
  buildSpawnInvocation,
  CommandRunner,
} from "../../services/build/CommandRunner";

describe("CommandRunner", () => {
  it("passes arguments containing spaces without a shell", async () => {
    await CommandRunner.execute(
      process.execPath,
      ["-e", "if (process.argv[1] !== 'hello world') process.exit(2)", "hello world"],
      process.cwd(),
    );
  });

  it("reports stderr for a failed spawned command", async () => {
    await assert.rejects(
      CommandRunner.execute(
        process.execPath,
        ["-e", "console.error('expected failure'); process.exit(3)"],
        process.cwd(),
      ),
      /expected failure/,
    );
  });

  it("passes explicit environment variables", async () => {
    await CommandRunner.execute(
      process.execPath,
      ["-e", "if (process.env.TURBOCAT_TEST !== 'ok') process.exit(4)"],
      process.cwd(),
      { TURBOCAT_TEST: "ok" },
    );
  });

  it("drains large stdout without blocking the child", async () => {
    await CommandRunner.execute(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(4 * 1024 * 1024))"],
      process.cwd(),
    );
  });

  it("reports stdout for a failed command (Maven prints [ERROR] to stdout)", async () => {
    await assert.rejects(
      CommandRunner.execute(
        process.execPath,
        ["-e", "console.log('[ERROR] compile failed'); process.exit(1)"],
        process.cwd(),
      ),
      /\[ERROR\] compile failed/,
    );
  });
});

describe("buildSpawnInvocation", () => {
  it("spawns directly outside Windows", () => {
    assert.deepStrictEqual(buildSpawnInvocation("./gradlew", ["war"], "linux"), {
      command: "./gradlew",
      args: ["war"],
      windowsVerbatimArguments: false,
    });
  });

  it("spawns .exe directly on Windows", () => {
    const invocation = buildSpawnInvocation("C:\\jdk\\bin\\javac.exe", ["-d", "out"], "win32");
    assert.strictEqual(invocation.command, "C:\\jdk\\bin\\javac.exe");
    assert.strictEqual(invocation.windowsVerbatimArguments, false);
  });

  it("routes .cmd, .bat and bare commands through cmd.exe on Windows", () => {
    for (const command of ["mvn", "C:\\maven\\bin\\mvn.cmd", "gradlew.bat"]) {
      const invocation = buildSpawnInvocation(command, ["clean"], "win32", "cmd.exe");
      assert.strictEqual(invocation.command, "cmd.exe");
      assert.deepStrictEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
      assert.strictEqual(invocation.windowsVerbatimArguments, true);
    }
  });

  it("escapes spaces, quotes and cmd metacharacters on Windows", () => {
    const invocation = buildSpawnInvocation(
      "C:\\Program Files\\maven\\bin\\mvn.cmd",
      ["-PfinalName=a&b", 'say "hi"'],
      "win32",
      "cmd.exe",
    );
    assert.strictEqual(
      invocation.args[3],
      '"C:\\Program^ Files\\maven\\bin\\mvn.cmd ^"-PfinalName=a^&b^" ^"say^ \\^"hi\\^"^""',
    );
  });
});
