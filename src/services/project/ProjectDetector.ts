import fs from "fs";
import path from "path";

/** Pure project detection kept independent from VS Code and deployment state. */
export class ProjectDetector {
  public static isJavaWebProject(rootPath: string): boolean {
    if (
      fs.existsSync(path.join(rootPath, ".classpath")) &&
      fs.existsSync(
        path.join(
          rootPath,
          ".settings",
          "org.eclipse.wst.common.component",
        ),
      )
    ) {
      return true;
    }

    const webInfPaths = [
      path.join(rootPath, "src", "main", "webapp", "WEB-INF"),
      path.join(rootPath, "WebContent", "WEB-INF"),
      path.join(rootPath, "WEB-INF"),
    ];
    if (
      webInfPaths.some(
        (webInfPath) =>
          fs.existsSync(webInfPath) ||
          fs.existsSync(path.join(webInfPath, "web.xml")),
      )
    ) {
      return true;
    }

    if (
      this.fileContains(path.join(rootPath, "pom.xml"), /<packaging>\s*war\s*<\/packaging>/i)
    ) {
      return true;
    }

    for (const gradleFile of ["build.gradle", "build.gradle.kts"]) {
      if (
        this.fileContains(
          path.join(rootPath, gradleFile),
          /(?:\bwar\b|tomcat|jakarta|javax\.ee)/i,
        )
      ) {
        return true;
      }
    }

    return this.hasPackagedWebArtifact(path.join(rootPath, "target")) ||
      this.hasPackagedWebArtifact(path.join(rootPath, "build", "libs"));
  }

  private static fileContains(filePath: string, pattern: RegExp): boolean {
    try {
      return pattern.test(fs.readFileSync(filePath, "utf8"));
    } catch {
      return false;
    }
  }

  private static hasPackagedWebArtifact(directory: string): boolean {
    try {
      return fs
        .readdirSync(directory, { withFileTypes: true })
        .some(
          (entry) =>
            entry.isFile() && /\.(?:war|ear)$/i.test(entry.name),
        );
    } catch {
      return false;
    }
  }
}
