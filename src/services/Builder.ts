/**
 * Build orchestration system for Java EE projects
 * Handles deployment strategies, project analysis, and smart auto-deployment
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec } from 'child_process';
import { env } from 'vscode';
import { glob } from 'glob';
import { Tomcat } from './Tomcat';
import { Logger } from './Logger';
// import { promisify } from 'util';

// const execAsync = promisify(exec);

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
    parseWebappConfiguration(): Promise<{ webappName: string; contextPath?: string; }>;
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
const tomcat = Tomcat.getInstance();
const logger = Logger.getInstance();

interface ProjectStructure {
    type: 'maven' | 'gradle' | 'eclipse' | 'plain';
    javaOutputDir: string;
    javaSourceRoots: string[];
    webResourceRoots: string[];
    webappName: string;
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
        logLevel: 'debug' | 'info' | 'warn' | 'error'; // Log level for smart deploy
    };
}

/** Default mapping templates for different project types */
const DEFAULT_MAPPINGS: Record<string, SmartDeployMapping[]> = {
    maven: [
        {
            source: 'target/classes/**/*.class',
            destination: 'WEB-INF/classes/{relative}',
            needsReload: true,
            description: 'Java compiled classes',
            extensions: ['.class']
        },
        {
            source: 'src/main/webapp/**/*',
            destination: '{relative}',
            needsReload: false,
            description: 'Static web resources',
            excludeExtensions: ['.class', '.java']
        },
        {
            source: 'src/main/resources/**/*',
            destination: 'WEB-INF/classes/{relative}',
            needsReload: true,
            description: 'Resource files',
            excludeExtensions: ['.class', '.java']
        }
    ],
    gradle: [
        {
            source: 'build/classes/java/main/**/*.class',
            destination: 'WEB-INF/classes/{relative}',
            needsReload: true,
            description: 'Java compiled classes',
            extensions: ['.class']
        },
        {
            source: 'src/main/webapp/**/*',
            destination: '{relative}',
            needsReload: false,
            description: 'Static web resources',
            excludeExtensions: ['.class', '.java']
        },
        {
            source: 'src/main/resources/**/*',
            destination: 'WEB-INF/classes/{relative}',
            needsReload: true,
            description: 'Resource files',
            excludeExtensions: ['.class', '.java']
        }
    ],
    eclipse: [
        {
            source: 'bin/**/*.class',
            destination: 'WEB-INF/classes/{relative}',
            needsReload: true,
            description: 'Java compiled classes',
            extensions: ['.class']
        },
        {
            source: 'WebContent/**/*',
            destination: '{relative}',
            needsReload: false,
            description: 'Static web resources',
            excludeExtensions: ['.class', '.java']
        }
    ],
    plain: [
        {
            source: 'bin/**/*.class',
            destination: 'WEB-INF/classes/{relative}',
            needsReload: true,
            description: 'Java compiled classes',
            extensions: ['.class']
        },
        {
            source: 'web/**/*',
            destination: '{relative}',
            needsReload: false,
            description: 'Static web resources',
            excludeExtensions: ['.class', '.java']
        }
    ]
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

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.pomPath = path.join(workspaceRoot, 'pom.xml');
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
            throw new Error('pom.xml not found');
        }

        try {
            const pomContent = fs.readFileSync(this.pomPath, 'utf-8');
            logger.debug('Parsing Maven pom.xml for build configuration...');

            const config: MavenConfig = {};

            // Extract artifactId
            const artifactIdMatch = pomContent.match(/<artifactId>(.*?)<\/artifactId>/);
            if (artifactIdMatch) {
                config.artifactId = artifactIdMatch[1].trim();
            }

            // Extract finalName (for WAR file naming)
            const finalNameMatch = pomContent.match(/<finalName>(.*?)<\/finalName>/);
            if (finalNameMatch) {
                config.finalName = finalNameMatch[1].trim();
            }

            // Extract build outputDirectory
            const outputDirMatch = pomContent.match(/<outputDirectory>(.*?)<\/outputDirectory>/);
            if (outputDirMatch) {
                config.outputDirectory = outputDirMatch[1].trim();
            } else {
                config.outputDirectory = 'target/classes'; // Maven default
            }

            // Parse resources configuration
            config.resources = this.parseResourcesSection(pomContent);

            // Parse maven-war-plugin configuration
            config.warConfig = this.parseWarPluginConfig(pomContent);

            this.mavenConfig = config;
            logger.debug(`Maven config parsed: ${JSON.stringify(config, null, 2)}`);
            return config;

        } catch (error) {
            logger.error('Failed to parse pom.xml', false, error as string);
            throw error;
        }
    }

    /**
     * Parse <resources> section from pom.xml
     */
    private parseResourcesSection(pomContent: string): Array<{ directory: string; targetPath?: string; excludes?: string[]; includes?: string[]; }> {
        const resources: Array<{ directory: string; targetPath?: string; excludes?: string[]; includes?: string[]; }> = [];
        
        // Match resources section
        const resourcesMatch = pomContent.match(/<resources>([\s\S]*?)<\/resources>/);
        if (!resourcesMatch) {
            // Default Maven resources if not explicitly configured
            return [{
                directory: 'src/main/resources',
                targetPath: undefined // Default to classes root
            }];
        }

        const resourcesContent = resourcesMatch[1];
        
        // Find all <resource> entries
        const resourceMatches = resourcesContent.matchAll(/<resource>([\s\S]*?)<\/resource>/g);
        
        for (const resourceMatch of resourceMatches) {
            const resourceContent = resourceMatch[1];
            const resource: { directory: string; targetPath?: string; excludes?: string[]; includes?: string[]; } = {
                directory: ''
            };

            // Extract directory
            const dirMatch = resourceContent.match(/<directory>(.*?)<\/directory>/);
            if (dirMatch) {
                resource.directory = dirMatch[1].trim();
            }

            // Extract targetPath
            const targetMatch = resourceContent.match(/<targetPath>(.*?)<\/targetPath>/);
            if (targetMatch) {
                resource.targetPath = targetMatch[1].trim();
            }

            // Extract excludes
            const excludesMatch = resourceContent.match(/<excludes>([\s\S]*?)<\/excludes>/);
            if (excludesMatch) {
                const excludeMatches = excludesMatch[1].matchAll(/<exclude>(.*?)<\/exclude>/g);
                resource.excludes = Array.from(excludeMatches, match => match[1].trim());
            }

            // Extract includes
            const includesMatch = resourceContent.match(/<includes>([\s\S]*?)<\/includes>/);
            if (includesMatch) {
                const includeMatches = includesMatch[1].matchAll(/<include>(.*?)<\/include>/g);
                resource.includes = Array.from(includeMatches, match => match[1].trim());
            }

            if (resource.directory) {
                resources.push(resource);
            }
        }

        return resources.length > 0 ? resources : [{
            directory: 'src/main/resources',
            targetPath: undefined
        }];
    }

    /**
     * Parse maven-war-plugin configuration
     */
    private parseWarPluginConfig(pomContent: string): { warSourceDirectory?: string; webXml?: string; excludes?: string[]; includes?: string[]; } | undefined {
        // Find maven-war-plugin configuration
        const warPluginMatch = pomContent.match(/<plugin>[\s\S]*?<groupId>org\.apache\.maven\.plugins<\/groupId>[\s\S]*?<artifactId>maven-war-plugin<\/artifactId>[\s\S]*?<\/plugin>/);
        
        if (!warPluginMatch) {
            return {
                warSourceDirectory: 'src/main/webapp' // Maven default
            };
        }

        const pluginContent = warPluginMatch[0];
        const warConfig: { warSourceDirectory?: string; webXml?: string; excludes?: string[]; includes?: string[]; } = {};

        // Extract warSourceDirectory
        const warSourceMatch = pluginContent.match(/<warSourceDirectory>(.*?)<\/warSourceDirectory>/);
        if (warSourceMatch) {
            warConfig.warSourceDirectory = warSourceMatch[1].trim();
        } else {
            warConfig.warSourceDirectory = 'src/main/webapp';
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
        const outputDir = config.outputDirectory || 'target/classes';
        mappings.push({
            source: `${outputDir}/**/*.class`,
            destination: 'WEB-INF/classes/{relative}',
            needsReload: true,
            description: 'Maven compiled Java classes',
            extensions: ['.class']
        });

        // 2. Resources mappings
        if (config.resources) {
            for (const resource of config.resources) {
                const targetPath = resource.targetPath || 'WEB-INF/classes';
                
                mappings.push({
                    source: `${resource.directory}/**/*`,
                    destination: `${targetPath}/{relative}`,
                    needsReload: true,
                    description: `Maven resource: ${resource.directory}`,
                    excludeExtensions: ['.java', '.class']
                });
            }
        }

        // 3. Web application resources mapping
        const warSourceDir = config.warConfig?.warSourceDirectory || 'src/main/webapp';
        mappings.push({
            source: `${warSourceDir}/**/*`,
            destination: '{relative}',
            needsReload: false,
            description: 'Maven webapp resources',
            excludeExtensions: ['.java', '.class']
        });

        logger.info(`Generated ${mappings.length} mappings from Maven pom.xml`);
        return mappings;
    }

    /**
     * Parse output directories from Maven configuration
     */
    public async parseOutputDirectories(): Promise<string[]> {
        const config = await this.parsePomXml();
        const directories = [config.outputDirectory || 'target/classes'];
        
        if (config.resources) {
            directories.push(...config.resources.map(r => r.directory));
        }
        
        return directories;
    }

    /**
     * Parse webapp configuration
     */
    public async parseWebappConfiguration(): Promise<{ webappName: string; contextPath?: string; }> {
        const config = await this.parsePomXml();
        
        // Use finalName if specified, otherwise use artifactId, fallback to directory name
        const webappName = config.finalName || 
                          config.artifactId || 
                          path.basename(this.workspaceRoot);
        
        return {
            webappName,
            contextPath: `/${webappName}`
        };
    }

    /**
     * Debug method: Print Maven configuration analysis
     */
    public async debugMavenConfiguration(): Promise<void> {
        logger.info('🔍 === Maven Configuration Debug ===');
        
        if (!this.isProjectSupported()) {
            logger.warn('❌ Maven project not supported - pom.xml not found');
            return;
        }

        try {
            const config = await this.parsePomXml();
            logger.info(`📋 Maven Configuration:`);
            logger.info(`   - ArtifactId: ${config.artifactId || 'Not specified'}`);
            logger.info(`   - FinalName: ${config.finalName || 'Not specified'}`);
            logger.info(`   - OutputDirectory: ${config.outputDirectory || 'target/classes (default)'}`);
            logger.info(`   - Resources: ${config.resources ? config.resources.length : 0} entries`);
            
            if (config.resources) {
                config.resources.forEach((resource, index) => {
                    logger.info(`     Resource ${index + 1}: ${resource.directory} → ${resource.targetPath || 'classes root'}`);
                });
            }

            logger.info(`   - War Source Directory: ${config.warConfig?.warSourceDirectory || 'src/main/webapp (default)'}`);

            const mappings = await this.parseResourceMappings();
            logger.info(`🎯 Generated ${mappings.length} deployment mappings:`);
            mappings.forEach((mapping, index) => {
                logger.info(`   Mapping ${index + 1}: ${mapping.source} → ${mapping.destination} (reload: ${mapping.needsReload})`);
            });

            const webappConfig = await this.parseWebappConfiguration();
            logger.info(`🌐 Webapp Configuration:`);
            logger.info(`   - WebappName: ${webappConfig.webappName}`);
            logger.info(`   - ContextPath: ${webappConfig.contextPath}`);

        } catch (error) {
            logger.error('Maven configuration debug failed', false, error as string);
        }

        logger.info('🔍 === End Maven Configuration Debug ===');
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
    origin: 'smart' | 'local';
}

export class Builder {
    private static instance: Builder;
    private autoDeployMode: 'Disable' | 'Smart';
    private isDeploying = false;
    private attempts = 0;
    private preferredBuildType: 'Auto' | 'Local' | 'Maven' | 'Gradle';
    private syncBypassPatterns: RegExp[] = [];
    
    // Enhanced Smart deploy properties (dual-watcher architecture with batch processing)
    private fileWatchers: vscode.FileSystemWatcher[] = []; // Contains both static and compiled file watchers
    private staticResourceDebouncer = new Map<string, NodeJS.Timeout>(); // For static resources (immediate)
    
    // Batch processing for compiled files
    private compiledFileDebouncer = new Map<string, NodeJS.Timeout>(); // Individual file debouncer (legacy)
    private batchDeploymentTimer?: NodeJS.Timeout; // Global batch timer
    private pendingCompiledFiles = new Set<string>(); // Files waiting for batch deployment
    
    private projectStructure?: ProjectStructure;
    private smartDeployConfig?: SmartDeployConfig;
    private compiledMappings?: CompiledMapping[];
    private compileEncoding: string;

    // Legacy code (commented out for new implementation)
    // private deployDebouncer = new Map<string, NodeJS.Timeout>();

    // Configuration file name (legacy, kept for reference)
    private static readonly CONFIG_FILE = '.vscode/tomcat-smart-deploy.json';
    private static readonly DEPLOY_CANCELLED = 'TurboCat deployment cancelled';

    /**
     * Private constructor - initialize configuration and state
     */
    private constructor() {
        // Use smartDeploy setting
        this.autoDeployMode = vscode.workspace.getConfiguration().get('turbocat.smartDeploy', 'Disable') as 'Disable' | 'Smart';
        this.preferredBuildType = vscode.workspace.getConfiguration().get('turbocat.preferredBuildType', 'Auto') as 'Auto' | 'Local' | 'Maven' | 'Gradle';
        this.loadSyncBypassPatterns();
        this.compileEncoding = this.resolveCompileEncoding();
    }

    /**
     * Get singleton Builder instance
     */
    public static getInstance(): Builder {
        if (!Builder.instance) {
            Builder.instance = new Builder();
        }
        return Builder.instance;
    }

    /**
     * Update configuration from workspace settings
     */
    public updateConfig(): void {
        // Use smartDeploy setting
        this.autoDeployMode = vscode.workspace.getConfiguration().get('turbocat.smartDeploy', 'Disable') as 'Disable' | 'Smart';
        this.preferredBuildType = vscode.workspace.getConfiguration().get('turbocat.preferredBuildType', 'Auto') as 'Auto' | 'Local' | 'Maven' | 'Gradle';
        this.loadSyncBypassPatterns();
        this.compileEncoding = this.resolveCompileEncoding();
    }

    /**
     * Ensure a local deploy configuration template exists for plain/Eclipse projects.
     */
    public async ensureLocalConfigTemplate(): Promise<void> {
        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspaceRoot) {
                return;
            }

            const configPath = path.join(workspaceRoot, Builder.CONFIG_FILE);
            this.projectStructure = this.detectProjectStructure();

            if (!['plain', 'eclipse'].includes(this.projectStructure.type)) {
                return;
            }

            if (fs.existsSync(configPath)) {
                return;
            }

            this.smartDeployConfig = await this.loadSmartDeployConfig();
        } catch (error) {
            logger.debug(`Skipped creating local config template: ${error}`);
        }
    }

    /**
     * Load filename bypass patterns for smart deploy synchronization
     */
    private loadSyncBypassPatterns(): void {
        const raw = vscode.workspace.getConfiguration('turbocat').get<string>('syncBypassPatterns', 'copy,副本,コピー,копия') || '';
        const patterns = raw.split(',')
            .map(pattern => pattern.trim())
            .filter(Boolean)
            .map(pattern => new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));

        this.syncBypassPatterns = patterns;
        logger.debug(`Sync bypass patterns: ${patterns.map(regex => regex.source).join(', ') || 'none'}`);
    }

    /**
     * Resolve the javac encoding flag from user configuration with basic validation.
     */
    private resolveCompileEncoding(): string {
        const configured = vscode.workspace.getConfiguration('turbocat').get<string>('compileEncoding', 'UTF-8') || 'UTF-8';
        const value = configured.trim();
        if (!value) {
            return 'UTF-8';
        }

        const isSafe = /^[\w.\-]+$/i.test(value);
        if (!isSafe) {
            logger.warn(`Unsupported compile encoding '${value}' detected. Falling back to UTF-8.`);
            return 'UTF-8';
        }

        return value;
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
    public static isJavaEEProject(): boolean {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { return false; }

        const rootPath = workspaceFolders[0].uri.fsPath;
        const webInfPath = path.join(rootPath, 'src', 'main', 'webapp', 'WEB-INF');
        
        if (fs.existsSync(webInfPath)) { return true; }
        if (fs.existsSync(path.join(webInfPath, 'web.xml'))) { return true; }

        const pomPath = path.join(rootPath, 'pom.xml');
        if (fs.existsSync(pomPath) && fs.readFileSync(pomPath, 'utf-8').includes('<packaging>war</packaging>')) {
            return true;
        }

        const gradlePath = path.join(rootPath, 'build.gradle');
        if (fs.existsSync(gradlePath) && fs.readFileSync(gradlePath, 'utf-8').match(/(tomcat|jakarta|javax\.ee)/i)) {
            return true;
        }

        const targetPath = path.join(rootPath, 'target');
        if (fs.existsSync(targetPath) && fs.readdirSync(targetPath).some(file => file.endsWith('.war') || file.endsWith('.ear'))) {
            return true;
        }

        return false;
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
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            throw new Error('No workspace folder found');
        }

        const workspaceRoot = workspaceFolders[0].uri.fsPath;
        
        // Maven detection
        if (fs.existsSync(path.join(workspaceRoot, 'pom.xml'))) {
            return {
                type: 'maven',
                javaOutputDir: 'target/classes',
                javaSourceRoots: ['src/main/java'],
                webResourceRoots: ['src/main/webapp'],
                webappName: this.getMavenArtifactId(workspaceRoot) || path.basename(workspaceRoot)
            };
        }
        
        // Gradle detection
        if (fs.existsSync(path.join(workspaceRoot, 'build.gradle')) || 
            fs.existsSync(path.join(workspaceRoot, 'build.gradle.kts'))) {
            return {
                type: 'gradle',
                javaOutputDir: 'build/classes/java/main',
                javaSourceRoots: ['src/main/java'],
                webResourceRoots: ['src/main/webapp'],
                webappName: this.getGradleProjectName(workspaceRoot) || path.basename(workspaceRoot)
            };
        }
        
        // Eclipse/Plain Java detection
        if (fs.existsSync(path.join(workspaceRoot, '.classpath'))) {
            return {
                type: 'eclipse',
                javaOutputDir: 'bin',
                javaSourceRoots: ['src'],
                webResourceRoots: ['WebContent', 'web'],
                webappName: path.basename(workspaceRoot)
            };
        }
        
        // Default fallback
        return {
            type: 'plain',
            javaOutputDir: 'bin',
            javaSourceRoots: ['src'],
            webResourceRoots: ['web', 'webapp'],
            webappName: path.basename(workspaceRoot)
        };
    }

    /**
     * Extract Maven artifact ID from pom.xml
     */
    private getMavenArtifactId(workspaceRoot: string): string | null {
        try {
            const pomPath = path.join(workspaceRoot, 'pom.xml');
            const pomContent = fs.readFileSync(pomPath, 'utf-8');
            const artifactIdMatch = pomContent.match(/<artifactId>(.*?)<\/artifactId>/);
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
            const settingsPath = path.join(workspaceRoot, 'settings.gradle');
            if (fs.existsSync(settingsPath)) {
                const settingsContent = fs.readFileSync(settingsPath, 'utf-8');
                const nameMatch = settingsContent.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
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
    public async deploy(type: 'Local' | 'Maven' | 'Gradle' | 'Choice'): Promise<void> {
        const projectDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!projectDir || !Builder.isJavaEEProject()) {
            await this.createNewProject();
            return;
        }

        let buildType: 'Local' | 'Maven' | 'Gradle';
        try {
            buildType = await this.resolveBuildType(type, projectDir);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message !== Builder.DEPLOY_CANCELLED) {
                logger.error('Deployment aborted:', false, message);
            } else {
                logger.info('Deployment cancelled by user');
            }
            return;
        }

        logger.info(`Using ${buildType} deployment pipeline`);

        try {
            this.projectStructure = this.detectProjectStructure();
        } catch (error) {
            logger.warn('Unable to refresh project structure before deployment');
            if (error) {
                logger.debug(`Project structure detection error: ${error}`);
            }
        }

        const appName = path.basename(projectDir);
        const tomcatHome = await tomcat.findTomcatHome();
        
        tomcat.setAppName(appName);

        if (!tomcatHome || !appName || !fs.existsSync(path.join(tomcatHome, 'webapps'))) { return; }

        const targetDir = path.join(tomcatHome, 'webapps', appName);
        await vscode.workspace.saveAll();

        try {            
            const action = {
                'Local': () => this.localDeploy(projectDir, targetDir, tomcatHome),
                'Maven': () => this.mavenDeploy(projectDir, targetDir),
                'Gradle': () => this.gradleDeploy(projectDir, targetDir, appName),
            }[buildType];

            if (!action) {
                throw(`Invalid deployment type: ${buildType}`);
            }

            const startTime = performance.now();

            const notifyWithProgress = buildType !== 'Local';
            if (notifyWithProgress) {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `${buildType} build in progress`,
                    cancellable: false
                }, async () => action());
            } else {
                await action();
            }

            //logger.defaultStatusBar();

            const endTime = performance.now();
            const duration = Math.round(endTime - startTime);

            if (fs.existsSync(targetDir)) {
                logger.success(`${buildType} build completed in ${duration}ms`, notifyWithProgress);
                await new Promise(resolve => setTimeout(resolve, 100));
                await tomcat.reload();
            }

            this.attempts = 0;
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            const isBusyError = errorMessage.includes('EBUSY') || errorMessage.includes('resource busy or locked');
            if (isBusyError && this.attempts < 3) {
                this.attempts++;
                await tomcat.kill();
                this.deploy(buildType);
            } else {
                logger.error(`${buildType} build failed:`, true, errorMessage);
            }
            //logger.defaultStatusBar();
        } finally {
            //logger.defaultStatusBar();
        }
    }

    private async resolveBuildType(
        requested: 'Local' | 'Maven' | 'Gradle' | 'Choice',
        projectDir: string
    ): Promise<'Local' | 'Maven' | 'Gradle'> {
        if (requested !== 'Choice') {
            return requested;
        }

        const candidates = this.collectBuildCandidates(projectDir);
        const preferred = this.preferredBuildType;

        if (preferred !== 'Auto' && candidates.includes(preferred)) {
            return preferred;
        }

        const configuredFallback = vscode.workspace.getConfiguration('turbocat')
            .get<'Local' | 'Maven' | 'Gradle'>('autoDeployBuildType', 'Local');

        if (preferred === 'Auto' &&
            configuredFallback &&
            configuredFallback !== 'Local' &&
            candidates.includes(configuredFallback)) {
            await this.persistPreferredBuildType(configuredFallback);
            return configuredFallback;
        }

        if (candidates.length === 1) {
            return candidates[0];
        }

        const choice = await vscode.window.showQuickPick(candidates, {
            placeHolder: 'Select the build type TurboCat should use for this workspace',
            ignoreFocusOut: true
        });

        if (!choice) {
            throw new Error(Builder.DEPLOY_CANCELLED);
        }

        const allowed: ReadonlyArray<'Local' | 'Maven' | 'Gradle'> = ['Local', 'Maven', 'Gradle'];
        if (!allowed.includes(choice as 'Local' | 'Maven' | 'Gradle')) {
            throw new Error(`Unsupported build type selection: ${choice}`);
        }

        const typedChoice = choice as 'Local' | 'Maven' | 'Gradle';
        await this.persistPreferredBuildType(typedChoice);
        return typedChoice;
    }

    private collectBuildCandidates(projectDir: string): Array<'Local' | 'Maven' | 'Gradle'> {
        const candidates: Array<'Local' | 'Maven' | 'Gradle'> = [];
        const hasPom = fs.existsSync(path.join(projectDir, 'pom.xml'));
        const hasGradle = fs.existsSync(path.join(projectDir, 'build.gradle')) ||
            fs.existsSync(path.join(projectDir, 'build.gradle.kts'));

        if (hasPom) {
            candidates.push('Maven');
        }

        if (hasGradle) {
            candidates.push('Gradle');
        }

        if (candidates.length === 0) {
            candidates.push('Local');
        }

        return candidates;
    }

    private async persistPreferredBuildType(value: 'Local' | 'Maven' | 'Gradle'): Promise<void> {
        this.preferredBuildType = value;
        await vscode.workspace.getConfiguration().update(
            'turbocat.preferredBuildType',
            value,
            vscode.ConfigurationTarget.Workspace
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
    public async autoDeploy(_reason: vscode.TextDocumentSaveReason): Promise<void> {
        if (this.isDeploying || !Builder.isJavaEEProject()) { return; }
    
        try {
            this.isDeploying = true;
            
            if (this.autoDeployMode === 'Smart') {
                // Smart deploy is handled by file system watchers
                // This ensures smart deploy is initialized if not already
                if (!this.projectStructure) {
                    this.initializeSmartDeploy().catch(error => 
                        logger.error('Failed to initialize smart deploy', false, error as string)
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
        // Update autoDeployMode from config to ensure it's current
        this.autoDeployMode = vscode.workspace.getConfiguration().get('turbocat.smartDeploy', 'Disable') as 'Disable' | 'Smart';
        
        if (this.autoDeployMode !== 'Smart') {
            logger.debug('Smart deploy not initialized - mode is not Smart');
            return;
        }

        try {
            logger.debug('Initializing hybrid smart deploy system...');
            
            // Check current workspace
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                logger.error('No workspace folders found', false, 'Smart deploy requires an open workspace');
                return;
            }
            
            // Detect project structure
            this.projectStructure = this.detectProjectStructure();
            logger.debug(`Detected project structure: ${JSON.stringify(this.projectStructure)}`);
            
            // Load or create smart deploy configuration
            this.smartDeployConfig = await this.loadSmartDeployConfig();
            
            // Compile mappings for runtime efficiency
            this.compiledMappings = this.compileMappings(this.smartDeployConfig);
            
            // Setup dual-watcher architecture
            this.setupDualFileWatchers();
            
            logger.info('✓ Dual-watcher smart deploy initialized successfully');
            logger.info(`  - Project type: ${this.projectStructure.type}`);
            logger.info(`  - Java output: ${this.projectStructure.javaOutputDir}`);
            logger.info(`  - Webapp name: ${this.projectStructure.webappName}`);
            logger.info(`  - Mappings: ${this.compiledMappings.length} configured`);
            logger.info(`  - Architecture: Dual-watcher (static + compiled)`);
            logger.info(`  - Config file: ${Builder.CONFIG_FILE}`);
        } catch (error) {
            logger.error('Failed to initialize smart deploy', false, error as string);
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
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            logger.debug('Dual watcher setup failed: No workspace root');
            return;
        }

        // Dispose existing watchers
        this.disposeFileWatchers();

        logger.info(`🎯 Setting up dual-watcher smart deployment architecture`);
        logger.info(`📋 Features: Static resources (immediate) + Compiled classes (delayed)`);
        
        // 1. Static Resource Watcher - src/**/* excluding .java files
        this.setupStaticResourceWatcher(workspaceRoot);
        
        // 2. Compiled File Watcher - target/classes/**/*.class or build/classes/**/*.class
        this.setupCompiledFileWatcher(workspaceRoot);
        
        logger.info(`✅ Dual-watcher setup complete`);
    }

    /**
     * Setup static resource file watcher for immediate deployment
     */
    private setupStaticResourceWatcher(workspaceRoot: string): void {
        const structure = this.projectStructure;
        const candidateRoots = new Set<string>();

        if (structure?.webResourceRoots?.length) {
            structure.webResourceRoots.forEach(root => candidateRoots.add(root));
        }

        candidateRoots.add(path.join('src', 'main', 'webapp'));
        candidateRoots.add(path.join('src', 'main', 'resources'));
        candidateRoots.add('src');

        const localMappingCandidates = this.smartDeployConfig?.localDeploy?.mappings ?? [];
        localMappingCandidates
            .filter(mapping => mapping && mapping.enabled !== false)
            .forEach(mapping => {
                const normalizedSource = this.normalizeLocalMappingSource(mapping.source);
                const root = this.getMappingRoot(normalizedSource);
                if (root) {
                    candidateRoots.add(root);
                }
            });

        let watcherCreated = false;

        candidateRoots.forEach(root => {
            if (!root || root.includes('*')) {
                return;
            }

            const normalized = root.replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
            const absolute = path.join(workspaceRoot, normalized);

            if (!fs.existsSync(absolute)) {
                logger.debug(`Skipping static watcher for ${normalized} (directory not found)`);
                return;
            }

            const globPattern = `${normalized.replace(/\\/g, '/')}/**/*`;
            const pattern = new vscode.RelativePattern(workspaceRoot, globPattern);
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);

            logger.info(`📁 Static Resource Watcher: ${absolute}`);
            logger.info(`⚡ Strategy: Immediate deployment for web resources`);

            watcher.onDidChange((uri: vscode.Uri) => this.handleStaticResourceChange(uri, 'change'));
            watcher.onDidCreate((uri: vscode.Uri) => this.handleStaticResourceChange(uri, 'create'));
            watcher.onDidDelete?.((uri: vscode.Uri) => this.handleStaticResourceChange(uri, 'delete'));

            this.fileWatchers.push(watcher);
            watcherCreated = true;
        });

        if (!watcherCreated) {
            logger.warn('No static resource watcher configured. Verify resource directories exist.');
        } else {
            logger.info('✓ Static resource watcher configuration complete');
        }
    }

    /**
     * Setup compiled file watcher for delayed deployment
     */
    private setupCompiledFileWatcher(workspaceRoot: string): void {
        if (!this.projectStructure) return;

        const primaryOutput = this.projectStructure.javaOutputDir || path.join('target', 'classes');
        const outputCandidates = new Set<string>([primaryOutput]);

        if (this.projectStructure.type === 'gradle') {
            outputCandidates.add(path.join('build', 'classes', 'java', 'main'));
        } else if (this.projectStructure.type === 'maven') {
            outputCandidates.add(path.join('target', 'classes'));
        } else {
            outputCandidates.add('bin');
        }

        let watcherCreated = false;

        outputCandidates.forEach(root => {
            if (!root || root.includes('*')) {
                return;
            }

            const normalized = root.replace(/^[/\\]+/, '').replace(/[/\\]+$/, '');
            const absolute = path.join(workspaceRoot, normalized);

            if (!fs.existsSync(absolute)) {
                logger.debug(`Skipping compiled watcher for ${normalized} (directory not found)`);
                return;
            }

            const globPattern = `${normalized.replace(/\\/g, '/')}/**/*.class`;
            const pattern = new vscode.RelativePattern(workspaceRoot, globPattern);
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);

            logger.info(`🧱 Compiled File Watcher: ${absolute}`);
            logger.info(`⏱️ Strategy: Delayed deployment for compiled classes`);

            watcher.onDidChange((uri: vscode.Uri) => this.handleCompiledFileChange(uri, 'change'));
            watcher.onDidCreate((uri: vscode.Uri) => this.handleCompiledFileChange(uri, 'create'));
            watcher.onDidDelete?.((uri: vscode.Uri) => this.handleCompiledFileChange(uri, 'delete'));

            this.fileWatchers.push(watcher);
            watcherCreated = true;
        });

        if (!watcherCreated) {
            logger.warn('No compiled file watcher configured. Verify build output directories exist.');
        } else {
            logger.info('✓ Compiled file watcher active');
        }
    }

    /**
     * Dispose the unified file watcher
     */
    private disposeFileWatchers(): void {
        this.fileWatchers.forEach(watcher => watcher.dispose());
        this.fileWatchers = [];
    }

    // LEGACY: Old unified file change handler (commented out)
    // private handleSourceFileChange(uri: vscode.Uri, eventType: 'change' | 'create' | 'delete'): void {
    //     ... (old implementation commented out)
    // }

    /**
     * NEW: Handle static resource file changes (immediate deployment)
     * Processes non-Java files from src directory with zero delay
     */
    private handleStaticResourceChange(uri: vscode.Uri, eventType: 'change' | 'create' | 'delete'): void {
        const fileName = path.basename(uri.fsPath);
        const fileExt = path.extname(uri.fsPath).toLowerCase();
        
        if (this.shouldBypassFile(uri.fsPath)) {
            logger.debug(`Bypassing sync for file: ${fileName}`);
            return;
        }
        
        // Skip hidden files, temp files, and handle Java files specially
        if (fileName.startsWith('.') || fileName.endsWith('.tmp') || fileName.endsWith('.temp') || fileExt === '.svn') {
            logger.debug(`Skipping file: ${fileName} (temp/hidden file)`);
            return;
        }

        // Handle Java files - trigger compilation check
        if (fileExt === '.java') {
            logger.debug(`Java file ${eventType}: ${fileName} - triggering compilation check`);
            this.handleJavaFileChange(uri.fsPath, eventType);
            return;
        }
        
        // Get relative path from workspace root
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;
        
        const relativePath = path.relative(workspaceRoot, uri.fsPath);
        logger.info(`🔥 Static resource ${eventType}: ${fileName} (${relativePath})`);
        
        // Immediate deployment for static resources (no debouncing)
        this.deployStaticResourceImmediately(uri.fsPath, eventType);
    }

    /**
     * Handle Java source file changes by checking for corresponding compiled files
     * Enhanced version with comprehensive dependency analysis
     */
    private async handleJavaFileChange(javaFilePath: string, _eventType: 'change' | 'create' | 'delete'): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;

        const fileName = path.basename(javaFilePath, '.java');
        const relativePath = path.relative(workspaceRoot, javaFilePath);
        logger.info(`☕ Java file changed: ${fileName}.java (${relativePath})`);
        logger.debug(`🔍 Analyzing compilation impact for: ${fileName}.java`);

        // Strategy 1: Immediate check for existing compiled files
        this.checkAndDeployCompiledClass(javaFilePath, fileName);

        // Strategy 2: Monitor for compilation completion with multiple attempts
        this.monitorCompilationCompletion(javaFilePath, fileName);

        // Strategy 3: Set up a delayed comprehensive scan
        setTimeout(async () => {
            try {
                await this.performComprehensiveClassScan(javaFilePath, fileName);
            } catch (error) {
                logger.debug(`Comprehensive scan failed for ${fileName}.java: ${error}`);
            }
        }, 3000); // 3 second delay for comprehensive scan
    }

    /**
     * Monitor compilation completion with multiple check attempts
     */
    private monitorCompilationCompletion(javaFilePath: string, className: string): void {
        const attempts = [500, 1000, 1500, 2500]; // Multiple time intervals
        
        attempts.forEach((delay, index) => {
            setTimeout(async () => {
                logger.debug(`🔄 Compilation check attempt ${index + 1}/${attempts.length} for ${className}.java`);
                try {
                    await this.checkAndDeployCompiledClass(javaFilePath, className);
                } catch (error) {
                    logger.debug(`Compilation check ${index + 1} failed for ${className}.java: ${error}`);
                }
            }, delay);
        });
    }

    /**
     * Perform comprehensive class file scan to catch any missed dependencies
     */
    private async performComprehensiveClassScan(javaFilePath: string, className: string): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot || !this.projectStructure) return;

        // Determine output directory
        let outputDir: string;
        switch (this.projectStructure.type) {
            case 'maven':
                outputDir = path.join(workspaceRoot, 'target/classes');
                break;
            case 'gradle':
                outputDir = path.join(workspaceRoot, 'build/classes/java/main');
                break;
            default:
                outputDir = path.join(workspaceRoot, 'bin');
                break;
        }

        if (!fs.existsSync(outputDir)) {
            return;
        }

        try {
            logger.debug(`🔍 Performing comprehensive scan for ${className}.java`);

            // Find all class files that might be related to this Java file
            const allPossibleMatches = await this.findAllPossibleClassMatches(outputDir, className, javaFilePath);

            if (allPossibleMatches.length > 0) {
                logger.info(`🎯 Comprehensive scan found ${allPossibleMatches.length} additional classes for ${className}.java`);
                
                for (const classFile of allPossibleMatches) {
                    const relativePath = path.relative(workspaceRoot, classFile);
                    logger.debug(`   + ${relativePath}`);
                    this.addToBatchDeployment(classFile, 'change');
                }
            }

        } catch (error) {
            logger.debug(`Comprehensive scan error: ${error}`);
        }
    }

    /**
     * Find all possible class file matches using multiple strategies
     */
    private async findAllPossibleClassMatches(outputDir: string, className: string, javaFilePath: string): Promise<string[]> {
        const allMatches = new Set<string>();

        try {
            // Strategy 1: Pattern-based matching (more aggressive)
            const patterns = [
                `${outputDir}/**/${className}.class`,
                `${outputDir}/**/${className}$*.class`,
                `${outputDir}/**/*${className}*.class` // Even more aggressive - catches edge cases
            ];

            for (const pattern of patterns) {
                const files = await glob(pattern);
                files.forEach(file => allMatches.add(file));
            }

            // Strategy 2: Package-based analysis
            const packagePath = this.extractPackagePath(javaFilePath);
            if (packagePath) {
                const packageDir = path.join(outputDir, packagePath);
                if (fs.existsSync(packageDir)) {
                    // Find classes with recent modification times in the same package
                    const packageClasses = await glob(`${packageDir}/*.class`);
                    const recentThreshold = Date.now() - 10000; // 10 seconds
                    
                    for (const classFile of packageClasses) {
                        try {
                            const stats = fs.statSync(classFile);
                            if (stats.mtime.getTime() > recentThreshold) {
                                allMatches.add(classFile);
                            }
                        } catch (error) {
                            // Ignore errors
                        }
                    }
                }
            }

            // Strategy 3: Dependency analysis (basic)
            // Look for classes that might import or reference this class
            await this.findDependentClasses(outputDir, className, allMatches);

        } catch (error) {
            logger.debug(`Error in comprehensive class matching: ${error}`);
        }

        return Array.from(allMatches);
    }

    /**
     * Extract package path from Java file
     */
    private extractPackagePath(javaFilePath: string): string | null {
        try {
            const javaContent = fs.readFileSync(javaFilePath, 'utf-8');
            const packageMatch = javaContent.match(/package\s+([\w.]+)\s*;/);
            
            if (packageMatch) {
                return packageMatch[1].replace(/\./g, path.sep);
            }
        } catch (error) {
            logger.debug(`Failed to extract package from ${javaFilePath}: ${error}`);
        }
        
        return null;
    }

    /**
     * Find classes that might depend on the changed class
     */
    private async findDependentClasses(outputDir: string, className: string, matches: Set<string>): Promise<void> {
        // This is a simplified dependency check
        // In a more sophisticated implementation, we could analyze bytecode or use compilation dependency graphs
        
        try {
            // For now, we'll use a time-based heuristic
            const allClassFiles = await glob(`${outputDir}/**/*.class`);
            const recentThreshold = Date.now() - 15000; // 15 seconds for dependency detection
            
            let dependentCount = 0;
            for (const classFile of allClassFiles) {
                try {
                    const stats = fs.statSync(classFile);
                    if (stats.mtime.getTime() > recentThreshold && !matches.has(classFile)) {
                        // This class was recently modified, might be dependent
                        matches.add(classFile);
                        dependentCount++;
                    }
                } catch (error) {
                    // Ignore errors
                }
            }
            
            if (dependentCount > 0) {
                logger.debug(`Found ${dependentCount} potentially dependent classes for ${className}`);
            }
            
        } catch (error) {
            logger.debug(`Error finding dependent classes: ${error}`);
        }
    }

    /**
     * Check for compiled .class files and deploy them
     * Enhanced version that detects ALL related class files including inner classes
     */
    private async checkAndDeployCompiledClass(_javaFilePath: string, className: string): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot || !this.projectStructure) return;

        // Determine output directory based on project type
        let outputDir: string;
        switch (this.projectStructure.type) {
            case 'maven':
                outputDir = path.join(workspaceRoot, 'target/classes');
                break;
            case 'gradle':
                outputDir = path.join(workspaceRoot, 'build/classes/java/main');
                break;
            default:
                outputDir = path.join(workspaceRoot, 'bin');
                break;
        }

        if (!fs.existsSync(outputDir)) {
            logger.debug(`Output directory not found: ${outputDir}`);
            return;
        }

        try {
            // Strategy 1: Find direct class file matches (including inner classes)
            const directMatches = await this.findDirectClassMatches(outputDir, className);
            
            // Strategy 2: Find recently modified class files in the same package
            const recentMatches = await this.findRecentlyModifiedClasses(outputDir, className);
            
            // Strategy 3: Find all class files that might be affected by this Java file change
            const packageMatches = await this.findPackageRelatedClasses(outputDir, className);
            
            // Combine all matches and remove duplicates
            const allMatches = new Set([...directMatches, ...recentMatches, ...packageMatches]);
            const classFiles = Array.from(allMatches);

            if (classFiles.length === 0) {
                logger.debug(`No compiled classes found for ${className}.java`);
                return;
            }

            logger.info(`🎯 Found ${classFiles.length} related compiled classes for ${className}.java:`);
            
            // Group files by type for better logging
            const directCount = directMatches.length;
            const recentCount = recentMatches.filter(f => !directMatches.includes(f)).length;
            const packageCount = classFiles.length - directCount - recentCount;
            
            logger.info(`   📋 Direct matches: ${directCount}, Recent changes: ${recentCount}, Package related: ${packageCount}`);
            
            // Add all found class files to batch deployment
            for (const classFile of classFiles) {
                const relativePath = path.relative(workspaceRoot, classFile);
                logger.debug(`   - ${relativePath}`);
                this.addToBatchDeployment(classFile, 'change');
            }

            logger.info(`📦 Added ${classFiles.length} compiled classes to batch deployment`);

        } catch (error) {
            logger.warn(`Failed to scan for compiled classes: ${error}`);
        }
    }

    /**
     * Find direct class file matches including inner classes and anonymous classes
     */
    private async findDirectClassMatches(outputDir: string, className: string): Promise<string[]> {
        // Pattern to match:
        // - ClassName.class (main class)
        // - ClassName$InnerClass.class (inner classes)
        // - ClassName$1.class, ClassName$2.class (anonymous classes)
        // - ClassName$InnerClass$1.class (anonymous classes in inner classes)
        const patterns = [
            `${outputDir}/**/${className}.class`,
            `${outputDir}/**/${className}$*.class`
        ];

        const matches: string[] = [];
        for (const pattern of patterns) {
            const files = await glob(pattern);
            matches.push(...files);
        }

        return [...new Set(matches)]; // Remove duplicates
    }

    /**
     * Find recently modified class files that might be related to the Java file change
     */
    private async findRecentlyModifiedClasses(outputDir: string, className: string): Promise<string[]> {
        const now = Date.now();
        const fiveSecondsAgo = now - 5000; // Look for files modified in the last 5 seconds
        
        try {
            // Get the package directory where this class should be located
            const allClassFiles = await glob(`${outputDir}/**/*.class`);
            const recentFiles: string[] = [];
            
            // Find the main class file to determine the package structure
            const mainClassFiles = allClassFiles.filter(file => 
                path.basename(file) === `${className}.class`
            );
            
            if (mainClassFiles.length > 0) {
                // Get the directory of the main class file
                const classDir = path.dirname(mainClassFiles[0]);
                
                // Check all class files in the same directory for recent modifications
                const packageClassFiles = await glob(`${classDir}/*.class`);
                
                for (const classFile of packageClassFiles) {
                    try {
                        const stats = fs.statSync(classFile);
                        if (stats.mtime.getTime() > fiveSecondsAgo) {
                            recentFiles.push(classFile);
                        }
                    } catch (error) {
                        // File might have been deleted, ignore
                    }
                }
            }
            
            return recentFiles;
        } catch (error) {
            logger.debug(`Error finding recently modified classes: ${error}`);
            return [];
        }
    }

    /**
     * Find package-related class files that might be affected by interdependencies
     */
    private async findPackageRelatedClasses(outputDir: string, className: string): Promise<string[]> {
        try {
            // This is a more conservative approach - we look for classes that might have dependencies
            // For now, we'll focus on the immediate package, but this could be expanded
            
            const allClassFiles = await glob(`${outputDir}/**/*.class`);
            const relatedFiles: string[] = [];
            
            // Find classes in the same package that were recently modified
            const mainClassFiles = allClassFiles.filter(file => 
                path.basename(file) === `${className}.class`
            );
            
            if (mainClassFiles.length > 0) {
                const classDir = path.dirname(mainClassFiles[0]);
                const packageName = path.relative(outputDir, classDir);
                
                // For now, include all recently modified files in the same package
                // This could be made more sophisticated by analyzing actual dependencies
                const now = Date.now();
                const tenSecondsAgo = now - 10000; // Slightly longer window for package dependencies
                
                const packageFiles = await glob(`${classDir}/*.class`);
                for (const file of packageFiles) {
                    try {
                        const stats = fs.statSync(file);
                        if (stats.mtime.getTime() > tenSecondsAgo) {
                            relatedFiles.push(file);
                        }
                    } catch (error) {
                        // Ignore errors
                    }
                }
                
                if (relatedFiles.length > 1) { // More than just the main class
                    logger.debug(`Found ${relatedFiles.length} potentially related classes in package: ${packageName}`);
                }
            }
            
            return relatedFiles;
        } catch (error) {
            logger.debug(`Error finding package-related classes: ${error}`);
            return [];
        }
    }

    /**
     * NEW: Handle compiled file changes with intelligent batch processing
     * Processes .class files from target/build directories with batch optimization
     */
    private handleCompiledFileChange(uri: vscode.Uri, eventType: 'change' | 'create' | 'delete'): void {
        const fileName = path.basename(uri.fsPath);
        const fileExt = path.extname(uri.fsPath).toLowerCase();
        
        if (this.shouldBypassFile(uri.fsPath)) {
            logger.debug(`Bypassing sync for compiled file: ${fileName}`);
            return;
        }
        
        // Only process .class files
        if (fileExt !== '.class') {
            logger.debug(`Skipping non-class file: ${fileName}`);
            return;
        }
        
        // Get relative path from workspace root
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;
        
        const relativePath = path.relative(workspaceRoot, uri.fsPath);
        logger.info(`🔧 Compiled file ${eventType}: ${fileName} (${relativePath})`);
        
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
        return this.syncBypassPatterns.some(pattern => pattern.test(baseName));
    }

    // LEGACY: Old deployment methods (commented out for new dual-watcher architecture)
    // These methods were used in the previous hybrid approach
    
    /*
    private async deployCompiledClassWithMapping(sourceJavaPath: string, relativePath: string): Promise<void> {
        // ... (implementation commented out)
    }

    private async deploySourceFileWithMapping(sourceFilePath: string): Promise<void> {
        // ... (implementation commented out)  
    }
    */

    /**
     * NEW: Immediate deployment for static resources (no debouncing)
     */
    private async deployStaticResourceImmediately(filePath: string, eventType: 'change' | 'create' | 'delete'): Promise<void> {
        try {
            if (eventType === 'delete') {
                logger.debug(`Static resource deleted: ${path.basename(filePath)}`);
                // TODO: Handle deletion - remove corresponding deployed files
                return;
            }

            // Find matching mapping for the source file
            const mapping = this.findMatchingMapping(filePath);
            if (!mapping) {
                const fileName = path.basename(filePath);
                logger.debug(`❌ No mapping found for static resource: ${fileName}`);
                return;
            }
            
            // Generate destination path using mapping configuration
            const targetPath = await this.generateDestinationPath(mapping, filePath);
            if (!targetPath) {
                const fileName = path.basename(filePath);
                logger.warn(`Failed to generate target path for: ${fileName}`);
                return;
            }
            
            await this.copyFileWithLogging(filePath, targetPath, 'static');
            
            const fileName = path.basename(filePath);
            const tomcatHome = await tomcat.findTomcatHome();
            const relativePath = tomcatHome ? path.relative(path.join(tomcatHome, 'webapps'), targetPath) : path.basename(targetPath);
            logger.info(`✓ Immediate deployed static: ${fileName} → ${relativePath}`);
            
        } catch (error) {
            logger.error(`Static resource deployment failed for ${path.basename(filePath)}`, false, error as string);
        }
    }

    /**
     * NEW: Add file to batch deployment queue with intelligent batching
     * Collects multiple class file changes and deploys them together
     */
    private addToBatchDeployment(filePath: string, eventType: 'change' | 'create' | 'delete'): void {
        const debounceTime = vscode.workspace.getConfiguration('turbocat').get<number>('smartDeployDebounce', 300);
        
        // Add file to pending batch (using Map to store both path and event type)
        this.pendingCompiledFiles.add(JSON.stringify({ filePath, eventType }));
        
        logger.debug(`📦 Added to batch: ${path.basename(filePath)} (${eventType}) - ${this.pendingCompiledFiles.size} files queued`);
        
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
        if (this.pendingCompiledFiles.size === 0) {
            return;
        }

        const batchSize = this.pendingCompiledFiles.size;
        logger.info(`🚀 Executing batch deployment for ${batchSize} compiled files...`);
        
        // Convert Set to array and parse file information
        const filesToDeploy = Array.from(this.pendingCompiledFiles).map(item => JSON.parse(item));
        
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
                logger.error(`Batch deploy failed for ${path.basename(filePath)}`, false, error as string);
                errorCount++;
            }
        }
        
        // Log batch results
        if (successCount > 0) {
            logger.info(`✅ Batch deployment completed: ${successCount} files deployed successfully`);
        }
        if (errorCount > 0) {
            logger.warn(`⚠️ Batch deployment had ${errorCount} errors`);
        }
        
        // Optional: Trigger single reload after batch deployment instead of per-file
        // This is more efficient for multiple class changes
        // TODO: Implement conditional reload based on mapping configuration
    }

    // LEGACY: Individual file deployment method (commented out in favor of batch processing)
    // private deployCompiledFileWithDelay(filePath: string, eventType: 'change' | 'create' | 'delete'): void {
    //     const debounceTime = vscode.workspace.getConfiguration('turbocat').get<number>('smartDeployDebounce', 300);
    //     
    //     logger.debug(`Compiled file debounce time: ${debounceTime}ms for file: ${path.basename(filePath)}`);
    //     
    //     if (this.compiledFileDebouncer.has(filePath)) {
    //         clearTimeout(this.compiledFileDebouncer.get(filePath)!);
    //     }
    //     
    //     this.compiledFileDebouncer.set(filePath, setTimeout(async () => {
    //         try {
    //             await this.executeCompiledFileDeployment(filePath, eventType);
    //         } catch (error) {
    //             logger.error(`Compiled deploy failed for ${path.basename(filePath)}`, false, error as string);
    //         } finally {
    //             this.compiledFileDebouncer.delete(filePath);
    //         }
    //     }, debounceTime));
    // }

    /**
     * Execute compiled file deployment logic
     */
    private async executeCompiledFileDeployment(filePath: string, eventType: 'change' | 'create' | 'delete'): Promise<void> {
        if (eventType === 'delete') {
            logger.debug(`Compiled file deleted: ${path.basename(filePath)}`);
            // TODO: Handle deletion - remove corresponding deployed files
            return;
        }

        // Find matching mapping for the compiled .class file
        const mapping = this.findMatchingMapping(filePath);
        if (!mapping) {
            logger.info(`❌ No mapping found for compiled class: ${path.relative(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', filePath)}`);
            return;
        }
        
        // Generate destination path using mapping configuration
        const targetPath = await this.generateDestinationPath(mapping, filePath);
        if (!targetPath) {
            logger.warn(`Failed to generate target path for: ${path.basename(filePath)}`);
            return;
        }
        
        await this.copyFileWithLogging(filePath, targetPath, 'class');
        
        const fileName = path.basename(filePath);
        const tomcatHome = await tomcat.findTomcatHome();
        const relativePath = tomcatHome ? path.relative(path.join(tomcatHome, 'webapps'), targetPath) : path.basename(targetPath);
        logger.info(`✓ Delayed deployed class: ${fileName} → ${relativePath}`);
    }

    // LEGACY: Old debounced deploy method (commented out)
    // private debouncedDeploy(filePath: string, deployFn: () => Promise<void>): void {
    //     const debounceTime = vscode.workspace.getConfiguration('turbocat').get<number>('smartDeployDebounce', 300);
    //     
    //     // Debug log to verify configuration is being read correctly
    //     logger.debug(`Smart Deploy debounce time: ${debounceTime}ms for file: ${path.basename(filePath)}`);
    //     
    //     if (this.deployDebouncer.has(filePath)) {
    //         clearTimeout(this.deployDebouncer.get(filePath)!);
    //     }
    //     
    //     this.deployDebouncer.set(filePath, setTimeout(async () => {
    //         try {
    //             await deployFn();
    //         } catch (error) {
    //             logger.error(`Smart deploy failed for ${path.basename(filePath)}`, false, error as string);
    //         } finally {
    //             this.deployDebouncer.delete(filePath);
    //         }
    //     }, debounceTime));
    // }

    /**
     * Copy file with progress indication and logging
     */
    private async copyFileWithLogging(source: string, target: string, type: 'class' | 'static' | 'local'): Promise<void> {
        try {
            // Check if source file exists
            if (!fs.existsSync(source)) {
                logger.warn(`Smart deploy: Source file not found: ${path.basename(source)}`);
                return;
            }

            // Ensure target directory exists
            const targetDir = path.dirname(target);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            // Copy the file
            fs.copyFileSync(source, target);
            
            const fileName = path.basename(source);
            const label = type === 'class'
                ? 'Smart deployed class'
                : type === 'static'
                    ? 'Smart deployed static'
                    : 'Local mapping synced';
            logger.info(`✓ ${label}: ${fileName}`);
        } catch (error) {
            throw error;
        }
    }

    /**
     * Check if file is a static web resource
     */
    // private isStaticWebResource(filePath: string): boolean {
    //     const webExtensions = [
    //         '.html', '.htm', '.css', '.js', '.json', '.xml', '.jsp', '.jspf', 
    //         '.tag', '.tld', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', 
    //         '.txt', '.properties', '.woff', '.woff2', '.ttf', '.eot', '.md'
    //     ];
        
    //     const ext = path.extname(filePath).toLowerCase();
        
    //     // Exclude files in typical output directories
    //     if (this.projectStructure) {
    //         const outputDir = this.projectStructure.javaOutputDir;
    //         if (filePath.includes(outputDir)) {
    //             return false;
    //         }
    //     }
        
    //     return webExtensions.includes(ext);
    // }

    /**
     * Dispose smart deploy watchers (dual-watcher approach with batch cleanup)
     */
    public disposeSmartDeploy(): void {
        this.disposeFileWatchers();
        
        // Clear any pending debounced operations for static resources
        this.staticResourceDebouncer.forEach(timeout => clearTimeout(timeout));
        this.staticResourceDebouncer.clear();
        
        // Clear individual compiled file debouncers (legacy)
        this.compiledFileDebouncer.forEach(timeout => clearTimeout(timeout));
        this.compiledFileDebouncer.clear();
        
        // Clear batch deployment timer and pending files
        if (this.batchDeploymentTimer) {
            clearTimeout(this.batchDeploymentTimer);
            this.batchDeploymentTimer = undefined;
        }
        this.pendingCompiledFiles.clear();
        
        logger.debug('🧹 Smart deploy cleanup: All watchers and timers disposed');
    }

    /**
     * Test method to manually test dual-watcher deployment
     */
    public async testDualWatcherDeploy(): Promise<void> {
        if (!this.projectStructure) {
            logger.debug('Test deploy: No project structure found');
            return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            logger.debug('Test deploy: No workspace root found');
            return;
        }

        logger.info('🧪 Testing dual-watcher deployment system...');

        try {
            // Test static resource deployment
            const srcPath = path.join(workspaceRoot, 'src');
            if (fs.existsSync(srcPath)) {
                const staticFiles = await this.findFiles(path.join(srcPath, '**', '*.{html,css,js,jsp}'));
                logger.debug(`Test deploy: Found ${staticFiles.length} static files`);
                
                for (const file of staticFiles.slice(0, 1)) { // Test with first file
                    logger.debug(`Test static deploy: Processing ${file}`);
                    const uri = vscode.Uri.file(file);
                    this.handleStaticResourceChange(uri, 'create');
                }
            }

            // Test compiled file deployment if target directory exists (simulate batch changes)
            const targetPath = path.join(workspaceRoot, this.projectStructure.javaOutputDir);
            if (fs.existsSync(targetPath)) {
                const classFiles = await this.findFiles(path.join(targetPath, '**', '*.class'));
                logger.debug(`Test deploy: Found ${classFiles.length} class files`);
                
                // Simulate multiple class files changing at once (batch scenario)
                const testFiles = classFiles.slice(0, Math.min(3, classFiles.length));
                logger.info(`🧪 Simulating batch change: ${testFiles.length} class files`);
                
                testFiles.forEach((file, index) => {
                    logger.debug(`Test batch compile deploy ${index + 1}: Processing ${file}`);
                    const uri = vscode.Uri.file(file);
                    // All files will be batched together automatically
                    this.handleCompiledFileChange(uri, 'create');
                });
                
                if (testFiles.length > 1) {
                    logger.info(`⏱️ Batch processing will execute in ${vscode.workspace.getConfiguration('turbocat').get<number>('smartDeployDebounce', 300)}ms...`);
                }
            }

            logger.info('✅ Dual-watcher deployment test completed');
        } catch (error) {
            logger.error('Dual-watcher test failed', false, error as string);
        }
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
            'No Java EE project found. Do you want to create a new one?',
            'Yes', 'No'
        );

        if (answer === 'Yes') {
            try {
                const commands = await vscode.commands.getCommands();
                if (!commands.includes('java.project.create')) {
                    const installMessage = 'Java Extension Pack required for project creation';
                    vscode.window.showErrorMessage(installMessage, 'Install Extension').then(async choice => {
                        if (choice === 'Install Extension') {
                            await env.openExternal(vscode.Uri.parse(
                                'vscode:extension/vscjava.vscode-java-pack'
                            ));
                        }
                    });
                    return;
                }

                await vscode.commands.executeCommand('java.project.create', {
                    type: 'maven',
                    archetype: 'maven-archetype-webapp'
                });
                logger.info('New Maven web app project created');
            } catch (err) {
                vscode.window.showErrorMessage(
                    'Project creation failed. Ensure Java Extension Pack is installed and configured.',
                    'Open Extensions'
                ).then(choice => {
                    if (choice === 'Open Extensions') {
                        vscode.commands.executeCommand('workbench.extensions.action.showExtensions');
                    }
                });
            }
        } else {
            logger.success('Tomcat deploy canceled', true);
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
    private async localDeploy(projectDir: string, targetDir: string, tomcatHome: string) {
        const structure = this.projectStructure ?? this.detectProjectStructure();
        const webResourceCandidates = [
            ...(structure.webResourceRoots || []),
            path.join('src', 'main', 'webapp')
        ];
        const webAppPath = this.findFirstExistingPath(projectDir, webResourceCandidates);
        if (!webAppPath) {
            throw new Error(`Web resource directory not found. Checked: ${webResourceCandidates.join(', ')}`);
        }
        const javaHome = await tomcat.findJavaHome();
        if (!javaHome) return;

        const javacPath = path.join(javaHome, 'bin', 'javac');
        const classesDir = path.join(targetDir, 'WEB-INF', 'classes');
    
        this.brutalSync(webAppPath, targetDir, true);
    
        fs.rmSync(classesDir, { force: true, recursive: true });
        fs.mkdirSync(classesDir, { recursive: true });
    
        const javaSourceRoots = structure.javaSourceRoots && structure.javaSourceRoots.length > 0
            ? structure.javaSourceRoots
            : [path.join('src', 'main', 'java')];

        const javaFiles = new Set<string>();
        for (const sourceRoot of javaSourceRoots) {
            const sourcePath = this.findFirstExistingPath(projectDir, [sourceRoot]);
            if (!sourcePath) {
                continue;
            }
            const files = await this.findFiles(path.join(sourcePath, '**', '*.java'));
            files.forEach(file => javaFiles.add(file));
        }

        if (javaFiles.size > 0) {
            const classpathEntries = new Set<string>();
            const addClasspathDir = (dir: string) => {
                try {
                    if (!dir) {
                        return;
                    }
                    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
                        classpathEntries.add(path.join(dir, '*'));
                    }
                } catch {
                    // ignore inaccessible directories
                }
            };

            classpathEntries.add(path.join(tomcatHome, 'lib', '*'));
            addClasspathDir(path.join(projectDir, 'lib'));

            if (webAppPath) {
                addClasspathDir(path.join(webAppPath, 'WEB-INF', 'lib'));
            }

            addClasspathDir(path.join(targetDir, 'WEB-INF', 'lib'));

            const classpath = Array.from(classpathEntries).join(path.delimiter);
            const compileTargets = Array.from(javaFiles);

            const escapeForCmd = (value: string) => `"${value.replace(/(["\\])/g, '\\$1')}"`;

            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turbocat-javac-'));
            const argsFile = path.join(tempDir, 'sources.args');
            const argsFileContent = compileTargets
                .map(filePath => escapeForCmd(filePath))
                .join(os.EOL);

            fs.writeFileSync(argsFile, argsFileContent, 'utf8');

            const encodingArg = this.compileEncoding ? ` -encoding ${escapeForCmd(this.compileEncoding)}` : '';
            const cmd = `${escapeForCmd(javacPath)}${encodingArg} -d ${escapeForCmd(classesDir)} -cp ${escapeForCmd(classpath)} @${escapeForCmd(argsFile)}`;

            try {
                await this.executeCommand(cmd, projectDir);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        }
    
        await this.applyLocalDeployMappings();
    
        const libDir = path.join(projectDir, 'lib');
        const targetLib = path.join(targetDir, 'WEB-INF', 'lib');
        if (fs.existsSync(libDir)) {
            this.brutalSync(libDir, targetLib);
        }
    }

    /**
     * Apply additional local deploy mappings defined in the workspace configuration.
     */
    private async applyLocalDeployMappings(): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            return;
        }

        const tomcatHome = await tomcat.findTomcatHome();
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

            const localMappings = (this.compiledMappings || []).filter(mapping => mapping.origin === 'local');
            if (!localMappings.length) {
                return;
            }

            const visitedTargets = new Set<string>();

            for (const mapping of localMappings) {
                const absolutePattern = path.join(workspaceRoot, mapping.source);
                const matches = await glob(absolutePattern, {
                    nodir: true,
                    windowsPathsNoEscape: process.platform === 'win32'
                });

                if (!matches.length) {
                    logger.debug(`Local deploy mapping "${mapping.source}" did not match any files.`);
                    continue;
                }

                for (const sourceFile of matches) {
                    const targetPath = await this.generateDestinationPath(mapping, sourceFile);
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
                        await this.copyFileWithLogging(sourceFile, targetPath, 'local');
                        visitedTargets.add(targetKey);
                    }
                }
            }
        } catch (error) {
            logger.warn(`Local deploy mapping sync skipped: ${error}`);
        }
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
        if (!fs.existsSync(path.join(projectDir, 'pom.xml'))) {
            throw('pom.xml not found.');
        }

        try {
            await this.executeCommand(`mvn clean package`, projectDir);
        } catch (err) {
            const errorOutput = err?.toString() || '';
        
            const lines = errorOutput
                .split('\n')
                .filter(line =>
                    line.includes('[ERROR]') &&
                    !line.includes('re-run Maven') &&
                    !line.includes('[Help') &&
                    !line.includes('Re-run Maven') &&
                    !line.includes('For more information') &&
                    !line.includes('http')
                )
                .map(line => line.replace('[ERROR]', '\t\t'));
        
            const uniqueLines = [...new Set(lines)];
                
            throw(uniqueLines.join('\n'));
        }

        const targetPath = path.join(projectDir, 'target');
        const warFiles = fs.readdirSync(targetPath).filter((file: string) => file.toLowerCase().endsWith('.war'));
        if (warFiles.length === 0) {
            throw('No WAR file found after Maven build.');
        }

        const warFileName = warFiles[0];
        const warFilePath = path.join(targetPath, warFileName);

        const warBaseName = path.basename(warFileName, '.war');
        const warFolderPath = path.join(targetPath, warBaseName);

        if (fs.existsSync(targetDir)) {
            fs.rmSync(targetDir, { recursive: true, force: true });
        }
        if (fs.existsSync(`${targetDir}.war`)) {
            fs.rmSync(`${targetDir}.war`, { force: true });
        }

        fs.copyFileSync(warFilePath, `${targetDir}.war`);

        if (fs.existsSync(warFolderPath)) {
            fs.mkdirSync(targetDir, { recursive: true });
            this.copyDirectorySync(warFolderPath, targetDir);
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
    private async gradleDeploy(projectDir: string, targetDir: string, appName: string) {
        if (!fs.existsSync(path.join(projectDir, 'build.gradle'))) {
            throw('build.gradle not found.');
        }

        const gradleCmd = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
        await this.executeCommand(`${gradleCmd} war -PfinalName=${appName}`, projectDir);

        const warFile = path.join(projectDir, 'build', 'libs', `${appName}.war`);
        if (!warFile) {
            throw('No WAR file found after Gradle build.');
        }

        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.rmSync(`${targetDir}.war`, { recursive: true, force: true });
        fs.copyFileSync(warFile, `${targetDir}.war`);
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
            windowsPathsNoEscape: process.platform === 'win32',
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
    private async executeCommand(command: string, cwd: string): Promise<void> {
        return new Promise((resolve, reject) => {
            exec(command, { cwd }, (err, stdout, stderr) => {
                if (err) {
                    reject(stdout || stderr || err.message || 'Unknown error.');
                }
                resolve();
            });
        });
    }

    /**
     * Resolve the first existing path from the provided candidates.
     */
    private findFirstExistingPath(baseDir: string, candidates: string[]): string | null {
        for (const candidate of candidates) {
            if (!candidate) {
                continue;
            }

            const normalized = candidate.replace(/^[/\\]+/, '');
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
    private copyDirectorySync(src: string, dest: string) {
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }
    
        const entries = fs.readdirSync(src, { withFileTypes: true });
    
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
    
            try { fs.rmSync(destPath, { force: true, recursive: true }); } catch(e) {}
    
            if (entry.isDirectory()) {
                this.copyDirectorySync(srcPath, destPath);
            } else {
                try { fs.copyFileSync(srcPath, destPath); } catch(e) {}
            }
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
    private brutalSync(src: string, dest: string, restricted: boolean = false) {
        if (fs.existsSync(dest)) {
            const keepers = new Set(fs.readdirSync(src));
            const restrictedFolders = [
                'classes',
                'lib'
            ];
            fs.readdirSync(dest).forEach(f => {
                const fullPath = path.join(dest, f);
                if (!keepers.has(f) && (!restricted ? true : !restrictedFolders.includes(f))) {
                    try { fs.rmSync(fullPath, { force: true, recursive: true }); } catch (e) {}
                }
            });
        }
    
        fs.mkdirSync(dest, { recursive: true });
        fs.readdirSync(src, { withFileTypes: true }).forEach(entry => {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            
            if (entry.isDirectory()) {
                this.brutalSync(srcPath, destPath, restricted);
            } else {
                try {
                    fs.copyFileSync(srcPath, destPath);
                } catch {
                    fs.rmSync(destPath, { force: true });
                    fs.copyFileSync(srcPath, destPath);
                }
            }
        });
    }

    /**
     * Enhanced Smart Deploy Configuration Management
     */

    /**
     * Load or create smart deploy configuration
     */
    private async loadSmartDeployConfig(): Promise<SmartDeployConfig> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            throw new Error('No workspace folder found');
        }

        const configPath = path.join(workspaceRoot, Builder.CONFIG_FILE);
        
        // Priority 1: Try to load from Maven pom.xml if available
        const mavenParser = new MavenConfigParser(workspaceRoot);
        if (mavenParser.isProjectSupported()) {
            try {
                logger.info('Loading smart deploy configuration from Maven pom.xml');
                const mappings = await mavenParser.parseResourceMappings();
                const webappConfig = await mavenParser.parseWebappConfiguration();
                
                const mavenConfig: SmartDeployConfig = {
                    projectType: 'maven',
                    webappName: webappConfig.webappName,
                    mappings: mappings,
                    settings: {
                        debounceTime: vscode.workspace.getConfiguration('turbocat').get<number>('smartDeployDebounce', 300),
                        enabled: true,
                        logLevel: 'info'
                    }
                };

                logger.info(`Loaded smart deploy configuration from Maven pom.xml: ${mappings.length} mappings`);
                return mavenConfig;
            } catch (error) {
                logger.warn(`Failed to parse Maven configuration, falling back to custom/default config: ${error}`);
            }
        }

        // Priority 2: Try to load from custom config file
        if (fs.existsSync(configPath)) {
            try {
                const configContent = fs.readFileSync(configPath, 'utf-8');
                const config = JSON.parse(configContent) as SmartDeployConfig;
                this.ensureLocalDeployStructure(config);
                logger.info('Loaded smart deploy configuration from custom config file');
                return config;
            } catch (error) {
                logger.warn('Failed to parse smart deploy config, using defaults');
            }
        }

        // Priority 3: Create default configuration
        this.projectStructure = this.detectProjectStructure();
        const defaultConfig: SmartDeployConfig = {
            projectType: this.projectStructure.type,
            webappName: this.projectStructure.webappName,
            mappings: DEFAULT_MAPPINGS[this.projectStructure.type] || DEFAULT_MAPPINGS.plain,
            settings: {
                debounceTime: vscode.workspace.getConfiguration('turbocat').get<number>('smartDeployDebounce', 300),
                enabled: true,
                logLevel: 'info'
            }
        };

        this.ensureLocalDeployStructure(defaultConfig, { injectTemplate: true });

        // Save default configuration
        await this.saveSmartDeployConfig(defaultConfig);
        logger.info('Created default smart deploy configuration');
        return defaultConfig;
    }

    /**
     * Save smart deploy configuration to file
     */
    private async saveSmartDeployConfig(config: SmartDeployConfig): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;

        const configPath = path.join(workspaceRoot, Builder.CONFIG_FILE);
        const configDir = path.dirname(configPath);
        
        // Ensure .vscode directory exists
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        // Write configuration file
        const configJson = JSON.stringify(config, null, 2);
        fs.writeFileSync(configPath, configJson, 'utf-8');
    }

    /**
     * Compile mappings for runtime efficiency with cross-platform support
     */
    private compileMappings(config: SmartDeployConfig): CompiledMapping[] {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return [];

        const combinedMappings = this.buildCombinedMappings(config);

        return combinedMappings.map(({ mapping, origin }) => {
            const absoluteSource = path.join(workspaceRoot, mapping.source);
            const absoluteDestination = mapping.destination;
            
            // Convert glob pattern to regex for file matching with platform-specific logic
            let regexPattern = this.globToRegex(mapping.source);
            
            // Anchor the pattern to match from start to end
            const sourceRegex = new RegExp(`^${regexPattern}$`);

            logger.debug(`[${process.platform}] Compiled mapping: "${mapping.source}" -> regex: ${sourceRegex} (origin: ${origin})`);

            return {
                ...mapping,
                absoluteSource,
                absoluteDestination,
                sourceRegex,
                origin
            };
        });
    }

    /**
     * Combine smart deploy mappings with local deploy overrides.
     */
    private buildCombinedMappings(config: SmartDeployConfig): Array<{ mapping: SmartDeployMapping; origin: 'smart' | 'local'; }> {
        const combined: Array<{ mapping: SmartDeployMapping; origin: 'smart' | 'local'; }> = [];
        const seen = new Set<string>();

        const pushMapping = (mapping: SmartDeployMapping, origin: 'smart' | 'local') => {
            const key = `${mapping.source}|${mapping.destination}`;
            if (seen.has(key)) {
                logger.debug(`Skipping duplicate mapping override for ${mapping.source} → ${mapping.destination} (${origin})`);
                return;
            }
            seen.add(key);
            combined.push({ mapping, origin });
        };

        const localMappings = config.localDeploy?.mappings ?? [];
        localMappings
            .filter(mapping => mapping && mapping.enabled !== false)
            .forEach(mapping => pushMapping(this.transformLocalMapping(mapping), 'local'));

        if (Array.isArray(config.mappings)) {
            config.mappings.forEach(mapping => pushMapping(mapping, 'smart'));
        }

        return combined;
    }

    /**
     * Convert local deploy mapping entries to smart deploy mappings.
     */
    private transformLocalMapping(mapping: LocalDeployMapping): SmartDeployMapping {
        const normalizedSource = this.normalizeLocalMappingSource(mapping.source);
        const normalizedDestination = this.normalizeLocalMappingDestination(mapping.destination);

        return {
            source: normalizedSource,
            destination: normalizedDestination,
            needsReload: mapping.needsReload ?? false,
            description: mapping.description || `Local deploy mapping (${normalizedSource} → ${normalizedDestination})`,
            extensions: mapping.extensions,
            excludeExtensions: mapping.excludeExtensions
        };
    }

    private normalizeLocalMappingSource(source: string): string {
        if (!source) {
            return '**/*';
        }

        let normalized = source.replace(/\\/g, '/').replace(/^\/+/, '');

        const hasWildcard = /[*?]/.test(normalized);
        if (hasWildcard) {
            return normalized;
        }

        normalized = normalized.replace(/\/+$/, '');
        if (!normalized) {
            return '**/*';
        }

        const ext = path.extname(normalized);
        if (ext) {
            return normalized;
        }

        return `${normalized}/**/*`;
    }

    private normalizeLocalMappingDestination(destination: string): string {
        if (!destination) {
            return '{relative}';
        }

        let normalized = destination.replace(/\\/g, '/').replace(/^\/+/, '');

        if (!normalized.includes('{relative}')) {
            normalized = normalized.replace(/\/+$/, '');
            normalized = normalized ? `${normalized}/{relative}` : '{relative}';
        }

        return normalized;
    }

    private getMappingRoot(sourcePattern: string): string | null {
        if (!sourcePattern) {
            return null;
        }

        const normalized = sourcePattern.replace(/\\/g, '/').replace(/^\/+/, '');
        const wildcardIndex = normalized.search(/[*?]/);
        if (wildcardIndex >= 0) {
            return normalized.substring(0, wildcardIndex).replace(/\/+$/, '') || null;
        }

        return normalized.replace(/\/+$/, '') || null;
    }

    private ensureLocalDeployStructure(config: SmartDeployConfig, options?: { injectTemplate?: boolean }): void {
        if (!config.localDeploy || !Array.isArray(config.localDeploy.mappings)) {
            config.localDeploy = { mappings: [] };
        }

        const shouldInjectTemplate = options?.injectTemplate &&
            ['plain', 'eclipse'].includes(config.projectType) &&
            config.localDeploy.mappings.length === 0;

        if (shouldInjectTemplate) {
            config.localDeploy.mappings.push({
                description: 'Example: copy conf directory into WEB-INF/classes/conf',
                source: 'conf',
                destination: 'WEB-INF/classes/conf',
                enabled: false,
                needsReload: false
            });
        }
    }

    /**
     * Convert glob pattern to regex with proper cross-platform support
     */
    private globToRegex(globPattern: string): string {
        // Platform-specific path separator handling
        const isWindows = process.platform === 'win32';
        const pathSeparator = isWindows ? '\\\\' : '/';
        const pathSeparatorClass = isWindows ? '[\\\\\\/]' : '\\/';
        
        logger.debug(`[${process.platform}] Converting glob: "${globPattern}"`);
        
        let regexPattern = globPattern
            // First, handle glob patterns by replacing with placeholders
            .replace(/\*\*/g, '__DOUBLESTAR__')
            .replace(/\*/g, '__SINGLESTAR__')
            .replace(/\?/g, '__QUESTION__')
            // Escape regex special characters
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            // Convert glob placeholders to regex patterns
            .replace(/__DOUBLESTAR__/g, '.*')                    // ** -> match any characters including path separators
            .replace(/__SINGLESTAR__/g, `[^${pathSeparator}]*`)  // * -> match any characters except path separators  
            .replace(/__QUESTION__/g, `[^${pathSeparator}]`);    // ? -> match single character except path separators
        
        // Convert forward slashes to platform-specific path separator pattern
        regexPattern = regexPattern.replace(/\//g, pathSeparatorClass);
        
        logger.debug(`[${process.platform}] Regex result: "${regexPattern}"`);
        
        return regexPattern;
    }

    /**
     * Check if a file matches any compiled mapping with enhanced debugging
     */
    private findMatchingMapping(filePath: string): CompiledMapping | null {
        if (!this.compiledMappings) return null;

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return null;

        // Normalize paths for cross-platform compatibility
        const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
        
        logger.debug(`=== DEBUGGING PATH MATCHING [${process.platform}] ===`);
        logger.debug(`File path: ${filePath}`);
        logger.debug(`Workspace root: ${workspaceRoot}`);
        logger.debug(`Relative path (normalized): ${relativePath}`);
        logger.debug(`Available mappings: ${this.compiledMappings.length}`);
        
        for (const mapping of this.compiledMappings) {
            logger.debug(`\n--- Testing mapping: "${mapping.description}" ---`);
            logger.debug(`Source pattern: "${mapping.source}"`);
            logger.debug(`Compiled regex: ${mapping.sourceRegex}`);
            logger.debug(`Testing against: "${relativePath}"`);
            
            // Test the regex pattern
            const regexMatch = mapping.sourceRegex.test(relativePath);
            logger.debug(`Regex match result: ${regexMatch}`);
            
            if (regexMatch) {
                // Check extensions if specified
                const ext = path.extname(filePath).toLowerCase();
                logger.debug(`File extension: "${ext}"`);
                
                if (mapping.extensions) {
                    logger.debug(`Required extensions: [${mapping.extensions.join(', ')}]`);
                    if (!mapping.extensions.includes(ext)) {
                        logger.debug(`❌ Extension mismatch: ${ext} not in required extensions`);
                        continue;
                    }
                }
                
                if (mapping.excludeExtensions) {
                    logger.debug(`Excluded extensions: [${mapping.excludeExtensions.join(', ')}]`);
                    if (mapping.excludeExtensions.includes(ext)) {
                        logger.debug(`❌ Extension excluded: ${ext} in excluded extensions`);
                        continue;
                    }
                }
                
                logger.debug(`✅ MATCH FOUND: ${mapping.description}`);
                return mapping;
            } else {
                logger.debug(`❌ Pattern did not match`);
            }
        }
        
        logger.debug(`\n❌ No mapping found for: ${relativePath}`);
        logger.debug(`=== END PATH MATCHING DEBUG ===\n`);
        return null;
    }

    /**
     * Generate destination path from mapping and source file with proper relative path handling
     */
    private async generateDestinationPath(mapping: CompiledMapping, sourceFile: string): Promise<string> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return '';

        const tomcatHome = await tomcat.findTomcatHome();
        if (!tomcatHome) return '';

        // Get the webapp directory
        const webappDir = path.join(tomcatHome, 'webapps', this.projectStructure?.webappName || '');

        // Get relative path from workspace
        const relativePath = path.relative(workspaceRoot, sourceFile);
        
        // Extract the correct relative portion based on the mapping source pattern
        const relativePortion = this.extractRelativePortionFromMapping(mapping, relativePath, sourceFile);
        
        // Replace {relative} placeholder with actual relative path
        let destinationPath = mapping.destination;
        if (destinationPath.includes('{relative}')) {
            destinationPath = destinationPath.replace('{relative}', relativePortion);
        } else {
            // If no placeholder, ensure destination includes the relative path
            destinationPath = path.join(destinationPath, relativePortion);
        }
        
        // Create full destination path
        const fullDestinationPath = path.join(webappDir, destinationPath);
        
        // Ensure parent directory exists
        const targetDir = path.dirname(fullDestinationPath);
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        
        logger.debug(`Path mapping: ${relativePath} → ${destinationPath}`);
        return fullDestinationPath;
    }

    /**
     * Extract the correct relative portion from mapping pattern with enhanced cross-platform support
     */
    private extractRelativePortionFromMapping(mapping: CompiledMapping, relativePath: string, sourceFile: string): string {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return path.basename(sourceFile);

        // Normalize all paths to use forward slashes for consistent processing
        const sourcePattern = this.normalizePath(mapping.source);
        const normalizedRelativePath = this.normalizePath(relativePath);
        
        logger.debug(`[${process.platform}] Extracting relative portion for pattern: ${sourcePattern}`);
        logger.debug(`[${process.platform}] File relative path: ${normalizedRelativePath}`);
        
        // Handle different pattern types with enhanced cross-platform logic
        if (sourcePattern.includes('**/*')) {
            // Pattern like 'target/classes/**/*.class'
            const basePath = sourcePattern.split('/**')[0]; // Get 'target/classes'
            
            // Use more robust path matching
            if (this.pathStartsWith(normalizedRelativePath, basePath)) {
                const afterBasePath = normalizedRelativePath.substring(basePath.length).replace(/^\/+/, '');
                logger.debug(`[${process.platform}] Extracted relative portion: ${afterBasePath}`);
                return afterBasePath;
            }
        } else if (sourcePattern.includes('**/')) {
            // Pattern like 'src/**/filename'
            const parts = sourcePattern.split('**/');
            if (parts.length >= 2) {
                const basePath = parts[0].replace(/\/+$/, ''); // Remove trailing slashes
                if (this.pathStartsWith(normalizedRelativePath, basePath)) {
                    const afterBasePath = normalizedRelativePath.substring(basePath.length).replace(/^\/+/, '');
                    logger.debug(`[${process.platform}] Extracted relative portion (recursive): ${afterBasePath}`);
                    return afterBasePath;
                }
            }
        } else if (sourcePattern.includes('*')) {
            // Simple wildcard pattern - use cross-platform path.dirname
            const basePath = this.normalizePath(path.dirname(sourcePattern));
            if (basePath !== '.' && this.pathStartsWith(normalizedRelativePath, basePath)) {
                const afterBasePath = normalizedRelativePath.substring(basePath.length).replace(/^\/+/, '');
                logger.debug(`[${process.platform}] Extracted relative portion (wildcard): ${afterBasePath}`);
                return afterBasePath;
            }
        }
        
        // Fallback: for class files, try to preserve package structure
        if (sourceFile.endsWith('.class')) {
            return this.extractClassRelativePath(sourceFile, normalizedRelativePath);
        }
        
        // Default fallback
        logger.debug(`[${process.platform}] Using basename fallback: ${path.basename(sourceFile)}`);
        return path.basename(sourceFile);
    }

    /**
     * Normalize path separators for cross-platform consistency
     */
    private normalizePath(inputPath: string): string {
        return inputPath.replace(/\\/g, '/');
    }

    /**
     * Check if a path starts with a given prefix, handling edge cases
     */
    private pathStartsWith(fullPath: string, prefix: string): boolean {
        if (!prefix || prefix === '.') return true;
        
        const normalizedPrefix = prefix.replace(/\/+$/, ''); // Remove trailing slashes
        return fullPath === normalizedPrefix || fullPath.startsWith(normalizedPrefix + '/');
    }

    /**
     * Extract relative path for class files preserving package structure with cross-platform support
     */
    private extractClassRelativePath(sourceFile: string, relativePath: string): string {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot || !this.projectStructure) return path.basename(sourceFile);

        // Determine the output directory based on project type
        let outputPattern: string;
        switch (this.projectStructure.type) {
            case 'maven':
                outputPattern = 'target/classes';
                break;
            case 'gradle':
                outputPattern = 'build/classes/java/main';
                break;
            default:
                outputPattern = 'bin';
                break;
        }

        // Normalize paths for cross-platform consistency
        const normalizedOutputPattern = this.normalizePath(outputPattern);
        const normalizedRelativePath = this.normalizePath(relativePath);
        
        logger.debug(`[${process.platform}] Class path extraction - Output pattern: ${normalizedOutputPattern}`);
        logger.debug(`[${process.platform}] Class path extraction - Relative path: ${normalizedRelativePath}`);
        
        // If the file is in the output directory, extract the package path
        if (this.pathStartsWith(normalizedRelativePath, normalizedOutputPattern)) {
            const packagePath = normalizedRelativePath.substring(normalizedOutputPattern.length).replace(/^\/+/, '');
            logger.debug(`[${process.platform}] Extracted class package path: ${packagePath}`);
            return packagePath;
        }

        // Fallback to basename
        logger.debug(`[${process.platform}] Class path extraction fallback to basename: ${path.basename(sourceFile)}`);
        return path.basename(sourceFile);
    }

    /**
     * Debug method: Print current smart deployment status and configuration
     */
    public async debugSmartDeploymentStatus(): Promise<void> {
        logger.info('🔍 === Smart Deployment Debug Status ===');
        
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            logger.warn('❌ No workspace root found');
            return;
        }

        logger.info(`📁 Workspace Root: ${workspaceRoot}`);
        logger.info(`🎯 Auto Deploy Mode: ${this.autoDeployMode}`);
        logger.info(`🔧 Is Deploying: ${this.isDeploying}`);
        logger.info(`📊 File Watchers Active: ${this.fileWatchers.length}`);
        
        // Project Structure
        if (this.projectStructure) {
            logger.info(`🏗️ Project Structure:`);
            logger.info(`   - Type: ${this.projectStructure.type}`);
            logger.info(`   - WebappName: ${this.projectStructure.webappName}`);
        } else {
            logger.warn('⚠️ Project structure not detected');
        }

        // Smart Deploy Configuration
        if (this.smartDeployConfig) {
            logger.info(`⚙️ Smart Deploy Config:`);
            logger.info(`   - Project Type: ${this.smartDeployConfig.projectType}`);
            logger.info(`   - Webapp Name: ${this.smartDeployConfig.webappName}`);
            logger.info(`   - Mappings: ${this.smartDeployConfig.mappings.length} rules`);
            logger.info(`   - Debounce Time: ${this.smartDeployConfig.settings.debounceTime}ms`);
            logger.info(`   - Enabled: ${this.smartDeployConfig.settings.enabled}`);
            
            // List all mappings
            this.smartDeployConfig.mappings.forEach((mapping, index) => {
                logger.info(`     Mapping ${index + 1}: ${mapping.source} → ${mapping.destination} (reload: ${mapping.needsReload})`);
            });
        } else {
            logger.warn('⚠️ Smart deploy configuration not loaded');
        }

        // File Watcher Details
        logger.info(`👀 Active File Watchers:`);
        this.fileWatchers.forEach((_, index) => {
            logger.info(`   Watcher ${index + 1}: Active`);
        });

        // Batch Processing Status
        logger.info(`📦 Batch Processing Status:`);
        logger.info(`   - Pending Compiled Files: ${this.pendingCompiledFiles.size}`);
        logger.info(`   - Batch Timer Active: ${this.batchDeploymentTimer ? 'Yes' : 'No'}`);
        
        if (this.pendingCompiledFiles.size > 0) {
            logger.info(`   - Pending Files:`);
            Array.from(this.pendingCompiledFiles).forEach((file, index) => {
                const fileInfo = JSON.parse(file);
                logger.info(`     ${index + 1}. ${path.basename(fileInfo.filePath)} (${fileInfo.eventType})`);
            });
        }

        // Maven Configuration Check
        const mavenParser = new MavenConfigParser(workspaceRoot);
        if (mavenParser.isProjectSupported()) {
            logger.info(`🎯 Maven Project Detected - running Maven debug...`);
            await mavenParser.debugMavenConfiguration();
        } else {
            logger.info(`📄 Maven pom.xml not found in workspace root`);
        }

        logger.info('🔍 === End Smart Deployment Debug Status ===');
    }

    /**
     * Debug method: Test compiled file watcher manually
     */
    public async testCompiledFileWatcher(): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            logger.warn('❌ No workspace root found');
            return;
        }

        if (!this.projectStructure) {
            logger.warn('⚠️ Project structure not detected, detecting now...');
            this.projectStructure = this.detectProjectStructure();
        }

        logger.info('🧪 === Testing Compiled File Watcher ===');
        
        // Check output directories based on project type
        let outputDirs: string[] = [];
        switch (this.projectStructure.type) {
            case 'maven':
                outputDirs = ['target/classes', 'target/test-classes'];
                break;
            case 'gradle':
                outputDirs = ['build/classes/java/main', 'build/classes/java/test'];
                break;
            case 'eclipse':
            case 'plain':
            default:
                outputDirs = ['bin', 'out'];
                break;
        }

        for (const outputDir of outputDirs) {
            const fullOutputPath = path.join(workspaceRoot, outputDir);
            const exists = fs.existsSync(fullOutputPath);
            logger.info(`📁 Output Directory: ${outputDir} - ${exists ? '✅ EXISTS' : '❌ NOT FOUND'}`);
            
            if (exists) {
                // Look for .class files
                try {
                    const classFiles = await glob(`${fullOutputPath}/**/*.class`);
                    logger.info(`   - Found ${classFiles.length} .class files`);
                    
                    if (classFiles.length > 0) {
                        classFiles.slice(0, 5).forEach(file => {
                            const relativePath = path.relative(workspaceRoot, file);
                            logger.info(`     - ${relativePath}`);
                        });
                        if (classFiles.length > 5) {
                            logger.info(`     - ... and ${classFiles.length - 5} more files`);
                        }
                    }
                } catch (error) {
                    logger.warn(`   - Error scanning for .class files: ${error}`);
                }
            }
        }

        logger.info('🧪 === End Compiled File Watcher Test ===');
    }
}
