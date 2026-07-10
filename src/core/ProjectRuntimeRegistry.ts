import * as vscode from "vscode";
import { Builder } from "../services/Builder";
import { Tomcat } from "../services/Tomcat";
import { Logger } from "../services/Logger";
import { getActiveWorkspaceFolder } from "./workspace";

export interface ProjectRuntime {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly builder: Builder;
  readonly tomcat: Tomcat;
  readonly logger: Logger;
}

/** Owns one independent service graph for every Workspace Folder. */
export class ProjectRuntimeRegistry {
  private readonly runtimes = new Map<string, ProjectRuntime>();

  public constructor() {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      this.getOrCreate(folder);
    }
  }

  public getOrCreate(folder: vscode.WorkspaceFolder): ProjectRuntime {
    const key = folder.uri.toString();
    let runtime = this.runtimes.get(key);
    if (!runtime) {
      runtime = {
        workspaceFolder: folder,
        builder: Builder.getInstance(folder.uri),
        tomcat: Tomcat.getInstance(folder.uri),
        logger: Logger.getInstance(folder.uri),
      };
      this.runtimes.set(key, runtime);
    }
    return runtime;
  }

  public forResource(resource?: vscode.Uri): ProjectRuntime | undefined {
    const folder = getActiveWorkspaceFolder(resource);
    return folder ? this.getOrCreate(folder) : undefined;
  }

  public getAll(): readonly ProjectRuntime[] {
    return [...this.runtimes.values()];
  }

  public remove(folder: vscode.WorkspaceFolder): void {
    const runtime = this.runtimes.get(folder.uri.toString());
    if (runtime) {
      void runtime.tomcat.deactivate();
    }
    this.runtimes.delete(folder.uri.toString());
    Builder.removeInstance(folder.uri);
    Tomcat.removeInstance(folder.uri);
    Logger.removeInstance(folder.uri);
  }

  public async dispose(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      runtime.builder.disposeSmartDeploy();
      await runtime.tomcat.deactivate();
      runtime.logger.releaseRuntime();
    }
    this.runtimes.clear();
  }
}
