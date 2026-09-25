import * as vscode from "vscode";

/** Subset of the redhat.java extension API that TurboCat relies on. */
interface JavaExtensionApi {
  status?: string;
  serverMode?: string;
  serverReady?: () => Promise<boolean>;
}

const JAVA_EXTENSION_ID = "redhat.java";
const STATUS_POLL_MS = 1000;

/**
 * Tracks whether the Java language server has finished starting. It compiles
 * the whole workspace while it starts, so smart deploy must wait for it.
 * One language server serves all workspace folders, so the state is shared.
 */
export class JavaReadiness {
  private static readyPromise?: Promise<boolean>;
  private static ready = false;

  /** True when the Java extension is absent or its server is ready. */
  public static isReady(): boolean {
    return this.ready || !vscode.extensions.getExtension(JAVA_EXTENSION_ID);
  }

  /**
   * Resolves true once the Java language server is ready (immediately when the
   * Java extension is not installed), or false if the extension fails to activate.
   */
  public static whenReady(): Promise<boolean> {
    if (!this.readyPromise) {
      this.readyPromise = this.waitForServer().then((ready) => {
        this.ready = ready;
        if (!ready) {
          // Allow a later attempt (e.g. after the user fixes the Java setup)
          this.readyPromise = undefined;
        }
        return ready;
      });
    }
    return this.readyPromise;
  }

  public static resetForTests(): void {
    this.readyPromise = undefined;
    this.ready = false;
  }

  private static async waitForServer(): Promise<boolean> {
    const extension = vscode.extensions.getExtension<JavaExtensionApi>(
      JAVA_EXTENSION_ID,
    );
    if (!extension) {
      return true;
    }

    let api: JavaExtensionApi | undefined;
    try {
      api = extension.isActive ? extension.exports : await extension.activate();
    } catch {
      return false;
    }
    if (!api) {
      return false;
    }

    if (typeof api.serverReady === "function") {
      // Resolves once the standard server has imported and built the projects;
      // in LightWeight mode it waits until the user switches to Standard.
      try {
        await api.serverReady();
        return true;
      } catch {
        return false;
      }
    }

    // Older API versions only expose a status string
    while (api.status !== "Started") {
      if (api.status === "Error") {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
    }
    return true;
  }
}
