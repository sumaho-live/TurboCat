import * as vscode from "vscode";

/**
 * Resolve the workspace folder that owns the current user interaction.
 *
 * In a multi-root workspace the active editor is the least surprising source
 * of project context. Callers may pass a URI when a command or event already
 * provides one. The first folder is retained only as a compatibility fallback.
 */
export function getActiveWorkspaceFolder(
  resource?: vscode.Uri,
): vscode.WorkspaceFolder | undefined {
  if (resource) {
    const resourceFolder = vscode.workspace.getWorkspaceFolder(resource);
    if (resourceFolder) {
      return resourceFolder;
    }

    const resourceKey = resource.toString();
    const matchingFolder = [...(vscode.workspace.workspaceFolders ?? [])]
      .filter((folder) => {
        const folderKey = folder.uri.toString().replace(/\/$/, "");
        return resourceKey === folderKey || resourceKey.startsWith(`${folderKey}/`);
      })
      .sort(
        (left, right) =>
          right.uri.toString().length - left.uri.toString().length,
      )[0];
    if (matchingFolder) {
      return matchingFolder;
    }
  }

  const activeResource = vscode.window.activeTextEditor?.document.uri;
  if (activeResource) {
    const activeFolder = vscode.workspace.getWorkspaceFolder(activeResource);
    if (activeFolder) {
      return activeFolder;
    }
  }

  return vscode.workspace.workspaceFolders?.[0];
}

export function getWorkspaceConfiguration(
  section = "turbocat",
  resource?: vscode.Uri,
): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(
    section,
    getActiveWorkspaceFolder(resource)?.uri,
  );
}
