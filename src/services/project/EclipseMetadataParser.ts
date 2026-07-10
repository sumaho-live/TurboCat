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

export class EclipseMetadataParser {
  public static parseClasspathLibraries(projectDir: string): string[] {
    try {
      const xml = fs.readFileSync(path.join(projectDir, ".classpath"), "utf8");
      const libraries: string[] = [];
      const entry = /<classpathentry\s+kind="lib"\s+path="([^"]+)"/gi;
      let match: RegExpExecArray | null;
      while ((match = entry.exec(xml)) !== null) {
        const libraryPath = match[1].trim();
        libraries.push(
          path.isAbsolute(libraryPath)
            ? libraryPath
            : path.join(projectDir, libraryPath),
        );
      }
      return libraries;
    } catch {
      return [];
    }
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

      const deployName = xml.match(/<wb-module[^>]*deploy-name="([^"]+)"/i);
      if (deployName?.[1]) {
        result.webappName = deployName[1].trim();
      }

      const resource =
        /<wb-resource\s+deploy-path="([^"]+)"\s+source-path="([^"]+)"/gi;
      let match: RegExpExecArray | null;
      while ((match = resource.exec(xml)) !== null) {
        const deployPath = match[1].trim();
        const sourcePath = match[2].trim().replace(/^\/+/, "");
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

      const dependency =
        /<dependent-module\s+archive-name="([^"]+)"\s+handle="([^"]+)"/gi;
      while ((match = dependency.exec(xml)) !== null) {
        result.additionalMappings.push({
          source: match[2].trim(),
          destination: `WEB-INF/lib/${match[1].trim()}`,
          description: `Eclipse WTP library: ${match[1].trim()}`,
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
