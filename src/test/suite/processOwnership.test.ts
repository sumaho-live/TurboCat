import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ProcessOwnership } from "../../services/ProcessOwnership";

describe("Tomcat process ownership", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "turbocat-owner-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("persists the workspace and process identity", async () => {
    const ownership = new ProcessOwnership();
    const workspaceUri = "file:///test/project-a";

    const written = await ownership.record({
      pid: process.pid,
      workspaceUri,
      catalinaHome: path.join(tempRoot, "home"),
      catalinaBase: tempRoot,
      httpPort: 8080,
      shutdownPort: 8005,
      mode: "run",
    });
    const read = await ownership.read(tempRoot);

    assert.deepStrictEqual(read, written);
    assert.strictEqual(
      ownership.isCurrentWorkspaceOwner(written, tempRoot, workspaceUri),
      true,
    );
    assert.strictEqual(ownership.isProcessAlive(process.pid), true);
  });

  it("does not remove a record for a different pid", async () => {
    const ownership = new ProcessOwnership();
    const workspaceUri = "file:///test/project-b";
    await ownership.record({
      pid: process.pid,
      workspaceUri,
      catalinaHome: path.join(tempRoot, "home"),
      catalinaBase: tempRoot,
      httpPort: 8080,
      shutdownPort: 8005,
      mode: "debug",
    });

    await ownership.removeIfOwned(tempRoot, process.pid + 1, workspaceUri);
    assert.ok(await ownership.read(tempRoot));
  });
});
