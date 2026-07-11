import * as assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { ProjectDetector } from "../../services/project/ProjectDetector";

describe("ProjectDetector", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "turbocat-detector-"));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("detects Maven WAR packaging with whitespace", () => {
    fs.writeFileSync(
      path.join(root, "pom.xml"),
      "<project><packaging> war </packaging></project>",
    );
    assert.strictEqual(ProjectDetector.isJavaWebProject(root), true);
  });

  it("detects Gradle Kotlin WAR projects", () => {
    fs.writeFileSync(path.join(root, "build.gradle.kts"), "plugins { war }");
    assert.strictEqual(ProjectDetector.isJavaWebProject(root), true);
  });

  it("detects a pure Eclipse WTP project without a pom", () => {
    fs.writeFileSync(path.join(root, ".classpath"), "<classpath />");
    fs.mkdirSync(path.join(root, ".settings"));
    fs.writeFileSync(
      path.join(root, ".settings", "org.eclipse.wst.common.component"),
      "<project-modules />",
    );
    assert.strictEqual(ProjectDetector.isJavaWebProject(root), true);
  });

  it("does not classify an unrelated Java project as a web project", () => {
    fs.writeFileSync(path.join(root, "build.gradle"), "plugins { java }");
    assert.strictEqual(ProjectDetector.isJavaWebProject(root), false);
  });
});
