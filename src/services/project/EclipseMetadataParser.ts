import fs from "fs";
import path from "path";

export interface EclipseDeployMapping {
  source: string;
  destination: string;
  description?: string;
  enabled?: boolean;
  needsReload?: boolean;
}

export interface EclipseWtpComponent {
  webappName: string;
  webResourceRoots: string[];
  javaSourceRoots: string[];
  additionalMappings: EclipseDeployMapping[];
}

export interface EclipseClasspathMetadata {
  libraries: string[];
  sourceRoots: string[];
  outputDirectory: string;
  outputDirectories: string[];
}

export class EclipseMetadataParser {
  private static parseAttributes(fragment: string): Record<string, string> {
    const attributes: Record<string, string> = {};
    const attribute = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let match: RegExpExecArray | null;
    while ((match = attribute.exec(fragment)) !== null) {
      attributes[match[1]] = match[2] ?? match[3] ?? "";
    }
    return attributes;
  }

  public static parseClasspath(projectDir: string): EclipseClasspathMetadata {
    const result: EclipseClasspathMetadata = {
      libraries: [],
      sourceRoots: [],
      outputDirectory: "bin",
      outputDirectories: [],
    };
    let defaultOutput: string | undefined;
    try {
      const xml = fs.readFileSync(path.join(projectDir, ".classpath"), "utf8");
      const entry = /<classpathentry\b([^>]*)\/?\s*>/gi;
      let match: RegExpExecArray | null;
      while ((match = entry.exec(xml)) !== null) {
        const attributes = this.parseAttributes(match[1]);
        const entryPath = (attributes.path ?? "").trim().replace(/^\/+/, "");
        if (!entryPath) {
          continue;
        }
        if (attributes.kind === "lib") {
          result.libraries.push(
            path.isAbsolute(attributes.path)
              ? attributes.path
              : path.join(projectDir, entryPath),
          );
        } else if (attributes.kind === "src") {
          result.sourceRoots.push(entryPath);
          if (attributes.output?.trim()) {
            result.outputDirectories.push(
              attributes.output.trim().replace(/^\/+/, ""),
            );
          }
        } else if (attributes.kind === "output") {
          defaultOutput = entryPath;
          result.outputDirectories.push(entryPath);
        }
      }
    } catch {
      // Defaults describe the conventional Eclipse project layout.
    }
    result.outputDirectories = [...new Set(result.outputDirectories)];
    result.outputDirectory =
      defaultOutput ?? result.outputDirectories[0] ?? "bin";
    if (!result.outputDirectories.length) {
      result.outputDirectories.push(result.outputDirectory);
    }
    return result;
  }

  public static parseClasspathLibraries(projectDir: string): string[] {
    return this.parseClasspath(projectDir).libraries;
  }

  public static parseWtpComponent(
    workspaceRoot: string,
  ): EclipseWtpComponent | null {
    try {
      const xml = fs.readFileSync(
        path.join(
          workspaceRoot,
          ".settings",
          "org.eclipse.wst.common.component",
        ),
        "utf8",
      );
      const result: EclipseWtpComponent = {
        webappName: path.basename(workspaceRoot),
        webResourceRoots: [],
        javaSourceRoots: [],
        additionalMappings: [],
      };

      const module = xml.match(/<wb-module\b([^>]*)>/i);
      const moduleAttributes = this.parseAttributes(module?.[1] ?? "");
      if (moduleAttributes["deploy-name"]?.trim()) {
        result.webappName = moduleAttributes["deploy-name"].trim();
      }

      const resource = /<wb-resource\b([^>]*)\/?\s*>/gi;
      let match: RegExpExecArray | null;
      while ((match = resource.exec(xml)) !== null) {
        const attributes = this.parseAttributes(match[1]);
        const deployPath = (attributes["deploy-path"] ?? "").trim();
        const sourcePath = (attributes["source-path"] ?? "")
          .trim()
          .replace(/^\/+/, "");
        if (!deployPath || !sourcePath) {
          continue;
        }
        if (deployPath === "/") {
          result.webResourceRoots.push(sourcePath);
        } else if (deployPath.startsWith("/WEB-INF/classes")) {
          result.javaSourceRoots.push(sourcePath);
        } else {
          result.additionalMappings.push({
            source: sourcePath,
            destination: deployPath.replace(/^\/+/, ""),
            description: `Eclipse WTP: ${sourcePath} → ${deployPath}`,
            enabled: true,
            needsReload: false,
          });
        }
      }

      const dependency = /<dependent-module\b([^>]*)\/?\s*>/gi;
      while ((match = dependency.exec(xml)) !== null) {
        const attributes = this.parseAttributes(match[1]);
        const archiveName = (attributes["archive-name"] ?? "").trim();
        const handle = (attributes.handle ?? "").trim();
        if (!archiveName || !handle) {
          continue;
        }
        result.additionalMappings.push({
          source: handle,
          destination: `WEB-INF/lib/${archiveName}`,
          description: `Eclipse WTP library: ${archiveName}`,
          enabled: true,
          needsReload: false,
        });
      }
      return result;
    } catch {
      return null;
    }
  }
}
