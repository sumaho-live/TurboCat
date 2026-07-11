import * as assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { EclipseMetadataParser } from "../../services/project/EclipseMetadataParser";

describe("EclipseMetadataParser", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "turbocat-eclipse-"));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("resolves relative and absolute classpath libraries", () => {
    const absolute = path.join(root, "external.jar");
    fs.writeFileSync(
      path.join(root, ".classpath"),
      `<classpath><classpathentry kind="lib" path="lib/local.jar"/><classpathentry kind="lib" path="${absolute}"/></classpath>`,
    );
    assert.deepStrictEqual(EclipseMetadataParser.parseClasspathLibraries(root), [
      path.join(root, "lib/local.jar"),
      absolute,
    ]);
  });

  it("parses custom output and source folders regardless of attribute order", () => {
    fs.writeFileSync(
      path.join(root, ".classpath"),
      `<classpath><classpathentry path="src" kind="src" output="build/source-classes"/><classpathentry path="build/eclipse-bin" kind="output"/><classpathentry path="lib/local.jar" kind="lib"/></classpath>`,
    );
    const metadata = EclipseMetadataParser.parseClasspath(root);
    assert.strictEqual(metadata.outputDirectory, "build/eclipse-bin");
    assert.deepStrictEqual(metadata.outputDirectories, [
      "build/source-classes",
      "build/eclipse-bin",
    ]);
    assert.deepStrictEqual(metadata.sourceRoots, ["src"]);
    assert.deepStrictEqual(metadata.libraries, [path.join(root, "lib/local.jar")]);
  });

  it("parses WTP roots, class resources, and dependencies", () => {
    const settings = path.join(root, ".settings");
    fs.mkdirSync(settings);
    fs.writeFileSync(
      path.join(settings, "org.eclipse.wst.common.component"),
      `<project-modules><wb-module deploy-name="sample"><wb-resource source-path="/WebContent" deploy-path="/"/><wb-resource source-path="/src" deploy-path="/WEB-INF/classes"/><dependent-module handle="lib/lib.jar" archive-name="lib.jar"/></wb-module></project-modules>`,
    );
    const result = EclipseMetadataParser.parseWtpComponent(root);
    assert.strictEqual(result?.webappName, "sample");
    assert.deepStrictEqual(result?.webResourceRoots, ["WebContent"]);
    assert.deepStrictEqual(result?.javaSourceRoots, ["src"]);
    assert.strictEqual(result?.additionalMappings[0].destination, "WEB-INF/lib/lib.jar");
  });

  it("returns safe empty values when metadata is absent", () => {
    assert.deepStrictEqual(EclipseMetadataParser.parseClasspathLibraries(root), []);
    assert.deepStrictEqual(
      EclipseMetadataParser.parseClasspath(root).outputDirectories,
      ["bin"],
    );
    assert.strictEqual(EclipseMetadataParser.parseWtpComponent(root), null);
  });
});
