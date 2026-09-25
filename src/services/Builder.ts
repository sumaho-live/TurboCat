/**
 * Build orchestration system for Java EE projects
 * Handles deployment strategies, project analysis, and smart auto-deployment
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import { env } from "vscode";
import { glob } from "glob";
import { Tomcat } from "./Tomcat";
import { Logger } from "./Logger";
import { normalizeDeploymentPath } from "../utils/deploymentPath";
import {
  getActiveWorkspaceFolder,
  getWorkspaceConfiguration,
} from "../core/workspace";
import { ProjectDetector } from "./project/ProjectDetector";
import { globToRegex } from "./project/GlobPattern";
import { EclipseMetadataParser } from "./project/EclipseMetadataParser";
import { CommandRunner } from "./build/CommandRunner";
import { DirectorySynchronizer } from "./deployment/DirectorySynchronizer";
import { JavaReadiness } from "./JavaReadiness";
import {
  KeyedDebouncer,
  collapseWatchRoots,
  copyFileWithRetry,
} from "./deployment/SmartDeployCoordinator";


/**
 * Interface for build tool configuration parsers
 */
interface BuildConfigParser {
  /**
   * Check if current project is supported by this parser
   */
  isProjectSupported(): boolean;

  /**
   * Parse and generate resource mappings from build configuration
   */
  parseResourceMappings(): Promise<SmartDeployMapping[]>;

  /**
   * Parse output directories from build configuration
   */
  parseOutputDirectories(): Promise<string[]>;

  /**
   * Parse webapp configuration
   */
  parseWebappConfiguration(): Promise<{
    webappName: string;
    contextPath?: string;
  }>;
}

/**
 * Maven pom.xml configuration structure
 */
interface MavenConfig {
  artifactId?: string;
  finalName?: string;
  outputDirectory?: string;
  resources?: Array<{
    directory: string;
    targetPath?: string;
    excludes?: string[];
    includes?: string[];
  }>;
  warConfig?: {
    warSourceDirectory?: string;
    webXml?: string;
    excludes?: string[];
    includes?: string[];
  };
}

/**
 * Smart deployment mapping configuration
 */
interface ProjectStructure {
  type: "maven" | "gradle" | "eclipse" | "plain";
  javaOutputDir: string;
  javaSourceRoots: string[];
  webResourceRoots: string[];
  webappName: string;
  defaultWebappName: string;
}

/** Smart deploy file mapping configuration */
interface SmartDeployMapping {
  source: string; // Source pattern (glob)
  destination: string; // Destination pattern (supports {relative} placeholder)
  needsReload: boolean; // Whether this mapping requires Tomcat reload
  description?: string; // Optional description
  extensions?: string[]; // File extensions to include
  excludeExtensions?: string[]; // File extensions to exclude
}

interface LocalDeployMapping {
  source: string; // Directory or glob relative to workspace root
  destination: string; // Destination relative to the deployed webapp root
  description?: string;
  enabled?: boolean;
  needsReload?: boolean;
  extensions?: string[];
  excludeExtensions?: string[];
}

interface SmartDeployConfig {
  projectType: string; // Project type (maven, gradle, eclipse, plain)
  webappName: string; // Tomcat webapp name
  mappings: SmartDeployMapping[]; // Array of file mappings
  localDeploy?: {
    mappings: LocalDeployMapping[];
  };
  settings: {
    debounceTime: number; // Debounce time in milliseconds
    enabled: boolean; // Enable/disable smart deploy
    logLevel: "debug" | "info" | "warn" | "error"; // Log level for smart deploy
  };
}

/** Default mapping templates for different project types */
const DEFAULT_MAPPINGS: Record<string, SmartDeployMapping[]> = {
  maven: [
    {
      source: "target/classes/**/*.class",
      destination: "WEB-INF/classes/{relative}",
      needsReload: true,
      description: "Java compiled classes",
      extensions: [".class"],
    },
    {
      source: "src/main/webapp/**/*",
      destination: "{relative}",
      needsReload: false,
      description: "Static web resources",
      excludeExtensions: [".class", ".java"],
    },
    {
      source: "src/main/resources/**/*",
      destination: "WEB-INF/classes/{relative}",
      needsReload: true,
      description: "Resource files",
      excludeExtensions: [".class", ".java"],
    },
  ],
  gradle: [
    {
      source: "build/classes/java/main/**/*.class",
      destination: "WEB-INF/classes/{relative}",
      needsReload: true,
      description: "Java compiled classes",
      extensions: [".class"],
    },
    {
      source: "src/main/webapp/**/*",
      destination: "{relative}",
      needsReload: false,
      description: "Static web resources",
      excludeExtensions: [".class", ".java"],
    },
    {
      source: "src/main/resources/**/*",
      destination: "WEB-INF/classes/{relative}",
      needsReload: true,
      description: "Resource files",
      excludeExtensions: [".class", ".java"],
    },
  ],
  eclipse: [
    {
      source: "bin/**/*.class",
      destination: "WEB-INF/classes/{relative}",
      needsReload: true,
      description: "Java compiled classes",
      extensions: [".class"],
    },
    {
      source: "WebContent/**/*",
      destination: "{relative}",
      needsReload: false,
      description: "Static web resources",
      excludeExtensions: [".class", ".java"],
    },
  ],
  plain: [
    {
      source: "bin/**/*.class",
      destination: "WEB-INF/classes/{relative}",
      needsReload: true,
      description: "Java compiled classes",
      extensions: [".class"],
    },
    {
      source: "web/**/*",
      destination: "{relative}",
      needsReload: false,
      description: "Static web resources",
      excludeExtensions: [".class", ".java"],
    },
  ],
};

/**
 * Maven Configuration Parser
 *
 * Parses pom.xml to extract build configuration and generate smart deployment mappings
 */
class MavenConfigParser implements BuildConfigParser {
  private workspaceRoot: string;
  private pomPath: string;
  private mavenConfig?: MavenConfig;
  private readonly smartLog: {
    info(message: string): void;
    debug(message: string): void;
    warn(message: string): void;
    error(message: string, detail?: Error | string): void;
  };

  constructor(workspaceRoot: string, logger: Logger) {
    this.workspaceRoot = workspaceRoot;
    this.pomPath = path.join(workspaceRoot, "pom.xml");
    this.smartLog = {
      info: (message) => logger.info(message, false, "smartDeploy"),
      debug: (message) => logger.debug(message, false, "smartDeploy"),
      warn: (message) => logger.warn(message, false, "smartDeploy"),
      error: (message, detail) =>
        logger.error(message, false, detail, "smartDeploy"),
    };
  }

  /**
   * Check if Maven project is supported (pom.xml exists)
   */
  public isProjectSupported(): boolean {
    return fs.existsSync(this.pomPath);
  }

  /**
   * Parse Maven pom.xml and extract build configuration
   */
  private async parsePomXml(): Promise<MavenConfig> {
    if (this.mavenConfig) {
      return this.mavenConfig;
    }

    if (!fs.existsSync(this.pomPath)) {
      throw new Error("pom.xml not found");
    }

    try {
      const pomContent = fs.readFileSync(this.pomPath, "utf-8");
      this.smartLog.debug("Parsing Maven pom.xml for build configuration...");

      const config: MavenConfig = {};

      // Extract artifactId
      const artifactIdMatch = pomContent.match(
        /<artifactId>(.*?)<\/artifactId>/,
      );
      if (artifactIdMatch) {
        config.artifactId = artifactIdMatch[1].trim();
      }

      // Extract finalName (for WAR file naming)
      const finalNameMatch = pomContent.match(/<finalName>(.*?)<\/finalName>/);
      if (finalNameMatch) {
        config.finalName = finalNameMatch[1].trim();
      }

      // Extract build outputDirectory
      const outputDirMatch = pomContent.match(
        /<outputDirectory>(.*?)<\/outputDirectory>/,
      );
      if (outputDirMatch) {
        config.outputDirectory = outputDirMatch[1].trim();
      } else {
        config.outputDirectory = "target/classes"; // Maven default
      }

      // Parse resources configuration
      config.resources = this.parseResourcesSection(pomContent);

      // Parse maven-war-plugin configuration
      config.warConfig = this.parseWarPluginConfig(pomContent);

      this.mavenConfig = config;
      this.smartLog.debug(`Maven config parsed: ${JSON.stringify(config, null, 2)}`);
      return config;
    } catch (error) {
      this.smartLog.error("Failed to parse pom.xml", error as string);
      throw error;
    }
  }

  /**
   * Parse <resources> section from pom.xml
   */
  private parseResourcesSection(pomContent: string): Array<{
    directory: string;
    targetPath?: string;
    excludes?: string[];
    includes?: string[];
  }> {
    const resources: Array<{
      directory: string;
      targetPath?: string;
      excludes?: string[];
      includes?: string[];
    }> = [];

    // Match resources section
    const resourcesMatch = pomContent.match(
      /<resources>([\s\S]*?)<\/resources>/,
    );
    if (!resourcesMatch) {
      // Default Maven resources if not explicitly configured
      return [
        {
          directory: "src/main/resources",
          targetPath: undefined, // Default to classes root
        },
      ];
    }

    const resourcesContent = resourcesMatch[1];

    // Find all <resource> entries
    const resourceMatches = resourcesContent.matchAll(
      /<resource>([\s\S]*?)<\/resource>/g,
    );

    for (const resourceMatch of resourceMatches) {
      const resourceContent = resourceMatch[1];
      const resource: {
        directory: string;
        targetPath?: string;
        excludes?: string[];
        includes?: string[];
      } = {
        directory: "",
      };

      // Extract directory
      const dirMatch = resourceContent.match(/<directory>(.*?)<\/directory>/);
      if (dirMatch) {
        resource.directory = dirMatch[1].trim();
      }

      // Extract targetPath
      const targetMatch = resourceContent.match(
        /<targetPath>(.*?)<\/targetPath>/,
      );
      if (targetMatch) {
        resource.targetPath = targetMatch[1].trim();
      }

      // Extract excludes
      const excludesMatch = resourceContent.match(
        /<excludes>([\s\S]*?)<\/excludes>/,
      );
      if (excludesMatch) {
        const excludeMatches = excludesMatch[1].matchAll(
          /<exclude>(.*?)<\/exclude>/g,
        );
        resource.excludes = Array.from(excludeMatches, (match) =>
          match[1].trim(),
        );
      }

      // Extract includes
      const includesMatch = resourceContent.match(
        /<includes>([\s\S]*?)<\/includes>/,
      );
      if (includesMatch) {
        const includeMatches = includesMatch[1].matchAll(
          /<include>(.*?)<\/include>/g,
        );
        resource.includes = Array.from(includeMatches, (match) =>
          match[1].trim(),
        );
      }

      if (resource.directory) {
        resources.push(resource);
      }
    }

    return resources.length > 0
      ? resources
      : [
          {
            directory: "src/main/resources",
            targetPath: undefined,
          },
        ];
  }

  /**
   * Parse maven-war-plugin configuration
   */
  private parseWarPluginConfig(pomContent: string):
    | {
        warSourceDirectory?: string;
        webXml?: string;
        excludes?: string[];
        includes?: string[];
      }
    | undefined {
    // Find maven-war-plugin configuration
    const warPluginMatch = pomContent.match(
      /<plugin>[\s\S]*?<groupId>org\.apache\.maven\.plugins<\/groupId>[\s\S]*?<artifactId>maven-war-plugin<\/artifactId>[\s\S]*?<\/plugin>/,
    );

    if (!warPluginMatch) {
      return {
        warSourceDirectory: "src/main/webapp", // Maven default
      };
    }

    const pluginContent = warPluginMatch[0];
    const warConfig: {
      warSourceDirectory?: string;
      webXml?: string;
      excludes?: string[];
      includes?: string[];
    } = {};

    // Extract warSourceDirectory
    const warSourceMatch = pluginContent.match(
      /<warSourceDirectory>(.*?)<\/warSourceDirectory>/,
    );
    if (warSourceMatch) {
      warConfig.warSourceDirectory = warSourceMatch[1].trim();
    } else {
      warConfig.warSourceDirectory = "src/main/webapp";
    }

    // Extract webXml path
    const webXmlMatch = pluginContent.match(/<webXml>(.*?)<\/webXml>/);
    if (webXmlMatch) {
      warConfig.webXml = webXmlMatch[1].trim();
    }

    return warConfig;
  }

  /**
   * Generate resource mappings from Maven configuration
   */
  public async parseResourceMappings(): Promise<SmartDeployMapping[]> {
    const config = await this.parsePomXml();
    const mappings: SmartDeployMapping[] = [];

    // 1. Java compiled classes mapping
    const outputDir = config.outputDirectory || "target/classes";
    mappings.push({
      source: `${outputDir}/**/*.class`,
      destination: "WEB-INF/classes/{relative}",
      needsReload: true,
      description: "Maven compiled Java classes",
      extensions: [".class"],
    });

    // 2. Resources mappings
    if (config.resources) {
      for (const resource of config.resources) {
        const targetPath = resource.targetPath || "WEB-INF/classes";

        mappings.push({
          source: `${resource.directory}/**/*`,
          destination: `${targetPath}/{relative}`,
          needsReload: true,
          description: `Maven resource: ${resource.directory}`,
          excludeExtensions: [".java", ".class"],
        });
      }
    }

    // 3. Web application resources mapping
    const warSourceDir =
      config.warConfig?.warSourceDirectory || "src/main/webapp";
    mappings.push({
      source: `${warSourceDir}/**/*`,
      destination: "{relative}",
      needsReload: false,
      description: "Maven webapp resources",
      excludeExtensions: [".java", ".class"],
    });

    this.smartLog.debug(`Generated ${mappings.length} mappings from Maven pom.xml`);
    return mappings;
  }

  /**
   * Parse output directories from Maven configuration
   */
  public async parseOutputDirectories(): Promise<string[]> {
    const config = await this.parsePomXml();
    const directories = [config.outputDirectory || "target/classes"];

    if (config.resources) {
      directories.push(...config.resources.map((r) => r.directory));
    }

    return directories;
  }

  /**
   * Parse webapp configuration
   */
  public async parseWebappConfiguration(): Promise<{
    webappName: string;
    contextPath?: string;
  }> {
    const config = await this.parsePomXml();

    // Use finalName if specified, otherwise use artifactId, fallback to directory name
    const webappName =
      config.finalName ||
      config.artifactId ||
      path.basename(this.workspaceRoot);

    return {
      webappName,
      contextPath: `/${webappName}`,
    };
  }

  /**
   * Debug method: Print Maven configuration analysis
   */
  public async debugMavenConfiguration(): Promise<void> {
    this.smartLog.info("🔍 === Maven Configuration Debug ===");

    if (!this.isProjectSupported()) {
      this.smartLog.warn("❌ Maven project not supported - pom.xml not found");
      return;
    }

    try {
      const config = await this.parsePomXml();
      this.smartLog.info(`📋 Maven Configuration:`);
      this.smartLog.info(`   - ArtifactId: ${config.artifactId || "Not specified"}`);
      this.smartLog.info(`   - FinalName: ${config.finalName || "Not specified"}`);
      this.smartLog.info(
        `   - OutputDirectory: ${config.outputDirectory || "target/classes (default)"}`,
      );
      this.smartLog.info(
        `   - Resources: ${config.resources ? config.resources.length : 0} entries`,
      );

      if (config.resources) {
        config.resources.forEach((resource, index) => {
          this.smartLog.info(
            `     Resource ${index + 1}: ${resource.directory} → ${resource.targetPath || "classes root"}`,
          );
        });
      }

      this.smartLog.info(
        `   - War Source Directory: ${config.warConfig?.warSourceDirectory || "src/main/webapp (default)"}`,
      );

      const mappings = await this.parseResourceMappings();
      this.smartLog.info(`🎯 Generated ${mappings.length} deployment mappings:`);
      mappings.forEach((mapping, index) => {
        this.smartLog.info(
          `   Mapping ${index + 1}: ${mapping.source} → ${mapping.destination} (reload: ${mapping.needsReload})`,
        );
      });

      const webappConfig = await this.parseWebappConfiguration();
      this.smartLog.info(`🌐 Webapp Configuration:`);
      this.smartLog.info(`   - WebappName: ${webappConfig.webappName}`);
      this.smartLog.info(`   - ContextPath: ${webappConfig.contextPath}`);
    } catch (error) {
      this.smartLog.error("Maven configuration debug failed", error as string);
    }

    this.smartLog.info("🔍 === End Maven Configuration Debug ===");
  }
}

/**
 * Compiled mapping for runtime efficiency
 */
interface CompiledMapping extends SmartDeployMapping {
  /** Absolute source pattern */
  absoluteSource: string;
  /** Absolute destination path template */
  absoluteDestination: string;
  /** Compiled regex for source matching */
  sourceRegex: RegExp;
  /** Source of the mapping configuration */
  origin: "smart" | "local";
}

export class Builder {
  private static readonly instances = new Map<string, Builder>();
  private readonly workspaceFolder: vscode.WorkspaceFolder | undefined;
  private autoDeployMode: "Disable" | "Smart";
  private isDeploying = false;
  private attempts = 0;
  private preferredBuildType:
    "Auto" | "Local" | "Maven" | "Gradle" | "PreBuilt";
  private syncBypassPatterns: RegExp[] = [];

  // Enhanced Smart deploy properties (dual-watcher architecture with batch processing)
  private fileWatchers: vscode.FileSystemWatcher[] = []; // Contains both static and compiled file watchers

  // Batch processing for compiled files
  private batchDeploymentTimer?: NodeJS.Timeout; // Global batch timer
  private pendingCompiledFiles = new Map<string, "change" | "create" | "delete">(); // Latest event per file waiting for batch deployment
  private batchInFlight?: Promise<void>; // Serializes batch runs so the same class is never copied concurrently
  // Per-file debounce + serialization for static resources and Java source scans
  private readonly staticDebouncer = new KeyedDebouncer();
  private readonly javaScanDebouncer = new KeyedDebouncer();
  // Debounces/serializes Tomcat restarts requested by mappings with needsReload
  private readonly reloadDebouncer = new KeyedDebouncer();
  private readonly pendingReloadReasons = new Set<string>();
  // Source fingerprint (mtime:size) of the last smart-deployed copy, keyed by target path
  private readonly deployedFingerprints = new Map<string, string>();
  private static readonly STATIC_SETTLE_MS = 120;
  private static readonly RECENT_CLASS_WINDOW_MS = 10000;
  private static readonly RELOAD_SETTLE_MS = 1500;
  private static readonly BUILD_QUIET_MS = 3000;
  private static readonly BUILD_QUIET_MAX_WAIT_MS = 120000;
  // Bumped on every init/dispose so a stale init waiting for Java gives up
  private smartDeployGeneration = 0;
  private static readonly CONTENT_COMPARE_LIMIT = 4 * 1024 * 1024;

  private projectStructure?: ProjectStructure;
  private smartDeployConfig?: SmartDeployConfig;
  private compiledMappings?: CompiledMapping[];
  private compileEncoding: string;
  private defaultSmartDeployWebappName?: string;

  // Configuration file name (legacy, kept for reference)
  private static readonly CONFIG_FILE = ".vscode/tomcat-smart-deploy.json";
  private static readonly DEPLOY_CANCELLED = "TurboCat deployment cancelled";

  /**
   * Private constructor - initialize configuration and state
   */
  private constructor(workspaceFolder?: vscode.WorkspaceFolder) {
    this.workspaceFolder = workspaceFolder;
    // Use smartDeploy setting
    this.autoDeployMode = this.getConfiguration().get(
      "smartDeploy",
      "Disable",
    ) as "Disable" | "Smart";
    this.preferredBuildType = this.getConfiguration().get(
      "preferredBuildType",
      "Auto",
    ) as
      "Auto" | "Local" | "Maven" | "Gradle" | "PreBuilt";
    this.loadSyncBypassPatterns();
    this.compileEncoding = this.resolveCompileEncoding();
  }

  /**
   * Get singleton Builder instance
   */
  public static getInstance(resource?: vscode.Uri): Builder {
    const workspaceFolder = getActiveWorkspaceFolder(resource);
    const key = workspaceFolder?.uri.toString() ?? "__global__";
    let instance = Builder.instances.get(key);
    if (!instance) {
      instance = new Builder(workspaceFolder);
      Builder.instances.set(key, instance);
    }
    return instance;
  }

  public static getAllInstances(): readonly Builder[] {
    return [...Builder.instances.values()];
  }

  public static removeInstance(resource: vscode.Uri): void {
    const key = resource.toString();
    Builder.instances.get(key)?.disposeSmartDeploy();
    Builder.instances.delete(key);
  }

  public static clearInstancesForTests(): void {
    for (const instance of Builder.instances.values()) {
      instance.disposeSmartDeploy();
    }
    Builder.instances.clear();
  }

  private getConfiguration(): vscode.WorkspaceConfiguration {
    return getWorkspaceConfiguration("turbocat", this.workspaceFolder?.uri);
  }

  private getWorkspaceRoot(): string | undefined {
    return this.workspaceFolder?.uri.fsPath;
  }

  private getTomcat(): Tomcat {
    return Tomcat.getInstance(this.workspaceFolder?.uri);
  }

  private getLogger(): Logger {
    return Logger.getInstance(this.workspaceFolder?.uri);
  }

  private readonly smartLog = {
    info: (message: string) =>
      this.getLogger().info(message, false, "smartDeploy"),
    success: (message: string) =>
      this.getLogger().success(message, false, "smartDeploy"),
    debug: (message: string) =>
      this.getLogger().debug(message, false, "smartDeploy"),
    warn: (message: string) =>
      this.getLogger().warn(message, false, "smartDeploy"),
    error: (message: string, detail?: Error | string) =>
      this.getLogger().error(message, false, detail, "smartDeploy"),
  };

  /**
   * Update configuration from workspace settings
   */
  public updateConfig(): void {
    // Use smartDeploy setting
    this.autoDeployMode = this.getConfiguration().get(
      "smartDeploy",
      "Disable",
    ) as "Disable" | "Smart";
    this.preferredBuildType = this.getConfiguration().get(
      "preferredBuildType",
      "Auto",
    ) as
      "Auto" | "Local" | "Maven" | "Gradle" | "PreBuilt";
    this.loadSyncBypassPatterns();
    this.compileEncoding = this.resolveCompileEncoding();
    this.refreshEffectiveDeploymentTargets();
  }

  /**
   * Ensure a local deploy configuration template exists for plain/Eclipse projects.
   */
  public async ensureLocalConfigTemplate(): Promise<void> {
    try {
      const workspaceRoot = this.getWorkspaceRoot();
      if (!workspaceRoot) {
        return;
      }

      const configPath = path.join(workspaceRoot, Builder.CONFIG_FILE);
      this.projectStructure = this.detectProjectStructure();

      if (!["plain", "eclipse"].includes(this.projectStructure.type)) {
        return;
      }

      if (fs.existsSync(configPath)) {
        return;
      }

      // Load or create the default config template
      this.smartDeployConfig = await this.loadSmartDeployConfig();

      // Re-apply WTP mappings on top of the loaded config (detectProjectStructure
      // may have set them on a temporary config that was just overwritten)
      const wtp = this.parseEclipseWtpComponent(workspaceRoot);
      if (wtp?.additionalMappings.length) {
        this.mergeWtpMappings(wtp, this.projectStructure.defaultWebappName);
      }

      // Persist the final config (template + WTP mappings) to disk
      if (this.smartDeployConfig) {
        await this.saveSmartDeployConfig(this.smartDeployConfig);
      }
    } catch (error) {
      this.smartLog.debug(`Skipped creating local config template: ${error}`);
    }
  }

  /**
   * Load filename bypass patterns for smart deploy synchronization
   */
  private loadSyncBypassPatterns(): void {
    const raw =
      this.getConfiguration().get<string>(
        "syncBypassPatterns",
        "copy,副本,コピー,копия",
      ) || "";
    const patterns = raw
      .split(",")
      .map((pattern) => pattern.trim())
      .filter(Boolean)
      .map(
        (pattern) =>
          new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
      );

    this.syncBypassPatterns = patterns;
    this.smartLog.debug(
      `Sync bypass patterns: ${patterns.map((regex) => regex.source).join(", ") || "none"}`,
    );
  }

  /**
   * Resolve the effective web application name using the workspace configuration override.
   */
  private resolveWebappName(defaultName?: string): string {
    const override = this.getTomcat().getConfiguredDeploymentPath();
    if (override) {
      return override;
    }

    const candidate = (defaultName ?? "").trim();
    if (candidate) {
      return normalizeDeploymentPath(candidate);
    }

    const workspaceRoot = this.getWorkspaceRoot();
    if (workspaceRoot) {
      return path.basename(workspaceRoot);
    }

    return "ROOT";
  }

  /**
   * Resolve the javac encoding flag from user configuration with basic validation.
   */
  private resolveCompileEncoding(): string {
    const configured =
      this.getConfiguration().get<string>("compileEncoding", "UTF-8") ||
      "UTF-8";
    const value = configured.trim();
    if (!value) {
      return "UTF-8";
    }

    const isSafe = /^[\w.\-]+$/i.test(value);
    if (!isSafe) {
      this.getLogger().warn(
        `Unsupported compile encoding '${value}' detected. Falling back to UTF-8.`,
      );
      return "UTF-8";
    }

    return value;
  }

  /**
   * Refresh cached deployment targets using the latest workspace configuration override.
   */
  private refreshEffectiveDeploymentTargets(): void {
    if (this.projectStructure) {
      this.projectStructure.webappName = this.resolveWebappName(
        this.projectStructure.defaultWebappName,
      );
    }

    if (this.smartDeployConfig) {
      const baseName =
        this.defaultSmartDeployWebappName ?? this.smartDeployConfig.webappName;
      this.smartDeployConfig.webappName = this.resolveWebappName(baseName);
    }
  }

  /**
   * Java EE Project Detection
   *
   * Comprehensive project structure analysis implementing:
   * 1. Standard directory layout verification
   * 2. Web application descriptor detection
   * 3. Build system configuration analysis
   * 4. Existing artifact inspection
   * 5. Framework signature detection
   *
   * @returns Boolean indicating Java EE project validity
   */
  public static isJavaEEProject(resource?: vscode.Uri): boolean {
    const workspaceFolder = getActiveWorkspaceFolder(resource);
    if (!workspaceFolder) {
      return false;
    }

    return ProjectDetector.isJavaWebProject(workspaceFolder.uri.fsPath);
  }

  /**
   * Parse Eclipse .classpath to extract library JAR paths for javac classpath.
   * Returns absolute paths to all kind="lib" entries.
   */
  private parseEclipseClasspathLibs(projectDir: string): string[] {
    return EclipseMetadataParser.parseClasspathLibraries(projectDir);
  }

  /**
   * Parse Eclipse WTP .settings/org.eclipse.wst.common.component to extract
   * deployment mappings (web root, source roots, context name).
   * Falls back to safe defaults when the file is missing or unparseable.
   */
  private parseEclipseWtpComponent(workspaceRoot: string): {
    webappName: string;
    webResourceRoots: string[];
    javaSourceRoots: string[];
    additionalMappings: LocalDeployMapping[];
  } | null {
    return EclipseMetadataParser.parseWtpComponent(workspaceRoot);
  }

  /**
   * Build smart deploy mappings from WTP component and detected project roots.
   * Replaces the hardcoded DEFAULT_MAPPINGS template with mappings that reflect
   * the actual Eclipse WTP configuration.
   */
  private buildWtpSmartDeployMappings(
    workspaceRoot: string,
  ): SmartDeployMapping[] {
    const wtp = this.parseEclipseWtpComponent(workspaceRoot);
    if (!wtp) {
      return [];
    }

    const structure = this.projectStructure ?? this.detectProjectStructure();
    const mappings: SmartDeployMapping[] = [];

    // Class mapping from java output dir
    const outputDir = structure.javaOutputDir || "bin";
    mappings.push({
      source: `${outputDir}/**/*.class`,
      destination: "WEB-INF/classes/{relative}",
      needsReload: true,
      description: "Eclipse WTP: compiled classes",
      extensions: [".class"],
    });

    // Web resource mapping from each web resource root
    for (const root of structure.webResourceRoots) {
      if (root) {
        mappings.push({
          source: `${root}/**/*`,
          destination: "{relative}",
          needsReload: false,
          description: `Eclipse WTP: web resources (${root})`,
          excludeExtensions: [".class", ".java"],
        });
      }
    }

    // Resource mappings (if javaSourceRoots differ from default)
    for (const root of structure.javaSourceRoots) {
      if (root && root !== outputDir) {
        mappings.push({
          source: `${root}/**/*`,
          destination: "WEB-INF/classes/{relative}",
          needsReload: true,
          description: `Eclipse WTP: source resources (${root})`,
          excludeExtensions: [".java", ".class"],
        });
      }
    }

    return mappings;
  }

  /**
   * Merge Eclipse WTP additional mappings into the smart deploy config.
   * Shared by both Maven+WTP and Eclipse detection paths.
   */
  private mergeWtpMappings(
    wtp: { additionalMappings: LocalDeployMapping[] },
    defaultWebappName: string,
  ): void {
    if (!this.smartDeployConfig) {
      const detectedType = this.projectStructure?.type || "eclipse";
      this.smartDeployConfig = {
        projectType: detectedType,
        webappName: this.resolveWebappName(defaultWebappName),
        mappings: DEFAULT_MAPPINGS[detectedType] || DEFAULT_MAPPINGS.eclipse,
        settings: {
          debounceTime: this.getConfiguration().get<number>(
            "smartDeployDebounce",
            300,
          ),
          enabled: true,
          logLevel: "info",
        },
      };
    }
    if (!this.smartDeployConfig.localDeploy) {
      this.smartDeployConfig.localDeploy = { mappings: [] };
    }
    const existing = new Set(
      this.smartDeployConfig.localDeploy.mappings.map(
        (m) => `${m.source}|${m.destination}`,
      ),
    );
    for (const m of wtp.additionalMappings) {
      if (!existing.has(`${m.source}|${m.destination}`)) {
        this.smartDeployConfig.localDeploy.mappings.push(m);
      }
    }
  }

  /**
   * Project Structure Detection
   *
   * Auto-detects project structure and configuration for smart deployment:
   * 1. Maven project detection and configuration
   * 2. Gradle project detection and configuration
   * 3. Eclipse project detection and configuration
   * 4. Plain Java project fallback
   *
   * @returns ProjectStructure with detected configuration
   */
  public detectProjectStructure(): ProjectStructure {
    const workspaceFolder = this.workspaceFolder;
    if (!workspaceFolder) {
      throw new Error("No workspace folder found");
    }

    const workspaceRoot = workspaceFolder.uri.fsPath;

    // Maven detection
    if (fs.existsSync(path.join(workspaceRoot, "pom.xml"))) {
      const defaultWebappName =
        this.getMavenArtifactId(workspaceRoot) || path.basename(workspaceRoot);

      // If the project also has Eclipse .settings, merge WTP deployment mappings
      const wtp = this.parseEclipseWtpComponent(workspaceRoot);
      const webResourceRoots = wtp?.webResourceRoots.length
        ? wtp.webResourceRoots
        : ["src/main/webapp"];
      const javaSourceRoots = wtp?.javaSourceRoots.length
        ? wtp.javaSourceRoots
        : ["src/main/java"];

      if (wtp?.additionalMappings.length) {
        this.mergeWtpMappings(wtp, defaultWebappName);
      }

      return {
        type: "maven",
        javaOutputDir: "target/classes",
        javaSourceRoots,
        webResourceRoots,
        defaultWebappName,
        webappName: this.resolveWebappName(defaultWebappName),
      };
    }

    // Gradle detection
    if (
      fs.existsSync(path.join(workspaceRoot, "build.gradle")) ||
      fs.existsSync(path.join(workspaceRoot, "build.gradle.kts"))
    ) {
      const defaultWebappName =
        this.getGradleProjectName(workspaceRoot) ||
        path.basename(workspaceRoot);
      return {
        type: "gradle",
        javaOutputDir: "build/classes/java/main",
        javaSourceRoots: ["src/main/java"],
        webResourceRoots: ["src/main/webapp"],
        defaultWebappName,
        webappName: this.resolveWebappName(defaultWebappName),
      };
    }

    // Eclipse/Plain Java detection
    if (fs.existsSync(path.join(workspaceRoot, ".classpath"))) {
      const wtp = this.parseEclipseWtpComponent(workspaceRoot);
      const classpath = EclipseMetadataParser.parseClasspath(workspaceRoot);
      const defaultWebappName = wtp?.webappName || path.basename(workspaceRoot);
      const webResourceRoots = wtp?.webResourceRoots.length
        ? wtp.webResourceRoots
        : ["WebContent", "web"];
      const javaSourceRoots = wtp?.javaSourceRoots.length
        ? wtp.javaSourceRoots
        : classpath.sourceRoots.length
          ? classpath.sourceRoots
          : ["src"];

      // Merge WTP additional mappings into smart deploy config
      if (wtp?.additionalMappings.length) {
        this.mergeWtpMappings(wtp, defaultWebappName);
      }

      return {
        type: "eclipse",
        javaOutputDir: classpath.outputDirectory,
        javaSourceRoots,
        webResourceRoots,
        defaultWebappName,
        webappName: this.resolveWebappName(defaultWebappName),
      };
    }

    // Default fallback
    const defaultWebappName = path.basename(workspaceRoot);
    return {
      type: "plain",
      javaOutputDir: "bin",
      javaSourceRoots: ["src"],
      webResourceRoots: ["web", "webapp"],
      defaultWebappName,
      webappName: this.resolveWebappName(defaultWebappName),
    };
  }

  /**
   * Extract Maven artifact ID from pom.xml
   */
  private getMavenArtifactId(workspaceRoot: string): string | null {
    try {
      const pomPath = path.join(workspaceRoot, "pom.xml");
      const pomContent = fs.readFileSync(pomPath, "utf-8");
      // Strip blocks that contain nested <artifactId> to avoid false matches
      const stripped = pomContent
        .replace(/<parent>[\s\S]*?<\/parent>/g, "")
        .replace(/<dependencies>[\s\S]*?<\/dependencies>/g, "")
        .replace(/<plugins>[\s\S]*?<\/plugins>/g, "");
      const artifactIdMatch = stripped.match(/<artifactId>(.*?)<\/artifactId>/);
      return artifactIdMatch ? artifactIdMatch[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Extract Gradle project name from settings.gradle
   */
  private getGradleProjectName(workspaceRoot: string): string | null {
    try {
      const settingsPath = path.join(workspaceRoot, "settings.gradle");
      if (fs.existsSync(settingsPath)) {
        const settingsContent = fs.readFileSync(settingsPath, "utf-8");
        const nameMatch = settingsContent.match(
          /rootProject\.name\s*=\s*['"]([^'"]+)['"]/,
        );
        return nameMatch ? nameMatch[1] : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Build and Deployment Orchestrator
   *
   * Centralized deployment control implementing:
   * 1. Project validation
   * 2. Build strategy selection
   * 3. Target environment preparation
   * 4. Build execution
   * 5. Post-deployment actions
   *
   * @param type Build strategy ('Local' | 'Maven' | 'Gradle' | 'Choice')
   * @log Deployment progress and errors
   */
  public async deploy(
    type: "Local" | "Maven" | "Gradle" | "PreBuilt" | "Choice",
  ): Promise<void> {
    const projectDir = this.getWorkspaceRoot();
    if (!projectDir || !Builder.isJavaEEProject()) {
      await this.createNewProject();
      return;
    }

    let buildType: "Local" | "Maven" | "Gradle" | "PreBuilt";
    try {
      buildType = await this.resolveBuildType(type, projectDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== Builder.DEPLOY_CANCELLED) {
        this.getLogger().error("Deployment aborted:", false, message);
      } else {
        this.getLogger().info("Deployment cancelled by user");
      }
      return;
    }

    this.getLogger().info(`Using ${buildType} deployment pipeline`);

    // Pause smart deploy during manual deployment to avoid watcher conflicts.
    // The try/finally below ensures smart deploy is ALWAYS restored regardless
    // of early returns, errors, or retries.
    const previousSmartDeploy = this.autoDeployMode;
    // A full deployment rewrites the webapp, so forget what smart deploy copied.
    this.deployedFingerprints.clear();
    if (this.autoDeployMode === "Smart") {
      this.autoDeployMode = "Disable";
      this.disposeSmartDeploy();
      this.smartLog.warn("Smart deploy PAUSED for manual deployment");
    }

    try {
      try {
        this.projectStructure = this.detectProjectStructure();
      } catch (error) {
        this.getLogger().warn(
          "Unable to refresh project structure before deployment",
        );
        if (error) {
          this.smartLog.debug(`Project structure detection error: ${error}`);
        }
      }

      const fallbackName =
        this.projectStructure?.defaultWebappName ?? path.basename(projectDir);
      const appName = this.resolveWebappName(fallbackName);
      if (this.projectStructure) {
        this.projectStructure.webappName = appName;
      }
      const tomcatHome = await this.getTomcat().findTomcatHome();

      this.getTomcat().setAppName(appName);

      if (!tomcatHome || !appName) {
        return;
      }

      const webappsRoot = await this.getTomcat().getWebappsRoot(tomcatHome);
      if (!webappsRoot) {
        return;
      }

      const targetDir = path.join(webappsRoot, appName);
      await vscode.workspace.saveAll();

      const startTime = performance.now();
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `${buildType} deployment in progress`,
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: "Preparing workspace..." });
          switch (buildType) {
            case "Local":
              await this.localDeploy(
                projectDir,
                targetDir,
                tomcatHome,
                progress,
              );
              break;
            case "Maven":
              progress.report({ message: "Running Maven build..." });
              await this.mavenDeploy(projectDir, targetDir);
              break;
            case "PreBuilt":
              progress.report({
                message: "Deploying pre-built classes + static resources...",
              });
              await this.preBuiltDeploy(
                projectDir,
                targetDir,
                tomcatHome,
                progress,
              );
              break;
            case "Gradle":
              progress.report({ message: "Running Gradle build..." });
              await this.gradleDeploy(projectDir, targetDir, appName);
              break;
            default:
              throw new Error(`Invalid deployment type: ${buildType}`);
          }
        },
      );

      const endTime = performance.now();
      const duration = Math.round(endTime - startTime);

      if (fs.existsSync(targetDir)) {
        this.getLogger().success(
          `${buildType} build completed in ${duration}ms`,
          true,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        await this.getTomcat().reload();
      }

      this.attempts = 0;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isBusyError =
        errorMessage.includes("EBUSY") ||
        errorMessage.includes("resource busy or locked");
      if (isBusyError && this.attempts < 3) {
        this.attempts++;
        await this.getTomcat().stop(false);
        // Recursive retry: the inner deploy() call will see autoDeployMode
        // already Disabled and skip its own pause; when it returns, this
        // outer finally will correctly restore the original Smart state.
        await this.deploy(buildType);
      } else {
        this.attempts = 0;
        this.getLogger().error(`${buildType} build failed:`, true, errorMessage);
      }
    } finally {
      // ALWAYS restore smart deploy state regardless of how we exited
      if (
        previousSmartDeploy === "Smart" &&
        this.autoDeployMode === "Disable"
      ) {
        this.autoDeployMode = "Smart";
        // Re-initialize watchers in the background — don't block deployment completion
        this.initializeSmartDeploy().catch((err) =>
          this.smartLog.error(
            "Failed to resume smart deploy after manual deployment",
            err as string,
          ),
        );
        this.smartLog.warn("Smart deploy RESUMED after manual deployment");
      }
    }
  }

  private async resolveBuildType(
    requested: "Local" | "Maven" | "Gradle" | "PreBuilt" | "Choice",
    projectDir: string,
  ): Promise<"Local" | "Maven" | "Gradle" | "PreBuilt"> {
    if (requested !== "Choice") {
      return requested;
    }

    const candidates = this.collectBuildCandidates(projectDir);
    const preferred = this.preferredBuildType;

    if (preferred !== "Auto" && candidates.includes(preferred)) {
      return preferred;
    }

    // If user explicitly set a preferred type that isn't available, warn and fall back
    if (preferred !== "Auto" && !candidates.includes(preferred)) {
      this.smartLog.warn(
        `Preferred build type "${preferred}" is not available for this project. ` +
          `Available: ${candidates.join(", ")}. Falling back to selection.`,
      );
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    const choice = await vscode.window.showQuickPick(candidates, {
      placeHolder:
        "Select the build type TurboCat should use for this workspace",
      ignoreFocusOut: true,
    });

    if (!choice) {
      throw new Error(Builder.DEPLOY_CANCELLED);
    }

    const allowed: ReadonlyArray<"Local" | "Maven" | "Gradle" | "PreBuilt"> = [
      "Local",
      "Maven",
      "Gradle",
      "PreBuilt",
    ];
    if (
      !allowed.includes(choice as "Local" | "Maven" | "Gradle" | "PreBuilt")
    ) {
      throw new Error(`Unsupported build type selection: ${choice}`);
    }

    const typedChoice = choice as "Local" | "Maven" | "Gradle" | "PreBuilt";
    await this.persistPreferredBuildType(typedChoice);
    return typedChoice;
  }

  private collectBuildCandidates(
    projectDir: string,
  ): Array<"Local" | "Maven" | "Gradle" | "PreBuilt"> {
    const candidates: Array<"Local" | "Maven" | "Gradle" | "PreBuilt"> = [
      "Local",
    ];
    const hasPom = fs.existsSync(path.join(projectDir, "pom.xml"));
    const hasGradle =
      fs.existsSync(path.join(projectDir, "build.gradle")) ||
      fs.existsSync(path.join(projectDir, "build.gradle.kts"));

    if (hasPom) {
      candidates.push("Maven");
      // PreBuilt: available when pom.xml + target/classes exist (compiled by Java LS)
      const hasPreBuiltClasses = fs.existsSync(
        path.join(projectDir, "target", "classes"),
      );
      if (hasPreBuiltClasses) {
        candidates.push("PreBuilt");
      }
    }

    // Eclipse project: PreBuilt available when .classpath + bin/ exist
    if (fs.existsSync(path.join(projectDir, ".classpath"))) {
      const eclipseOutputs = EclipseMetadataParser.parseClasspath(
        projectDir,
      ).outputDirectories;
      const hasEclipseOutput = eclipseOutputs.some((output) =>
        fs.existsSync(path.join(projectDir, output)),
      );
      if (hasEclipseOutput && !candidates.includes("PreBuilt")) {
        candidates.push("PreBuilt");
      }
    }

    if (hasGradle) {
      candidates.push("Gradle");
    }

    return candidates;
  }

  private async persistPreferredBuildType(
    value: "Local" | "Maven" | "Gradle" | "PreBuilt",
  ): Promise<void> {
    this.preferredBuildType = value;
    await this.getConfiguration().update(
      "preferredBuildType",
      value,
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
  }

  /**
   * Automated Deployment Trigger
   *
   * Implements intelligent deployment automation with:
   * 1. Save event analysis
   * 2. Build type resolution
   * 3. Smart deploy initialization
   * 4. Concurrency control
   * 5. Error handling
   *
   * @deprecated Parameter reason is unused but kept for backward compatibility
   */
  public async autoDeploy(
    _reason: vscode.TextDocumentSaveReason,
  ): Promise<void> {
    if (this.isDeploying || !Builder.isJavaEEProject()) {
      return;
    }

    try {
      this.isDeploying = true;

      if (this.autoDeployMode === "Smart") {
        // Smart deploy is handled by file system watchers
        // This ensures smart deploy is initialized if not already
        if (!this.projectStructure) {
          this.initializeSmartDeploy().catch((error) =>
            this.smartLog.error(
              "Failed to initialize smart deploy",
              error as string,
            ),
          );
        }
      }
      // No other deployment modes are supported anymore
    } finally {
      this.isDeploying = false;
    }
  }

  /**
   * Initialize Dual-Watcher Smart Deploy System
   *
   * Implements dual-watcher architecture for optimal deployment performance:
   * 1. Static Resource Watcher: monitors src folder for immediate deployment
   * 2. Compiled File Watcher: monitors target/build folders for delayed batch deployment
   */
  public async initializeSmartDeploy(): Promise<void> {
    const generation = ++this.smartDeployGeneration;
    // Update autoDeployMode from config to ensure it's current
    this.autoDeployMode = this.getConfiguration().get(
      "smartDeploy",
      "Disable",
    ) as "Disable" | "Smart";

    if (this.autoDeployMode !== "Smart") {
      this.smartLog.debug("Smart deploy not initialized - mode is not Smart");
      return;
    }

    try {
      this.smartLog.debug("Initializing hybrid smart deploy system...");

      // Check current workspace
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        this.smartLog.error("Smart deploy requires an open workspace");
        return;
      }

      // Load or create smart deploy configuration FIRST
      this.smartDeployConfig = await this.loadSmartDeployConfig();

      // Detect project structure SECOND — this may merge WTP mappings
      // into the already-loaded config (in-memory only; sufficient for runtime)
      this.projectStructure = this.detectProjectStructure();
      this.smartLog.debug(
        `Detected project structure: ${JSON.stringify(this.projectStructure)}`,
      );

      // For Eclipse/plain projects, persist WTP mappings to the JSON config
      // file so they survive restarts. For Maven, pom.xml is the authority;
      // the in-memory merge above is all that's needed.
      if (this.smartDeployConfig && this.projectStructure.type !== "maven") {
        await this.saveSmartDeployConfig(this.smartDeployConfig);
      }

      // Compile mappings for runtime efficiency
      this.compiledMappings = this.compileMappings(this.smartDeployConfig);

      if (!(await this.waitForJavaReady(generation))) {
        return;
      }

      // Setup dual-watcher architecture
      this.setupDualFileWatchers();

      const projectType = this.projectStructure.type;
      const javaOut = this.projectStructure.javaOutputDir;
      const infoSummary = `Smart deploy ready • ${projectType} project • webapp: ${this.projectStructure.webappName} • mappings: ${this.compiledMappings.length}`;
      this.smartLog.success(infoSummary);
      this.smartLog.debug(`Smart deploy config file: ${Builder.CONFIG_FILE}`);
      this.smartLog.debug(`Java output directory: ${javaOut}`);

      const showLog = this.getConfiguration().get<boolean>(
        "showSmartDeployLog",
        true,
      );
      if (!showLog) {
        this.smartLog.warn(
          "Smart deploy log visibility is OFF (turbocat.showSmartDeployLog=false). Deployment confirmations will still appear, but debug details are hidden.",
        );
      }
    } catch (error) {
      this.smartLog.error("Failed to initialize smart deploy", error as string);
    }
  }

  /**
   * Hold smart deploy until the Java language server has started and its
   * initial workspace build has gone quiet; otherwise every class it writes at
   * start-up would be copied into Tomcat. Returns false when smart deploy must
   * stay off (Java not ready, or this init was superseded/disabled meanwhile).
   */
  private async waitForJavaReady(generation: number): Promise<boolean> {
    const stale = () =>
      generation !== this.smartDeployGeneration ||
      this.autoDeployMode !== "Smart";

    if (JavaReadiness.isReady()) {
      return true;
    }

    this.smartLog.info(
      "Smart deploy waiting for the Java language server to finish loading...",
    );
    const ready = await JavaReadiness.whenReady();
    if (stale()) {
      return false;
    }
    if (!ready) {
      this.smartLog.warn(
        "Java language server is not ready; smart deploy stays OFF. Toggle smart deploy again once Java has loaded.",
      );
      return false;
    }

    this.smartLog.info("Java ready; waiting for the initial build to finish...");
    await this.waitForBuildQuiet(stale);
    return !stale();
  }

  /** Resolve once no class file has changed for BUILD_QUIET_MS (capped). */
  private async waitForBuildQuiet(stale: () => boolean): Promise<void> {
    let lastActivity = Date.now();
    const touch = () => {
      lastActivity = Date.now();
    };
    const watchers = this.resolveCompiledOutputDirectories()
      .filter((dir) => fs.existsSync(dir))
      .map((dir) => {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(dir, "**/*.class"),
        );
        watcher.onDidChange(touch);
        watcher.onDidCreate(touch);
        watcher.onDidDelete(touch);
        return watcher;
      });

    const deadline = Date.now() + Builder.BUILD_QUIET_MAX_WAIT_MS;
    try {
      while (
        !stale() &&
        Date.now() - lastActivity < Builder.BUILD_QUIET_MS &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      watchers.forEach((watcher) => watcher.dispose());
    }
  }

  /**
   * Setup dual-watcher architecture for optimized smart deployment
   *
   * Architecture:
   * 1. Static Resource Watcher: monitors src folder (excluding java files)
   *    - Immediate deployment (0ms delay)
   *    - Handles HTML, CSS, JS, JSP, config files, etc.
   *
   * 2. Compiled File Watcher: monitors target/classes and build/classes
   *    - Delayed deployment (configurable, default 300ms)
   *    - Handles compiled Java classes
   */
  private setupDualFileWatchers(): void {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      this.smartLog.debug("Dual watcher setup failed: No workspace root");
      return;
    }

    // Dispose existing watchers
    this.disposeFileWatchers();

    this.smartLog.info("Setting up dual-watcher smart deploy watchers");
    this.smartLog.debug(
      "Features: static resources (immediate) + compiled classes (delayed)",
    );

    // 1. Static Resource Watcher - src/**/* excluding .java files
    this.setupStaticResourceWatcher(workspaceRoot);

    // 2. Compiled File Watcher - target/classes/**/*.class or build/classes/**/*.class
    this.setupCompiledFileWatcher(workspaceRoot);

    this.smartLog.success("Dual-watcher smart deploy setup complete");
  }

  /**
   * Setup static resource file watcher for immediate deployment
   */
  private setupStaticResourceWatcher(workspaceRoot: string): void {
    const structure = this.projectStructure;
    const candidateRoots = new Set<string>();

    if (structure?.webResourceRoots?.length) {
      structure.webResourceRoots.forEach((root) => candidateRoots.add(root));
    }

    candidateRoots.add(path.join("src", "main", "webapp"));
    candidateRoots.add(path.join("src", "main", "resources"));
    candidateRoots.add("src");

    const localMappingCandidates =
      this.smartDeployConfig?.localDeploy?.mappings ?? [];
    localMappingCandidates
      .filter((mapping) => mapping && mapping.enabled !== false)
      .forEach((mapping) => {
        const normalizedSource = this.normalizeLocalMappingSource(
          mapping.source,
        );
        const root = this.getMappingRoot(normalizedSource);
        if (root) {
          candidateRoots.add(root);
        }
      });

    let watcherCreated = false;

    // Only watch the outermost existing roots: overlapping watchers (e.g. `src`
    // and `src/main/webapp`) would fire once per watcher for a single save.
    const existingRoots = [...candidateRoots].filter((root) => {
      const exists =
        !!root && fs.existsSync(path.join(workspaceRoot, root));
      if (!exists && root && !root.includes("*")) {
        this.smartLog.debug(
          `Skipping static watcher for ${root} (directory not found)`,
        );
      }
      return exists;
    });

    collapseWatchRoots(existingRoots).forEach((normalized) => {
      const absolute = path.join(workspaceRoot, normalized);

      const globPattern = `${normalized.replace(/\\/g, "/")}/**/*`;
      const pattern = new vscode.RelativePattern(workspaceRoot, globPattern);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      this.smartLog.debug(`Static resource watcher: ${absolute}`);
      this.smartLog.debug("Strategy: immediate deployment for web resources");

      watcher.onDidChange((uri: vscode.Uri) =>
        this.handleStaticResourceChange(uri, "change"),
      );
      watcher.onDidCreate((uri: vscode.Uri) =>
        this.handleStaticResourceChange(uri, "create"),
      );
      watcher.onDidDelete?.((uri: vscode.Uri) =>
        this.handleStaticResourceChange(uri, "delete"),
      );

      this.fileWatchers.push(watcher);
      watcherCreated = true;
    });

    if (!watcherCreated) {
      this.smartLog.warn(
        "No static resource watcher configured. Verify resource directories exist.",
      );
    } else {
      this.smartLog.info("Static resource watcher ready");
    }
  }

  /**
   * Setup compiled file watcher for delayed deployment
   */
  private setupCompiledFileWatcher(workspaceRoot: string): void {
    if (!this.projectStructure) {
      return;
    }

    const outputCandidates = new Set<string>();

    const mappingOutputs = this.resolveCompiledOutputDirectories();
    mappingOutputs.forEach((absPath) => {
      const relative = path
        .relative(workspaceRoot, absPath)
        .replace(/\\/g, "/");
      if (relative && !relative.startsWith("..")) {
        outputCandidates.add(relative);
      }
    });

    if (!outputCandidates.size && this.projectStructure.javaOutputDir) {
      outputCandidates.add(this.projectStructure.javaOutputDir);
    }

    if (fs.existsSync(path.join(workspaceRoot, ".classpath"))) {
      EclipseMetadataParser.parseClasspath(workspaceRoot).outputDirectories.forEach(
        (output) => outputCandidates.add(output),
      );
    }

    if (!outputCandidates.size) {
      outputCandidates.add("bin");
    }

    let watcherCreated = false;

    collapseWatchRoots(outputCandidates).forEach((normalized) => {
      const absolute = path.join(workspaceRoot, normalized);

      if (!fs.existsSync(absolute)) {
        this.smartLog.debug(
          `Skipping compiled watcher for ${normalized} (directory not found)`,
        );
        return;
      }

      const globPattern = `${normalized.replace(/\\/g, "/")}/**/*.class`;
      const pattern = new vscode.RelativePattern(workspaceRoot, globPattern);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      this.smartLog.debug(`Compiled file watcher: ${absolute}`);
      this.smartLog.debug("Strategy: delayed deployment for compiled classes");

      watcher.onDidChange((uri: vscode.Uri) =>
        this.handleCompiledFileChange(uri, "change"),
      );
      watcher.onDidCreate((uri: vscode.Uri) =>
        this.handleCompiledFileChange(uri, "create"),
      );
      watcher.onDidDelete?.((uri: vscode.Uri) =>
        this.handleCompiledFileChange(uri, "delete"),
      );

      this.fileWatchers.push(watcher);
      watcherCreated = true;
    });

    if (!watcherCreated) {
      this.smartLog.warn(
        "No compiled file watcher configured. Verify build output directories exist.",
      );
    } else {
      this.smartLog.info("Compiled file watcher ready");
    }
  }

  /**
   * Dispose the unified file watcher
   */
  private disposeFileWatchers(): void {
    this.fileWatchers.forEach((watcher) => watcher.dispose());
    this.fileWatchers = [];
  }

  /**
   * NEW: Handle static resource file changes (immediate deployment)
   * Processes non-Java files from src directory with zero delay
   */
  private handleStaticResourceChange(
    uri: vscode.Uri,
    eventType: "change" | "create" | "delete",
  ): void {
    const fileName = path.basename(uri.fsPath);
    const fileExt = path.extname(uri.fsPath).toLowerCase();

    if (this.shouldBypassFile(uri.fsPath)) {
      this.smartLog.debug(`Bypassing sync for file: ${fileName}`);
      return;
    }

    // Skip hidden files, temp files, and handle Java files specially
    if (
      fileName.startsWith(".") ||
      fileName.endsWith(".tmp") ||
      fileName.endsWith(".temp") ||
      fileExt === ".svn"
    ) {
      this.smartLog.debug(`Skipping file: ${fileName} (temp/hidden file)`);
      return;
    }

    // Class files are owned by the compiled watcher (output dirs may sit
    // inside a web root, e.g. WebContent/WEB-INF/classes)
    if (fileExt === ".class") {
      return;
    }

    // Handle Java files - trigger compilation check
    if (fileExt === ".java") {
      this.smartLog.debug(
        `Java file ${eventType}: ${fileName} - triggering compilation check`,
      );
      this.handleJavaFileChange(uri.fsPath, eventType);
      return;
    }

    // Get relative path from workspace root
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }

    const relativePath = path.relative(workspaceRoot, uri.fsPath);
    this.smartLog.debug(
      `Static resource ${eventType}: ${fileName} (${relativePath})`,
    );

    // Short per-file settle window: collapses the change/create bursts an
    // editor save produces and lets the writer release the file before we copy.
    this.staticDebouncer.schedule(uri.fsPath, Builder.STATIC_SETTLE_MS, () =>
      this.deployStaticResourceImmediately(uri.fsPath, eventType),
    );
  }

  /**
   * Handle Java source file changes by checking for corresponding compiled files
   */
  private async handleJavaFileChange(
    javaFilePath: string,
    _eventType: "change" | "create" | "delete",
  ): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }

    const fileName = path.basename(javaFilePath, ".java");
    const relativePath = path.relative(workspaceRoot, javaFilePath);
    this.smartLog.debug(`Java source ${fileName}.java changed (${relativePath})`);

    // Single delayed check - wait for compilation to complete
    const debounceMs = this.getConfiguration().get<number>(
      "smartDeployDebounce",
      300,
    );
    this.javaScanDebouncer.schedule(
      javaFilePath,
      Math.max(debounceMs, 500),
      async () => {
        try {
          await this.checkAndDeployCompiledClass(javaFilePath, fileName);
        } catch (error) {
          this.smartLog.debug(
            `Compilation check failed for ${fileName}.java: ${error}`,
          );
        }
      },
    );
  }

  /**
   * Check for compiled .class files and deploy them
   * Enhanced version that detects ALL related class files including inner classes
   */
  private async checkAndDeployCompiledClass(
    javaFilePath: string,
    className: string,
  ): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot || !this.projectStructure) {
      return;
    }

    const outputDirs = this.resolveCompiledOutputDirectories();
    const existingOutputDirs = outputDirs.filter((dir) => fs.existsSync(dir));

    if (!existingOutputDirs.length) {
      this.smartLog.debug(
        `No compiled output directories found. Checked: ${outputDirs.join(", ") || "none"}`,
      );
      return;
    }

    // Derive the Java package from the source file path relative to the source root
    let javaPackage = "";
    const sourceRoots = this.projectStructure.javaSourceRoots || [];
    for (const sourceRoot of sourceRoots) {
      const absSourceRoot = path.join(workspaceRoot, sourceRoot);
      if (javaFilePath.startsWith(absSourceRoot + path.sep)) {
        const relativeToSource = path.relative(absSourceRoot, javaFilePath);
        javaPackage = path.dirname(relativeToSource).replace(/\\/g, "/");
        break;
      }
    }

    try {
      // Strategy 1: Find direct class file matches (including inner classes)
      const directMatches: string[] = [];
      for (const outputDir of existingOutputDirs) {
        directMatches.push(
          ...(await this.findDirectClassMatches(
            outputDir,
            className,
            javaPackage,
          )),
        );
      }

      // Strategy 2: classes recompiled alongside it (same package directory
      // only; skipped when the package is unknown and matches may be ambiguous)
      const recentMatches = javaPackage
        ? await this.findRecentSiblingClasses(
            new Set(directMatches.map((file) => path.dirname(file))),
          )
        : [];

      const allMatches = new Set([...directMatches, ...recentMatches]);
      const classFiles = Array.from(allMatches);

      if (classFiles.length === 0) {
        this.smartLog.debug(`No compiled classes found for ${className}.java`);
        return;
      }

      this.smartLog.info(
        `Queued ${classFiles.length} compiled classes for ${className}.java`,
      );

      this.smartLog.debug(
        `Direct matches: ${directMatches.length}, recently recompiled siblings: ${classFiles.length - directMatches.length}`,
      );

      // Add all found class files to batch deployment
      for (const classFile of classFiles) {
        const relativePath = path.relative(workspaceRoot, classFile);
        this.smartLog.debug(`Queuing class file: ${relativePath}`);
        this.addToBatchDeployment(classFile, "change");
      }

      this.smartLog.debug(
        `Added ${classFiles.length} compiled classes to batch deployment`,
      );
    } catch (error) {
      this.smartLog.warn(`Failed to scan for compiled classes: ${error}`);
    }
  }

  /**
   * Find direct class file matches including inner classes and anonymous classes
   */
  private async findDirectClassMatches(
    outputDir: string,
    className: string,
    javaPackage?: string,
  ): Promise<string[]> {
    // Pattern to match:
    // - ClassName.class (main class)
    // - ClassName$InnerClass.class (inner classes)
    // - ClassName$1.class, ClassName$2.class (anonymous classes)
    // - ClassName$InnerClass$1.class (anonymous classes in inner classes)
    //
    // When javaPackage is provided, restrict the search to that package
    // to avoid deploying identically-named classes from other packages.
    const packageDir = javaPackage ? javaPackage.replace(/\\/g, "/") : "**";
    const patterns = [
      `${outputDir}/${packageDir}/${className}.class`,
      `${outputDir}/${packageDir}/${className}$*.class`,
    ];

    const matches: string[] = [];
    for (const pattern of patterns) {
      const files = await glob(pattern, {
        nodir: true,
        windowsPathsNoEscape: process.platform === "win32",
        absolute: true,
      });
      matches.push(...files);
    }

    return [...new Set(matches)]; // Remove duplicates
  }

  /**
   * Class files recompiled within the last few seconds in the given package
   * directories. Only reads those directories, never the whole output tree.
   */
  private async findRecentSiblingClasses(
    directories: Iterable<string>,
  ): Promise<string[]> {
    const cutoff = Date.now() - Builder.RECENT_CLASS_WINDOW_MS;
    const results: string[] = [];
    for (const directory of directories) {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".class")) {
          continue;
        }
        const file = path.join(directory, entry.name);
        try {
          if ((await fsp.stat(file)).mtimeMs > cutoff) {
            results.push(file);
          }
        } catch {
          // File removed between readdir and stat
        }
      }
    }
    return results;
  }

  /**
   * NEW: Handle compiled file changes with intelligent batch processing
   * Processes .class files from target/build directories with batch optimization
   */
  private handleCompiledFileChange(
    uri: vscode.Uri,
    eventType: "change" | "create" | "delete",
  ): void {
    const fileName = path.basename(uri.fsPath);
    const fileExt = path.extname(uri.fsPath).toLowerCase();

    if (this.shouldBypassFile(uri.fsPath)) {
      this.smartLog.debug(`Bypassing sync for compiled file: ${fileName}`);
      return;
    }

    // Only process .class files
    if (fileExt !== ".class") {
      this.smartLog.debug(`Skipping non-class file: ${fileName}`);
      return;
    }

    // Get relative path from workspace root
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }

    const relativePath = path.relative(workspaceRoot, uri.fsPath);
    this.smartLog.debug(`Compiled file ${eventType}: ${fileName} (${relativePath})`);

    // Use batch deployment for compiled files
    this.addToBatchDeployment(uri.fsPath, eventType);
  }

  /**
   * Determine whether a file should be bypassed from synchronization
   */
  private shouldBypassFile(filePath: string): boolean {
    if (!this.syncBypassPatterns.length) {
      return false;
    }

    const baseName = path.basename(filePath);
    return this.syncBypassPatterns.some((pattern) => pattern.test(baseName));
  }

  /**
   * NEW: Immediate deployment for static resources (no debouncing)
   */
  private async deployStaticResourceImmediately(
    filePath: string,
    eventType: "change" | "create" | "delete",
  ): Promise<void> {
    try {
      if (eventType === "delete") {
        await this.removeDeployedFile(filePath, "static");
        return;
      }

      // Find matching mapping for the source file
      const mapping = this.findMatchingMapping(filePath);
      if (!mapping) {
        const fileName = path.basename(filePath);
        this.smartLog.debug(`No mapping found for static resource: ${fileName}`);
        return;
      }

      // Generate destination path using mapping configuration
      const targetPath = await this.generateDestinationPath(mapping, filePath);
      if (!targetPath) {
        const fileName = path.basename(filePath);
        this.smartLog.warn(`Failed to generate target path for: ${fileName}`);
        return;
      }

      if (!(await this.copyFileWithLogging(filePath, targetPath, "static"))) {
        return;
      }
      this.scheduleReloadIfNeeded(mapping, filePath);

      const fileName = path.basename(filePath);
      const webappsRoot = await this.getTomcat().getWebappsRoot();
      const relativePath = webappsRoot
        ? path.relative(webappsRoot, targetPath)
        : path.basename(targetPath);
      this.smartLog.info(`Immediate deploy: ${fileName} → ${relativePath}`);
    } catch (error) {
      this.smartLog.error(
        `Static resource deployment failed for ${path.basename(filePath)}`,
        error as string,
      );
    }
  }

  /**
   * NEW: Add file to batch deployment queue with intelligent batching
   * Collects multiple class file changes and deploys them together
   */
  private addToBatchDeployment(
    filePath: string,
    eventType: "change" | "create" | "delete",
  ): void {
    const debounceTime = this.getConfiguration().get<number>(
      "smartDeployDebounce",
      300,
    );

    // Keep only the latest event per file so create+change collapse into one copy
    this.pendingCompiledFiles.set(filePath, eventType);

    this.smartLog.debug(
      `Added to batch: ${path.basename(filePath)} (${eventType}) - ${this.pendingCompiledFiles.size} files queued`,
    );

    // Clear existing batch timer and start new one
    if (this.batchDeploymentTimer) {
      clearTimeout(this.batchDeploymentTimer);
    }

    this.batchDeploymentTimer = setTimeout(async () => {
      await this.executeBatchDeployment();
    }, debounceTime);
  }

  /**
   * Execute batch deployment of all pending compiled files
   */
  private async executeBatchDeployment(): Promise<void> {
    // Serialize batches: wait for a running batch before starting the next one
    while (this.batchInFlight) {
      await this.batchInFlight;
    }
    const run = this.runBatchDeployment();
    this.batchInFlight = run;
    try {
      await run;
    } finally {
      this.batchInFlight = undefined;
    }
  }

  private async runBatchDeployment(): Promise<void> {
    if (this.pendingCompiledFiles.size === 0) {
      return;
    }

    const batchSize = this.pendingCompiledFiles.size;
    this.smartLog.info(`Executing batch deployment for ${batchSize} compiled files`);

    // Convert Set to array and parse file information
    const filesToDeploy = Array.from(this.pendingCompiledFiles).map(
      ([filePath, eventType]) => ({ filePath, eventType }),
    );

    // Clear pending files
    this.pendingCompiledFiles.clear();
    this.batchDeploymentTimer = undefined;

    let successCount = 0;
    let errorCount = 0;

    // Deploy all files in batch
    for (const { filePath, eventType } of filesToDeploy) {
      try {
        await this.executeCompiledFileDeployment(filePath, eventType);
        successCount++;
      } catch (error) {
        this.smartLog.error(
          `Batch deploy failed for ${path.basename(filePath)}`,
          error as string,
        );
        errorCount++;
      }
    }

    // Log batch results
    if (successCount > 0) {
      this.smartLog.info(
        `Batch deployment completed: ${successCount} files deployed`,
      );
    }
    if (errorCount > 0) {
      this.smartLog.warn(`Batch deployment had ${errorCount} errors`);
    }

  }

  /**
   * Execute compiled file deployment logic
   */
  private async executeCompiledFileDeployment(
    filePath: string,
    eventType: "change" | "create" | "delete",
  ): Promise<void> {
    if (eventType === "delete") {
      await this.removeDeployedFile(filePath, "class");
      return;
    }

    // Find matching mapping for the compiled .class file
    const mapping = this.findMatchingMapping(filePath);
    if (!mapping) {
      this.smartLog.debug(
        `No mapping found for compiled class: ${path.relative(this.getWorkspaceRoot() || "", filePath)}`,
      );
      return;
    }

    // Generate destination path using mapping configuration
    const targetPath = await this.generateDestinationPath(mapping, filePath);
    if (!targetPath) {
      this.smartLog.warn(
        `Failed to generate target path for: ${path.basename(filePath)}`,
      );
      return;
    }

    if (!(await this.copyFileWithLogging(filePath, targetPath, "class"))) {
      return;
    }
    this.scheduleReloadIfNeeded(mapping, filePath);

    const fileName = path.basename(filePath);
    const webappsRoot = await this.getTomcat().getWebappsRoot();
    const relativePath = webappsRoot
      ? path.relative(webappsRoot, targetPath)
      : path.basename(targetPath);
    this.smartLog.info(`Class deploy: ${fileName} → ${relativePath}`);
  }

  private async removeDeployedFile(
    filePath: string,
    type: "class" | "static",
  ): Promise<void> {
    const mapping = this.findMatchingMapping(filePath);
    if (!mapping) {
      this.smartLog.debug(
        `No mapping found for deleted ${type} file: ${path.basename(filePath)}`,
      );
      return;
    }

    const targetPath = await this.generateDestinationPath(mapping, filePath, {
      ensureParent: false,
    });
    if (!targetPath) {
      this.smartLog.warn(
        `Failed to generate delete target for: ${path.basename(filePath)}`,
      );
      return;
    }

    if (!fs.existsSync(targetPath)) {
      this.smartLog.debug(
        `Deployed ${type} file already absent: ${path.basename(targetPath)}`,
      );
      return;
    }

    await fsp.rm(targetPath, { force: true });
    this.deployedFingerprints.delete(targetPath);
    this.scheduleReloadIfNeeded(mapping, filePath);
    const webappsRoot = await this.getTomcat().getWebappsRoot();
    const relativePath = webappsRoot
      ? path.relative(webappsRoot, targetPath)
      : path.basename(targetPath);
    this.smartLog.info(`Removed deployed ${type}: ${relativePath}`);
  }

  /**
   * Copy file with progress indication and logging.
   * Returns false when the copy was skipped (source missing or already deployed).
   */
  private async copyFileWithLogging(
    source: string,
    target: string,
    type: "class" | "static" | "local",
  ): Promise<boolean> {
    let fingerprint: string;
    try {
      const stats = await fsp.stat(source);
      fingerprint = `${stats.mtimeMs}:${stats.size}`;
    } catch {
      this.smartLog.warn(
        `Smart deploy: Source file not found: ${path.basename(source)}`,
      );
      return false;
    }

    // Several triggers (watcher events, Java source scan) can target the same
    // file; skip the copy when this exact source version is already deployed.
    if (
      this.deployedFingerprints.get(target) === fingerprint &&
      fs.existsSync(target)
    ) {
      this.smartLog.debug(`Already deployed, skipping: ${path.basename(source)}`);
      return false;
    }

    // A full rebuild (e.g. Java language server start-up) rewrites every
    // class with identical bytes; don't touch targets Tomcat already has.
    if (await this.hasSameContent(source, target)) {
      this.deployedFingerprints.set(target, fingerprint);
      this.smartLog.debug(`Unchanged content, skipping: ${path.basename(source)}`);
      return false;
    }

    await fsp.mkdir(path.dirname(target), { recursive: true });
    await copyFileWithRetry(source, target);
    this.deployedFingerprints.set(target, fingerprint);

    const fileName = path.basename(source);
    const label =
      type === "class"
        ? "Smart deployed class"
        : type === "static"
          ? "Smart deployed static"
          : "Local mapping synced";
    this.smartLog.debug(`${label}: ${fileName}`);
    return true;
  }

  private async hasSameContent(source: string, target: string): Promise<boolean> {
    try {
      const [sourceStats, targetStats] = await Promise.all([
        fsp.stat(source),
        fsp.stat(target),
      ]);
      if (
        sourceStats.size !== targetStats.size ||
        sourceStats.size > Builder.CONTENT_COMPARE_LIMIT
      ) {
        return false;
      }
      const [a, b] = await Promise.all([
        fsp.readFile(source),
        fsp.readFile(target),
      ]);
      return a.equals(b);
    } catch {
      return false;
    }
  }

  /**
   * Restart Tomcat once after a burst of smart deploys touching mappings with
   * needsReload (classes, WEB-INF resources). Skipped while debugging, where
   * the Java debugger hot-swaps classes and a restart would kill the session.
   */
  private scheduleReloadIfNeeded(mapping: CompiledMapping, filePath: string): void {
    if (
      !mapping.needsReload ||
      !this.getConfiguration().get<boolean>("smartDeployReload", true)
    ) {
      return;
    }
    this.pendingReloadReasons.add(path.basename(filePath));
    this.reloadDebouncer.schedule("reload", Builder.RELOAD_SETTLE_MS, async () => {
      const reasons = [...this.pendingReloadReasons];
      this.pendingReloadReasons.clear();
      if (!reasons.length || this.autoDeployMode !== "Smart") {
        return;
      }
      const state = await this.getTomcat().getRunState();
      const summary =
        reasons.length > 3
          ? `${reasons.slice(0, 3).join(", ")} +${reasons.length - 3}`
          : reasons.join(", ");
      if (state === "stopped") {
        this.smartLog.debug(`Tomcat not running; reload skipped (${summary})`);
      } else if (state === "debug") {
        this.smartLog.info(
          `Debug mode: relying on debugger hot swap, Tomcat not restarted (${summary})`,
        );
      } else {
        this.smartLog.info(`Restarting Tomcat to apply: ${summary}`);
        await this.getTomcat().reload();
      }
    });
  }

  /**
   * Dispose smart deploy watchers (dual-watcher approach with batch cleanup)
   */
  public disposeSmartDeploy(): void {
    this.smartDeployGeneration++;
    this.disposeFileWatchers();

    // Clear batch deployment timer and pending files
    if (this.batchDeploymentTimer) {
      clearTimeout(this.batchDeploymentTimer);
      this.batchDeploymentTimer = undefined;
    }
    this.pendingCompiledFiles.clear();
    this.staticDebouncer.dispose();
    this.javaScanDebouncer.dispose();
    this.reloadDebouncer.dispose();
    this.pendingReloadReasons.clear();
    this.deployedFingerprints.clear();

    this.smartLog.debug("Smart deploy cleanup: All watchers and timers disposed");
  }

  /**
   * Project Scaffolding System
   *
   * Implements new project initialization with:
   * 1. User confirmation flow
   * 2. Extension dependency verification
   * 3. Maven archetype selection
   * 4. Workspace configuration
   * 5. Error recovery
   *
   */
  private async createNewProject(): Promise<void> {
    const answer = await vscode.window.showInformationMessage(
      "No Java EE project found. Do you want to create a new one?",
      "Yes",
      "No",
    );

    if (answer === "Yes") {
      try {
        const commands = await vscode.commands.getCommands();
        if (!commands.includes("java.project.create")) {
          const installMessage =
            "Java Extension Pack required for project creation";
          vscode.window
            .showErrorMessage(installMessage, "Install Extension")
            .then(async (choice) => {
              if (choice === "Install Extension") {
                await env.openExternal(
                  vscode.Uri.parse("vscode:extension/vscjava.vscode-java-pack"),
                );
              }
            });
          return;
        }

        await vscode.commands.executeCommand("java.project.create", {
          type: "maven",
          archetype: "maven-archetype-webapp",
        });
        this.getLogger().info("New Maven web app project created");
      } catch (err) {
        vscode.window
          .showErrorMessage(
            "Project creation failed. Ensure Java Extension Pack is installed and configured.",
            "Open Extensions",
          )
          .then((choice) => {
            if (choice === "Open Extensions") {
              vscode.commands.executeCommand(
                "workbench.extensions.action.showExtensions",
              );
            }
          });
      }
    } else {
      this.getLogger().success("Tomcat deploy canceled", true);
    }
  }

  /**
   * Local Deployment Strategy
   *
   * Implements direct file synchronization with:
   * 1. Web application directory validation
   * 2. Java source compilation
   * 3. Resource copying
   * 4. Dependency management
   * 5. Atomic deployment
   *
   * @param projectDir Source project directory
   * @param targetDir Target deployment directory
   * @param tomcatHome Tomcat installation directory
   * @throws Error if build fails or java source compilation fails or if webapp directory not found
   */
  private async localDeploy(
    projectDir: string,
    targetDir: string,
    tomcatHome: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
  ) {
    const report = (message: string, increment?: number) => {
      progress?.report({ message, increment });
    };

    const structure = this.projectStructure ?? this.detectProjectStructure();
    const webResourceCandidates = [
      ...(structure.webResourceRoots || []),
      path.join("src", "main", "webapp"),
    ];
    const webAppPath = this.findFirstExistingPath(
      projectDir,
      webResourceCandidates,
    );
    if (!webAppPath) {
      throw new Error(
        `Web resource directory not found. Checked: ${webResourceCandidates.join(", ")}`,
      );
    }
    const javaHome = await this.getTomcat().findJavaHome();
    if (!javaHome) {
      return;
    }

    report("Validating project layout...", 5);

    const javacPath = path.join(javaHome, "bin", "javac");
    const classesDir = path.join(targetDir, "WEB-INF", "classes");

    report("Synchronizing web resources...", 25);
    await DirectorySynchronizer.sync(webAppPath, targetDir, {
      preserveRuntimeFolders: true,
      onCleanupError: (message) => this.smartLog.debug(message),
    });

    report("Refreshing compiled output...", 10);
    await fsp.rm(classesDir, { force: true, recursive: true });
    await fsp.mkdir(classesDir, { recursive: true });

    const javaSourceRoots =
      structure.javaSourceRoots && structure.javaSourceRoots.length > 0
        ? structure.javaSourceRoots
        : [path.join("src", "main", "java")];

    const javaFiles = new Set<string>();
    for (const sourceRoot of javaSourceRoots) {
      const sourcePath = this.findFirstExistingPath(projectDir, [sourceRoot]);
      if (!sourcePath) {
        continue;
      }
      const files = await this.findFiles(path.join(sourcePath, "**", "*.java"));
      files.forEach((file) => javaFiles.add(file));
    }

    if (javaFiles.size > 0) {
      report("Compiling Java sources...", 35);
      const classpathEntries = new Set<string>();
      const addClasspathDir = (dir: string) => {
        try {
          if (!dir) {
            return;
          }
          if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
            classpathEntries.add(path.join(dir, "*"));
          }
        } catch {
          // ignore inaccessible directories
        }
      };

      classpathEntries.add(path.join(tomcatHome, "lib", "*"));
      addClasspathDir(path.join(projectDir, "lib"));

      if (webAppPath) {
        addClasspathDir(path.join(webAppPath, "WEB-INF", "lib"));
      }

      addClasspathDir(path.join(targetDir, "WEB-INF", "lib"));

      // For Eclipse projects, also include libraries from .classpath
      const eclipseLibs = this.parseEclipseClasspathLibs(projectDir);
      for (const lib of eclipseLibs) {
        if (fs.existsSync(lib)) {
          classpathEntries.add(lib);
        }
      }
      if (eclipseLibs.length > 0) {
        this.smartLog.debug(
          `Added ${eclipseLibs.length} Eclipse .classpath libraries to javac classpath`,
        );
      }

      const classpath = Array.from(classpathEntries).join(path.delimiter);
      const compileTargets = Array.from(javaFiles);

      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "turbocat-javac-"));
      const argsFile = path.join(tempDir, "sources.args");
      const argsFileContent = compileTargets
        .map((filePath) => `"${filePath.replace(/"/g, '\\"')}"`)
        .join(os.EOL);

      await fsp.writeFile(argsFile, argsFileContent, "utf8");

      const javacArgs: string[] = [];
      if (this.compileEncoding) {
        javacArgs.push("-encoding", this.compileEncoding);
      }
      javacArgs.push("-d", classesDir, "-cp", classpath, `@${argsFile}`);

      try {
        await this.executeCommandSpawn(javacPath, javacArgs, projectDir);
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    } else {
      report("No Java sources detected, skipping compilation", 35);
    }

    report("Applying workspace mappings...", 15);
    await this.applyLocalDeployMappings();

    const libDir = path.join(projectDir, "lib");
    const targetLib = path.join(targetDir, "WEB-INF", "lib");
    if (fs.existsSync(libDir)) {
      report("Updating libraries...", 10);
      await DirectorySynchronizer.sync(libDir, targetLib);
    } else {
      report("Library updates skipped", 10);
    }

    report("Local deployment complete", 0);

    // Ensure META-INF exists with MANIFEST.MF (normally generated by Maven)
    await this.ensureMetaInf(
      path.join(targetDir, "META-INF"),
      path.basename(targetDir),
    );
  }

  /**
   * Apply additional local deploy mappings defined in the workspace configuration.
   */
  private async applyLocalDeployMappings(): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }

    const tomcatHome = await this.getTomcat().findTomcatHome();
    if (!tomcatHome) {
      return;
    }

    try {
      if (!this.smartDeployConfig) {
        this.smartDeployConfig = await this.loadSmartDeployConfig();
      }

      if (!this.smartDeployConfig) {
        return;
      }

      if (!this.compiledMappings) {
        this.compiledMappings = this.compileMappings(this.smartDeployConfig);
      }

      const localMappings = (this.compiledMappings || []).filter(
        (mapping) => mapping.origin === "local",
      );
      if (!localMappings.length) {
        return;
      }

      const visitedTargets = new Set<string>();

      for (const mapping of localMappings) {
        const absolutePattern = path.join(workspaceRoot, mapping.source);
        const matches = await glob(absolutePattern, {
          nodir: true,
          windowsPathsNoEscape: process.platform === "win32",
        });

        if (!matches.length) {
          this.smartLog.debug(
            `Local deploy mapping "${mapping.source}" did not match any files.`,
          );
          continue;
        }

        for (const sourceFile of matches) {
          const targetPath = await this.generateDestinationPath(
            mapping,
            sourceFile,
          );
          if (!targetPath) {
            continue;
          }

          let targetKey = targetPath;
          try {
            const stats = fs.statSync(sourceFile);
            targetKey = `${targetPath}|${stats.mtimeMs}`;
          } catch {
            // ignore stat errors; still attempt to copy
          }

          if (!visitedTargets.has(targetKey)) {
            await this.copyFileWithLogging(sourceFile, targetPath, "local");
            visitedTargets.add(targetKey);
          }
        }
      }
    } catch (error) {
      this.smartLog.warn(`Local deploy mapping sync skipped: ${error}`);
    }
  }

  /**
   * PreBuilt Deployment — uses pre-compiled output + static web resources.
   *
   * Works for both Maven (target/classes) and Eclipse (bin/) projects.
   * Skips build tools entirely: the Java Language Server / Eclipse compiler
   * already produces .class files on every save.
   */
  private async preBuiltDeploy(
    projectDir: string,
    targetDir: string,
    _tomcatHome: string,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
  ) {
    const report = (message: string, increment?: number) => {
      progress?.report({ message, increment });
    };

    const structure = this.projectStructure ?? this.detectProjectStructure();
    const isMaven = structure.type === "maven";

    // Validate at least one build marker exists
    const hasPom = fs.existsSync(path.join(projectDir, "pom.xml"));
    const hasClasspath = fs.existsSync(path.join(projectDir, ".classpath"));
    if (!hasPom && !hasClasspath) {
      throw new Error(
        "PreBuilt requires pom.xml (Maven) or .classpath (Eclipse).",
      );
    }

    // Determine the compiled output directory
    const classDirectories = isMaven
      ? [path.join(projectDir, "target", "classes")]
      : EclipseMetadataParser.parseClasspath(projectDir).outputDirectories
          .map((output) => path.join(projectDir, output))
          .filter((output) => fs.existsSync(output));
    const classesDir = classDirectories[0] ??
      path.join(projectDir, structure.javaOutputDir || "bin");

    report("Validating pre-built output...", 5);
    if (!fs.existsSync(classesDir)) {
      const hint = isMaven
        ? "Run mvn compile or let the Java Language Server build the project."
        : "Build the project in Eclipse or let the Java Language Server compile it.";
      throw new Error(`${classesDir} not found. ${hint}`);
    }

    report("Synchronizing web resources...", 20);
    const webAppCandidates = [
      ...(structure.webResourceRoots || []),
      ...(isMaven
        ? [path.join("src", "main", "webapp")]
        : ["WebContent", "web"]),
    ];
    const webAppPaths = [
      ...new Set(
        webAppCandidates
          .filter(Boolean)
          .map((candidate) =>
            path.isAbsolute(candidate)
              ? candidate
              : path.join(projectDir, candidate.replace(/^[/\\]+/, "")),
          )
          .filter((candidate) => fs.existsSync(candidate)),
      ),
    ];
    if (webAppPaths.length > 0) {
      await DirectorySynchronizer.syncAll(webAppPaths, targetDir, {
        preserveRuntimeFolders: true,
        onCleanupError: (message) => this.smartLog.debug(message),
      });
    } else if (!isMaven) {
      this.smartLog.warn(
        "PreBuilt: no web resource directory found. Checked: " +
          webAppCandidates.join(", "),
      );
    }

    report("Copying compiled classes...", 30);
    const targetClassesDir = path.join(targetDir, "WEB-INF", "classes");
    if (classDirectories.length > 1) {
      await DirectorySynchronizer.syncAll(classDirectories, targetClassesDir);
    } else {
      await DirectorySynchronizer.sync(classesDir, targetClassesDir);
    }

    const classCount = await this.countFilesRecursive(targetClassesDir);
    if (classCount === 0) {
      this.smartLog.warn(
        `PreBuilt: no class files deployed to ${targetClassesDir}. ` +
          `Source ${classesDir} may be empty.`,
      );
    } else {
      this.smartLog.info(
        `PreBuilt: deployed ${classCount} compiled files to WEB-INF/classes`,
      );
    }

    report("Updating libraries...", 15);
    const targetLibDir = path.join(targetDir, "WEB-INF", "lib");
    if (isMaven) {
      const depLibDir = path.join(projectDir, "target", "dependency");
      if (fs.existsSync(depLibDir)) {
        await DirectorySynchronizer.sync(depLibDir, targetLibDir);
      }
    }
    const projectLibDir = path.join(projectDir, "lib");
    if (fs.existsSync(projectLibDir)) {
      await DirectorySynchronizer.sync(projectLibDir, targetLibDir);
    }

    report("Applying workspace mappings...", 10);
    await this.applyLocalDeployMappings();

    report("Pre-built deployment complete", 0);

    await this.ensureMetaInf(
      path.join(targetDir, "META-INF"),
      path.basename(targetDir),
    );
  }

  /**
   * Maven Build Strategy
   *
   * Implements full Maven lifecycle integration with:
   * 1. POM validation
   * 2. Clean package execution
   * 3. Error analysis
   * 4. Artifact handling
   * 5. Deployment synchronization
   *
   * @param projectDir Source project directory
   * @param targetDir Target deployment directory
   * @throws Error if Maven build fails or artifact not found
   */
  private async mavenDeploy(projectDir: string, targetDir: string) {
    if (!fs.existsSync(path.join(projectDir, "pom.xml"))) {
      throw new Error("pom.xml not found.");
    }

    try {
      // Inject JAVA_HOME from TurboCat config so mvn works even
      // when the system PATH does not include a JDK.
      const javaHome = await this.getTomcat().findJavaHome();
      const mavenHome = this.getConfiguration().get<string>(
        "mavenHome",
        "",
      );
      const mvnEnv: Record<string, string> = {};
      if (javaHome && !process.env.JAVA_HOME) {
        mvnEnv["JAVA_HOME"] = javaHome;
        this.getLogger().info(`Using JAVA_HOME=${javaHome} for Maven build`);
      }
      if (mavenHome && !process.env.MAVEN_HOME) {
        mvnEnv["MAVEN_HOME"] = mavenHome;
      }

      // Use absolute mvn path when mavenHome is configured
      const mvnCmd = mavenHome
        ? path.join(
            mavenHome,
            "bin",
            `mvn${process.platform === "win32" ? ".cmd" : ""}`,
          )
        : "mvn";
      this.getLogger().info(`Maven command: ${mvnCmd} clean package`);

      await this.executeCommandSpawn(
        mvnCmd,
        ["clean", "package"],
        projectDir,
        Object.keys(mvnEnv).length ? mvnEnv : undefined,
      );
    } catch (err) {
      const errorOutput = err?.toString() || "";

      // Log the full raw output first so it appears in the TurboCat channel
      if (errorOutput.trim()) {
        this.getLogger().error(`Maven build failed. Raw output:`, false);
        errorOutput.split("\n").forEach((line) => {
          if (line.trim()) {
            this.getLogger().appendRawLine(`  ${line.trim()}`);
          }
        });
      }

      const lines = errorOutput
        .split("\n")
        .filter(
          (line) =>
            line.includes("[ERROR]") &&
            !line.includes("re-run Maven") &&
            !line.includes("[Help") &&
            !line.includes("Re-run Maven") &&
            !line.includes("For more information") &&
            !line.includes("http"),
        )
        .map((line) => line.replace("[ERROR]", "\t\t"));

      const uniqueLines = [...new Set(lines)];
      const message = uniqueLines.join("\n");

      // If no structured [ERROR] lines were found, include the raw output
      // so the user can see what went wrong (e.g., mvn not on PATH).
      if (!message.trim() && errorOutput.trim()) {
        throw new Error(
          `Maven command failed. Output:\n${errorOutput.trim().substring(0, 500)}`,
        );
      }
      throw new Error(message);
    }

    const targetPath = path.join(projectDir, "target");
    const warFiles = (await fsp.readdir(targetPath))
      .filter((file: string) => file.toLowerCase().endsWith(".war"));
    if (warFiles.length === 0) {
      throw new Error("No WAR file found after Maven build.");
    }

    const warFileName = warFiles[0];
    const warFilePath = path.join(targetPath, warFileName);

    const warBaseName = path.basename(warFileName, ".war");
    const warFolderPath = path.join(targetPath, warBaseName);

    await fsp.rm(targetDir, { recursive: true, force: true });
    await fsp.rm(`${targetDir}.war`, { force: true });

    await fsp.copyFile(warFilePath, `${targetDir}.war`);

    if (fs.existsSync(warFolderPath)) {
      await fsp.mkdir(targetDir, { recursive: true });
      await this.copyDirectory(warFolderPath, targetDir);
    }
  }

  /**
   * Gradle Build Strategy
   *
   * Implements Gradle integration with:
   * 1. Build script validation
   * 2. War task execution
   * 3. Artifact naming control
   * 4. Deployment synchronization
   * 5. Cleanup procedures
   *
   * @param projectDir Source project directory
   * @param targetDir Target deployment directory
   * @param appName Application name for artifact naming
   * @throws Error if Gradle build fails or artifact not found
   */
  private async gradleDeploy(
    projectDir: string,
    targetDir: string,
    appName: string,
  ) {
    if (!fs.existsSync(path.join(projectDir, "build.gradle"))) {
      throw new Error("build.gradle not found.");
    }

    const gradleCmd =
      process.platform === "win32" ? "gradlew.bat" : "./gradlew";
    await this.executeCommandSpawn(
      gradleCmd,
      ["war", `-PfinalName=${appName}`],
      projectDir,
    );

    const warFile = path.join(projectDir, "build", "libs", `${appName}.war`);
    if (!fs.existsSync(warFile)) {
      throw new Error("No WAR file found after Gradle build.");
    }

    await fsp.rm(targetDir, { recursive: true, force: true });
    await fsp.rm(`${targetDir}.war`, { recursive: true, force: true });
    await fsp.copyFile(warFile, `${targetDir}.war`);
  }

  /**
   * File System Utility - Pattern Matching
   *
   * Implements robust file discovery with:
   * - Cross-platform path handling
   * - Absolute path resolution
   * - Directory exclusion
   * - Windows path escaping
   *
   * @param pattern Glob pattern for file matching
   * @returns Array of matching file paths
   * @throws Error if file discovery fails
   */
  private async findFiles(pattern: string): Promise<string[]> {
    return await glob(pattern, {
      nodir: true,
      windowsPathsNoEscape: process.platform === "win32",
      absolute: true,
    });
  }

  /**
   * Command Execution Wrapper
   *
   * Provides robust command execution with:
   * - Working directory control
   * - Error aggregation
   * - Promise-based interface
   * - Output capture
   *
   * @param command Command to execute
   * @param cwd Working directory for execution
   * @returns Promise resolving on success, rejecting on error
   * @throws Error if command execution fails
   */
  /**
   * Spawn-based command execution for commands with paths that may contain spaces.
   * Passes arguments as an array so the shell does not misinterpret whitespace.
   */
  private async executeCommandSpawn(
    command: string,
    args: string[],
    cwd: string,
    extraEnv?: Record<string, string>,
  ): Promise<void> {
    return CommandRunner.execute(command, args, cwd, extraEnv);
  }

  /**
   * Resolve the first existing path from the provided candidates.
   */
  private findFirstExistingPath(
    baseDir: string,
    candidates: string[],
  ): string | null {
    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const normalized = candidate.replace(/^[/\\]+/, "");
      const absolutePath = path.isAbsolute(normalized)
        ? normalized
        : path.join(baseDir, normalized);

      if (fs.existsSync(absolutePath)) {
        return absolutePath;
      }
    }

    return null;
  }

  /**
   * Directory Copy Utility
   *
   * Implements recursive directory copy with:
   * - Recursive structure preservation
   * - File type handling
   * - Atomic operations
   * - Error-tolerant implementation
   *
   * @param src Source directory path
   * @param dest Target directory path
   * @throws Error if directory copy fails
   */
  private async copyDirectory(src: string, dest: string): Promise<void> {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      try {
        await fsp.rm(destPath, { force: true, recursive: true });
      } catch (e) {
        this.smartLog.debug(`Failed to remove ${destPath}: ${e}`);
      }

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        try {
          await fsp.copyFile(srcPath, destPath);
        } catch (e) {
          this.smartLog.warn(`Failed to copy ${srcPath} → ${destPath}: ${e}`);
        }
      }
    }
  }

  /**
   * Count files recursively (helper for pre-built deploy verification).
   */
  private async countFilesRecursive(dir: string): Promise<number> {
    if (!fs.existsSync(dir)) {
      return 0;
    }
    let count = 0;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += await this.countFilesRecursive(path.join(dir, entry.name));
      } else {
        count++;
      }
    }
    return count;
  }

  /**
   * Ensure META-INF directory exists at the deployed webapp root with a
   * minimal MANIFEST.MF. Normally created by Maven's package phase;
   * PreBuilt and Local deploys skip Maven so this compensates.
   */
  private async ensureMetaInf(metaInfPath: string, appName: string): Promise<void> {
    await fsp.mkdir(metaInfPath, { recursive: true });
    const manifestPath = path.join(metaInfPath, "MANIFEST.MF");
    if (!fs.existsSync(manifestPath)) {
      const manifest = [
        "Manifest-Version: 1.0",
        `Implementation-Title: ${appName}`,
        `Implementation-Version: 1.0`,
        "",
      ].join("\n");
      await fsp.writeFile(manifestPath, manifest, "utf-8");
      this.smartLog.info("Generated META-INF/MANIFEST.MF for deployed webapp");
    }
  }

  /**
   * Atomic File Synchronization Utility
   *
   * Implements aggressive directory synchronization with:
   * 1. Delta-based file copying (only changed files)
   * 2. Clean target directory pruning (removes orphaned files)
   * 3. Recursive directory handling
   * 4. Atomic write operations
   * 5. Error-resilient implementation
   *
   * Operation Flow:
   * 1. Scans source directory to determine required files
   * 2. Removes any target files not present in source (clean sync)
   * 3. Creates destination directory structure if missing
   * 4. Performs file-by-file copy with error recovery
   *
   * Special Features:
   * - Forceful overwrite mode (retries on failure)
   * - Recursive directory handling
   * - Minimal filesystem operations
   * - Cross-platform path handling
   *
   * @param src Source directory path (must exist)
   * @param dest Target directory path (will be created/cleaned)
   * @throws Error if critical filesystem operations fail
   */
  /**
   * Enhanced Smart Deploy Configuration Management
   */

  /**
   * Load or create smart deploy configuration
   */
  private async loadSmartDeployConfig(): Promise<SmartDeployConfig> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("No workspace folder found");
    }

    const configPath = path.join(workspaceRoot, Builder.CONFIG_FILE);

    // Priority 1: Try to load from Maven pom.xml if available
    const mavenParser = new MavenConfigParser(workspaceRoot, this.getLogger());
    if (mavenParser.isProjectSupported()) {
      try {
        this.smartLog.info("Loading smart deploy configuration from Maven pom.xml");
        const mappings = await mavenParser.parseResourceMappings();
        const webappConfig = await mavenParser.parseWebappConfiguration();
        this.defaultSmartDeployWebappName = webappConfig.webappName;
        const effectiveWebappName = this.resolveWebappName(
          this.defaultSmartDeployWebappName,
        );

        const mavenConfig: SmartDeployConfig = {
          projectType: "maven",
          webappName: effectiveWebappName,
          mappings: mappings,
          settings: {
            debounceTime: this.getConfiguration().get<number>(
              "smartDeployDebounce",
              300,
            ),
            enabled: true,
            logLevel: "info",
          },
        };

        this.smartLog.info(
          `Loaded smart deploy configuration from Maven pom.xml: ${mappings.length} mappings`,
        );
        return mavenConfig;
      } catch (error) {
        this.smartLog.warn(
          `Failed to parse Maven configuration, falling back to custom/default config: ${error}`,
        );
      }
    }

    // Priority 2: Try to load from custom config file
    if (fs.existsSync(configPath)) {
      try {
        const configContent = await fsp.readFile(configPath, "utf-8");
        const config = JSON.parse(configContent) as SmartDeployConfig;
        this.ensureLocalDeployStructure(config);
        this.defaultSmartDeployWebappName = config.webappName;
        const resolvedConfig: SmartDeployConfig = {
          ...config,
          webappName: this.resolveWebappName(this.defaultSmartDeployWebappName),
        };
        this.smartLog.info(
          "Loaded smart deploy configuration from custom config file",
        );
        return resolvedConfig;
      } catch (error) {
        this.smartLog.warn("Failed to parse smart deploy config, using defaults");
      }
    }

    // Priority 3: Create default configuration using detected project roots.
    // For Eclipse projects this incorporates WTP-derived webResourceRoots and
    // javaSourceRoots so the generated JSON reflects reality, not a template.
    this.projectStructure = this.detectProjectStructure();
    this.defaultSmartDeployWebappName = this.projectStructure.defaultWebappName;
    const baseMappings =
      DEFAULT_MAPPINGS[this.projectStructure.type] || DEFAULT_MAPPINGS.plain;
    const wtpMappings = this.buildWtpSmartDeployMappings(workspaceRoot);
    const defaultConfig: SmartDeployConfig = {
      projectType: this.projectStructure.type,
      webappName: this.projectStructure.webappName,
      mappings: wtpMappings.length > 0 ? wtpMappings : baseMappings,
      settings: {
        debounceTime: this.getConfiguration().get<number>(
          "smartDeployDebounce",
          300,
        ),
        enabled: true,
        logLevel: "info",
      },
    };

    this.ensureLocalDeployStructure(defaultConfig, { injectTemplate: true });

    // Save default configuration
    await this.saveSmartDeployConfig(defaultConfig);
    this.smartLog.info("Created default smart deploy configuration");
    return defaultConfig;
  }

  /**
   * Save smart deploy configuration to file
   */
  private async saveSmartDeployConfig(
    config: SmartDeployConfig,
  ): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return;
    }

    const configPath = path.join(workspaceRoot, Builder.CONFIG_FILE);
    const configDir = path.dirname(configPath);

    // Ensure .vscode directory exists
    await fsp.mkdir(configDir, { recursive: true });

    // Write configuration file
    const configJson = JSON.stringify(config, null, 2);
    await fsp.writeFile(configPath, configJson, "utf-8");
  }

  /**
   * Compile mappings for runtime efficiency with cross-platform support
   */
  private compileMappings(config: SmartDeployConfig): CompiledMapping[] {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return [];
    }

    const combinedMappings = this.buildCombinedMappings(config);

    return combinedMappings.map(({ mapping, origin }) => {
      const absoluteSource = path.join(workspaceRoot, mapping.source);
      const absoluteDestination = mapping.destination;

      // Convert glob pattern to regex for file matching with platform-specific logic
      let regexPattern = this.globToRegex(mapping.source);

      // Anchor the pattern to match from start to end
      const sourceRegex = new RegExp(`^${regexPattern}$`);

      this.smartLog.debug(
        `[${process.platform}] Compiled mapping: "${mapping.source}" -> regex: ${sourceRegex} (origin: ${origin})`,
      );

      return {
        ...mapping,
        absoluteSource,
        absoluteDestination,
        sourceRegex,
        origin,
      };
    });
  }

  /**
   * Combine smart deploy mappings with local deploy overrides.
   */
  private buildCombinedMappings(
    config: SmartDeployConfig,
  ): Array<{ mapping: SmartDeployMapping; origin: "smart" | "local" }> {
    const combined: Array<{
      mapping: SmartDeployMapping;
      origin: "smart" | "local";
    }> = [];
    const seen = new Set<string>();

    const pushMapping = (
      mapping: SmartDeployMapping,
      origin: "smart" | "local",
    ) => {
      const key = `${mapping.source}|${mapping.destination}`;
      if (seen.has(key)) {
        this.smartLog.debug(
          `Skipping duplicate mapping override for ${mapping.source} → ${mapping.destination} (${origin})`,
        );
        return;
      }
      seen.add(key);
      combined.push({ mapping, origin });
    };

    const localMappings = config.localDeploy?.mappings ?? [];
    localMappings
      .filter((mapping) => mapping && mapping.enabled !== false)
      .forEach((mapping) =>
        pushMapping(this.transformLocalMapping(mapping), "local"),
      );

    if (Array.isArray(config.mappings)) {
      config.mappings.forEach((mapping) => pushMapping(mapping, "smart"));
    }

    return combined;
  }

  /**
   * Convert local deploy mapping entries to smart deploy mappings.
   */
  private transformLocalMapping(
    mapping: LocalDeployMapping,
  ): SmartDeployMapping {
    const normalizedSource = this.normalizeLocalMappingSource(mapping.source);
    const normalizedDestination = this.normalizeLocalMappingDestination(
      mapping.destination,
    );

    return {
      source: normalizedSource,
      destination: normalizedDestination,
      needsReload: mapping.needsReload ?? false,
      description:
        mapping.description ||
        `Local deploy mapping (${normalizedSource} → ${normalizedDestination})`,
      extensions: mapping.extensions,
      excludeExtensions: mapping.excludeExtensions,
    };
  }

  private normalizeLocalMappingSource(source: string): string {
    if (!source) {
      return "**/*";
    }

    let normalized = source.replace(/\\/g, "/").replace(/^\/+/, "");

    const hasWildcard = /[*?]/.test(normalized);
    if (hasWildcard) {
      return normalized;
    }

    normalized = normalized.replace(/\/+$/, "");
    if (!normalized) {
      return "**/*";
    }

    const ext = path.extname(normalized);
    if (ext) {
      return normalized;
    }

    return `${normalized}/**/*`;
  }

  private normalizeLocalMappingDestination(destination: string): string {
    if (!destination) {
      return "{relative}";
    }

    let normalized = destination.replace(/\\/g, "/").replace(/^\/+/, "");

    if (!normalized.includes("{relative}")) {
      normalized = normalized.replace(/\/+$/, "");
      normalized = normalized ? `${normalized}/{relative}` : "{relative}";
    }

    return normalized;
  }

  private getMappingRoot(sourcePattern: string): string | null {
    if (!sourcePattern) {
      return null;
    }

    const normalized = sourcePattern.replace(/\\/g, "/").replace(/^\/+/, "");
    const wildcardIndex = normalized.search(/[*?]/);
    if (wildcardIndex >= 0) {
      return normalized.substring(0, wildcardIndex).replace(/\/+$/, "") || null;
    }

    return normalized.replace(/\/+$/, "") || null;
  }

  private resolveCompiledOutputDirectories(): string[] {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return [];
    }

    if (
      (!this.compiledMappings || !this.compiledMappings.length) &&
      this.smartDeployConfig
    ) {
      this.compiledMappings = this.compileMappings(this.smartDeployConfig);
    }

    const outputs = new Set<string>();

    if (this.compiledMappings) {
      for (const mapping of this.compiledMappings) {
        const isClassMapping =
          (mapping.extensions && mapping.extensions.includes(".class")) ||
          mapping.source.toLowerCase().includes(".class");

        if (!isClassMapping) {
          continue;
        }

        const root = this.getMappingRoot(mapping.source);
        if (root) {
          outputs.add(path.join(workspaceRoot, root));
        }
      }
    }

    if (!outputs.size) {
      switch (this.projectStructure?.type) {
        case "maven":
          outputs.add(path.join(workspaceRoot, "target/classes"));
          break;
        case "gradle":
          outputs.add(path.join(workspaceRoot, "build/classes/java/main"));
          break;
        default:
          outputs.add(path.join(workspaceRoot, "bin"));
          break;
      }
    }

    return Array.from(outputs);
  }

  private ensureLocalDeployStructure(
    config: SmartDeployConfig,
    options?: { injectTemplate?: boolean },
  ): void {
    if (!config.localDeploy || !Array.isArray(config.localDeploy.mappings)) {
      config.localDeploy = { mappings: [] };
    }

    const shouldInjectTemplate =
      options?.injectTemplate &&
      ["plain", "eclipse"].includes(config.projectType) &&
      config.localDeploy.mappings.length === 0;

    if (shouldInjectTemplate) {
      config.localDeploy.mappings.push({
        description: "Example: copy conf directory into WEB-INF/classes/conf",
        source: "conf",
        destination: "WEB-INF/classes/conf",
        enabled: false,
        needsReload: false,
      });
    }
  }

  /**
   * Convert glob pattern to regex with proper cross-platform support
   */
  private globToRegex(globPattern: string): string {
    return globToRegex(globPattern);
  }

  /**
   * Check if a file matches any compiled mapping with enhanced debugging
   */
  private findMatchingMapping(filePath: string): CompiledMapping | null {
    if (!this.compiledMappings) {
      return null;
    }

    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return null;
    }

    // Normalize paths for cross-platform compatibility
    const relativePath = path
      .relative(workspaceRoot, filePath)
      .replace(/\\/g, "/");

    for (const mapping of this.compiledMappings) {
      const regexMatch = mapping.sourceRegex.test(relativePath);

      if (regexMatch) {
        const ext = path.extname(filePath).toLowerCase();

        if (mapping.extensions) {
          if (!mapping.extensions.includes(ext)) {
            continue;
          }
        }

        if (mapping.excludeExtensions) {
          if (mapping.excludeExtensions.includes(ext)) {
            continue;
          }
        }

        this.smartLog.debug(`Matched: ${relativePath} → ${mapping.description}`);
        return mapping;
      }
    }

    this.smartLog.debug(`No mapping for: ${relativePath}`);
    return null;
  }

  /**
   * Generate destination path from mapping and source file with proper relative path handling
   */
  private async generateDestinationPath(
    mapping: CompiledMapping,
    sourceFile: string,
    options: { ensureParent?: boolean } = {},
  ): Promise<string> {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return "";
    }

    const webappsRoot = await this.getTomcat().getWebappsRoot();
    if (!webappsRoot) {
      return "";
    }

    // Get the webapp directory
    const webappDir = path.join(
      webappsRoot,
      this.projectStructure?.webappName || "",
    );

    // Get relative path from workspace
    const relativePath = path.relative(workspaceRoot, sourceFile);

    // Extract the correct relative portion based on the mapping source pattern
    const relativePortion = this.extractRelativePortionFromMapping(
      mapping,
      relativePath,
      sourceFile,
    );

    // Replace {relative} placeholder with actual relative path
    let destinationPath = mapping.destination;
    if (destinationPath.includes("{relative}")) {
      destinationPath = destinationPath.replace("{relative}", relativePortion);
    } else {
      // If no placeholder, ensure destination includes the relative path
      destinationPath = path.join(destinationPath, relativePortion);
    }

    // Create full destination path
    const fullDestinationPath = path.join(webappDir, destinationPath);

    if (options.ensureParent !== false) {
      const targetDir = path.dirname(fullDestinationPath);
      await fsp.mkdir(targetDir, { recursive: true });
    }

    this.smartLog.debug(`Path mapping: ${relativePath} → ${destinationPath}`);
    return fullDestinationPath;
  }

  /**
   * Extract the correct relative portion from mapping pattern with enhanced cross-platform support
   */
  private extractRelativePortionFromMapping(
    mapping: CompiledMapping,
    relativePath: string,
    sourceFile: string,
  ): string {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return path.basename(sourceFile);
    }

    // Normalize all paths to use forward slashes for consistent processing
    const sourcePattern = this.normalizePath(mapping.source);
    const normalizedRelativePath = this.normalizePath(relativePath);

    this.smartLog.debug(
      `[${process.platform}] Extracting relative portion for pattern: ${sourcePattern}`,
    );
    this.smartLog.debug(
      `[${process.platform}] File relative path: ${normalizedRelativePath}`,
    );

    // Handle different pattern types with enhanced cross-platform logic
    if (sourcePattern.includes("**/*")) {
      // Pattern like 'target/classes/**/*.class'
      const basePath = sourcePattern.split("/**")[0]; // Get 'target/classes'

      // Use more robust path matching
      if (this.pathStartsWith(normalizedRelativePath, basePath)) {
        const afterBasePath = normalizedRelativePath
          .substring(basePath.length)
          .replace(/^\/+/, "");
        this.smartLog.debug(
          `[${process.platform}] Extracted relative portion: ${afterBasePath}`,
        );
        return afterBasePath;
      }
    } else if (sourcePattern.includes("**/")) {
      // Pattern like 'src/**/filename'
      const parts = sourcePattern.split("**/");
      if (parts.length >= 2) {
        const basePath = parts[0].replace(/\/+$/, ""); // Remove trailing slashes
        if (this.pathStartsWith(normalizedRelativePath, basePath)) {
          const afterBasePath = normalizedRelativePath
            .substring(basePath.length)
            .replace(/^\/+/, "");
          this.smartLog.debug(
            `[${process.platform}] Extracted relative portion (recursive): ${afterBasePath}`,
          );
          return afterBasePath;
        }
      }
    } else if (sourcePattern.includes("*")) {
      // Simple wildcard pattern - use cross-platform path.dirname
      const basePath = this.normalizePath(path.dirname(sourcePattern));
      if (
        basePath !== "." &&
        this.pathStartsWith(normalizedRelativePath, basePath)
      ) {
        const afterBasePath = normalizedRelativePath
          .substring(basePath.length)
          .replace(/^\/+/, "");
        this.smartLog.debug(
          `[${process.platform}] Extracted relative portion (wildcard): ${afterBasePath}`,
        );
        return afterBasePath;
      }
    }

    // Fallback: for class files, try to preserve package structure
    if (sourceFile.endsWith(".class")) {
      return this.extractClassRelativePath(sourceFile, normalizedRelativePath);
    }

    // Default fallback
    this.smartLog.debug(
      `[${process.platform}] Using basename fallback: ${path.basename(sourceFile)}`,
    );
    return path.basename(sourceFile);
  }

  /**
   * Normalize path separators for cross-platform consistency
   */
  private normalizePath(inputPath: string): string {
    return inputPath.replace(/\\/g, "/");
  }

  /**
   * Check if a path starts with a given prefix, handling edge cases
   */
  private pathStartsWith(fullPath: string, prefix: string): boolean {
    if (!prefix || prefix === ".") {
      return true;
    }

    const normalizedPrefix = prefix.replace(/\/+$/, ""); // Remove trailing slashes
    return (
      fullPath === normalizedPrefix ||
      fullPath.startsWith(normalizedPrefix + "/")
    );
  }

  /**
   * Extract relative path for class files preserving package structure with cross-platform support
   */
  private extractClassRelativePath(
    sourceFile: string,
    relativePath: string,
  ): string {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot || !this.projectStructure) {
      return path.basename(sourceFile);
    }

    // Determine the output directory based on project type
    let outputPattern: string;
    switch (this.projectStructure.type) {
      case "maven":
        outputPattern = "target/classes";
        break;
      case "gradle":
        outputPattern = "build/classes/java/main";
        break;
      default:
        outputPattern = "bin";
        break;
    }

    // Normalize paths for cross-platform consistency
    const normalizedOutputPattern = this.normalizePath(outputPattern);
    const normalizedRelativePath = this.normalizePath(relativePath);

    this.smartLog.debug(
      `[${process.platform}] Class path extraction - Output pattern: ${normalizedOutputPattern}`,
    );
    this.smartLog.debug(
      `[${process.platform}] Class path extraction - Relative path: ${normalizedRelativePath}`,
    );

    // If the file is in the output directory, extract the package path
    if (this.pathStartsWith(normalizedRelativePath, normalizedOutputPattern)) {
      const packagePath = normalizedRelativePath
        .substring(normalizedOutputPattern.length)
        .replace(/^\/+/, "");
      this.smartLog.debug(
        `[${process.platform}] Extracted class package path: ${packagePath}`,
      );
      return packagePath;
    }

    // Fallback to basename
    this.smartLog.debug(
      `[${process.platform}] Class path extraction fallback to basename: ${path.basename(sourceFile)}`,
    );
    return path.basename(sourceFile);
  }
}
