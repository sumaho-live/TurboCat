import * as assert from "assert";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import {
  KeyedDebouncer,
  collapseWatchRoots,
  copyFileWithRetry,
  isTransientLockError,
} from "../../services/deployment/SmartDeployCoordinator";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SmartDeployCoordinator", () => {
  describe("collapseWatchRoots()", () => {
    it("drops roots nested inside another root", () => {
      assert.deepStrictEqual(
        collapseWatchRoots(["src/main/webapp", "src/main/resources", "src"]),
        ["src"],
      );
    });

    it("normalizes separators and keeps sibling roots", () => {
      assert.deepStrictEqual(
        collapseWatchRoots(["WebContent\\", "/src", "src2", "src/x", "a/*"]),
        ["src", "src2", "WebContent"],
      );
    });
  });

  describe("KeyedDebouncer", () => {
    it("collapses bursts for one key into a single run", async () => {
      const debouncer = new KeyedDebouncer();
      let runs = 0;
      for (let i = 0; i < 5; i++) {
        debouncer.schedule("a", 20, async () => { runs++; });
      }
      await wait(60);
      assert.strictEqual(runs, 1);
    });

    it("never runs the same key concurrently", async () => {
      const debouncer = new KeyedDebouncer();
      let active = 0;
      let maxActive = 0;
      const task = async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await wait(40);
        active--;
      };
      debouncer.schedule("a", 5, task);
      await wait(15);
      debouncer.schedule("a", 5, task);
      await wait(120);
      assert.strictEqual(maxActive, 1);
    });

    it("cancels pending runs on dispose", async () => {
      const debouncer = new KeyedDebouncer();
      let runs = 0;
      debouncer.schedule("a", 20, async () => { runs++; });
      debouncer.dispose();
      await wait(40);
      assert.strictEqual(runs, 0);
    });
  });

  describe("copyFileWithRetry()", () => {
    let root: string;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "turbocat-copy-")); });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it("retries transient lock errors and then succeeds", async () => {
      const source = path.join(root, "a.jsp");
      const target = path.join(root, "b.jsp");
      fs.writeFileSync(source, "ok");
      const original = fsp.copyFile;
      let calls = 0;
      (fsp as { copyFile: typeof fsp.copyFile }).copyFile = (async (...args: Parameters<typeof fsp.copyFile>) => {
        calls++;
        if (calls < 3) {
          throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
        }
        return original(...args);
      }) as typeof fsp.copyFile;
      try {
        await copyFileWithRetry(source, target, { delayMs: 1 });
      } finally {
        (fsp as { copyFile: typeof fsp.copyFile }).copyFile = original;
      }
      assert.strictEqual(calls, 3);
      assert.strictEqual(fs.readFileSync(target, "utf8"), "ok");
    });

    it("does not retry non-lock errors", async () => {
      await assert.rejects(
        copyFileWithRetry(path.join(root, "missing"), path.join(root, "x"), { delayMs: 1 }),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
      assert.strictEqual(isTransientLockError({ code: "EPERM" }), true);
      assert.strictEqual(isTransientLockError({ code: "ENOENT" }), false);
    });
  });
});
