import * as assert from "assert";
import { CommandRunner } from "../../services/build/CommandRunner";

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
});
