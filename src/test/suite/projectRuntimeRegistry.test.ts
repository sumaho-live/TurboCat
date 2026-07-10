import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as sinon from "sinon";
import * as vscode from "vscode";
import { ProjectRuntimeRegistry } from "../../core/ProjectRuntimeRegistry";
import { Builder } from "../../services/Builder";
import { Tomcat } from "../../services/Tomcat";
import { Logger } from "../../services/Logger";

describe("ProjectRuntimeRegistry", () => {
  let sandbox: sinon.SinonSandbox;
  let roots: string[];

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    roots = [
      fs.mkdtempSync(path.join(os.tmpdir(), "turbocat-project-a-")),
      fs.mkdtempSync(path.join(os.tmpdir(), "turbocat-project-b-")),
    ];
    const folders = roots.map((root, index) => ({
      uri: vscode.Uri.file(root),
      name: path.basename(root),
      index,
    }));
    sandbox.stub(vscode.workspace, "workspaceFolders").value(folders);
    Builder.clearInstancesForTests();
    Tomcat.clearInstancesForTests();
    Logger.clearInstancesForTests();
  });

  afterEach(() => {
    Builder.clearInstancesForTests();
    Tomcat.clearInstancesForTests();
    Logger.clearInstancesForTests();
    sandbox.restore();
    roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
  });

  it("creates independent Tomcat and Builder instances per folder", () => {
    const registry = new ProjectRuntimeRegistry();
    const [first, second] = registry.getAll();

    assert.strictEqual(registry.getAll().length, 2);
    assert.notStrictEqual(first.tomcat, second.tomcat);
    assert.notStrictEqual(first.builder, second.builder);
    assert.notStrictEqual(first.logger, second.logger);
    assert.strictEqual(first.workspaceFolder.uri.fsPath, roots[0]);
    assert.strictEqual(second.workspaceFolder.uri.fsPath, roots[1]);
  });

  it("routes a resource to its owning project", () => {
    const registry = new ProjectRuntimeRegistry();
    const nestedResource = vscode.Uri.file(path.join(roots[1], "src", "App.java"));

    const runtime = registry.forResource(nestedResource);

    assert.strictEqual(runtime?.workspaceFolder.uri.fsPath, roots[1]);
  });

  it("recreates a clean runtime after a folder is removed", () => {
    const registry = new ProjectRuntimeRegistry();
    const original = registry.getAll()[0];

    registry.remove(original.workspaceFolder);
    const recreated = registry.getOrCreate(original.workspaceFolder);

    assert.notStrictEqual(recreated.builder, original.builder);
    assert.notStrictEqual(recreated.tomcat, original.tomcat);
    assert.notStrictEqual(recreated.logger, original.logger);
  });
});
