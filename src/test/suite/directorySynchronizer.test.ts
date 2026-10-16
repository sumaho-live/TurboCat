import * as assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import {
  DirectorySynchronizer,
  runWithConcurrency,
} from "../../services/deployment/DirectorySynchronizer";

describe("DirectorySynchronizer", () => {
  let root: string;
  let source: string;
  let destination: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "turbocat-sync-"));
    source = path.join(root, "source");
    destination = path.join(root, "destination");
    fs.mkdirSync(path.join(source, "nested"), { recursive: true });
    fs.writeFileSync(path.join(source, "nested", "app.js"), "new");
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("copies source files and removes orphaned destination files", async () => {
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, "orphan.txt"), "old");

    await DirectorySynchronizer.sync(source, destination);

    assert.strictEqual(fs.readFileSync(path.join(destination, "nested", "app.js"), "utf8"), "new");
    assert.strictEqual(fs.existsSync(path.join(destination, "orphan.txt")), false);
  });

  it("preserves Tomcat runtime folders in restricted mode", async () => {
    fs.mkdirSync(path.join(destination, "classes"), { recursive: true });
    fs.writeFileSync(path.join(destination, "classes", "App.class"), "compiled");

    await DirectorySynchronizer.sync(source, destination, {
      preserveRuntimeFolders: true,
    });

    assert.strictEqual(fs.existsSync(path.join(destination, "classes", "App.class")), true);
  });

  it("merges multiple WTP resource roots before pruning the destination", async () => {
    const second = path.join(root, "second");
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(source, "index.jsp"), "page");
    fs.writeFileSync(path.join(second, "app.properties"), "value=1");

    await DirectorySynchronizer.syncAll([source, second], destination);

    assert.strictEqual(fs.existsSync(path.join(destination, "index.jsp")), true);
    assert.strictEqual(fs.existsSync(path.join(destination, "app.properties")), true);
  });

  it("skips files whose size and mtime already match", async () => {
    await DirectorySynchronizer.sync(source, destination);
    const deployed = path.join(destination, "nested", "app.js");
    const { mtimeMs } = fs.statSync(deployed);
    // Same size and mtime, different bytes: proves the second sync did not copy
    fs.writeFileSync(deployed, "xxx");
    fs.utimesSync(deployed, mtimeMs / 1000, mtimeMs / 1000);

    await DirectorySynchronizer.sync(source, destination);

    assert.strictEqual(fs.readFileSync(deployed, "utf8"), "xxx");
  });

  it("copies changed files and carries over the source mtime", async () => {
    await DirectorySynchronizer.sync(source, destination);
    const sourceFile = path.join(source, "nested", "app.js");
    fs.writeFileSync(sourceFile, "newer content");
    const stamp = new Date("2026-01-02T03:04:05Z");
    fs.utimesSync(sourceFile, stamp, stamp);

    await DirectorySynchronizer.sync(source, destination);

    const deployed = path.join(destination, "nested", "app.js");
    assert.strictEqual(fs.readFileSync(deployed, "utf8"), "newer content");
    assert.strictEqual(fs.statSync(deployed).mtimeMs, stamp.getTime());
  });

  it("lets later roots win when merging without a staging directory", async () => {
    const second = path.join(root, "second");
    fs.mkdirSync(path.join(second, "nested"), { recursive: true });
    fs.writeFileSync(path.join(second, "nested", "app.js"), "override");
    fs.writeFileSync(path.join(second, "nested", "extra.js"), "extra");
    const stagingBefore = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith("turbocat-sync-")).length;

    await DirectorySynchronizer.syncAll([source, second], destination);

    assert.strictEqual(
      fs.readFileSync(path.join(destination, "nested", "app.js"), "utf8"),
      "override",
    );
    assert.strictEqual(fs.existsSync(path.join(destination, "nested", "extra.js")), true);
    const stagingAfter = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith("turbocat-sync-")).length;
    assert.strictEqual(stagingAfter, stagingBefore);
  });

  it("runs every task with bounded concurrency", async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];

    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      done.push(item);
      active--;
    });

    assert.strictEqual(peak, 3);
    assert.deepStrictEqual(done.sort(), [1, 2, 3, 4, 5, 6, 7]);
  });
});
