import * as assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { DirectorySynchronizer } from "../../services/deployment/DirectorySynchronizer";

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
});
