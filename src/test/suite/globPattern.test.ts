import * as assert from "assert";
import { globToRegex } from "../../services/project/GlobPattern";

describe("GlobPattern", () => {
  it("matches root and nested files for a double-star pattern", () => {
    const pattern = new RegExp(`^${globToRegex("web/**/*", "linux")}$`);
    assert.strictEqual(pattern.test("web/index.jsp"), true);
    assert.strictEqual(pattern.test("web/assets/app.js"), true);
    assert.strictEqual(pattern.test("src/app.js"), false);
  });

  it("uses Windows path separators when requested", () => {
    const pattern = new RegExp(`^${globToRegex("target/**/*.class", "win32")}$`);
    assert.strictEqual(pattern.test("target\\App.class"), true);
    assert.strictEqual(pattern.test("target\\com\\example\\App.class"), true);
  });
});
