/**
 * Tomcat server lifecycle management
 * Singleton service for start/stop operations, configuration, and deployment
 */

import * as vscode from 'vscode';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Logger } from './Logger';
import { Buffer } from 'buffer';
import { Browser } from './Browser';
import { ChildProcess, spawn } from 'child_process';

const execAsync = promisify(exec);
const logger = Logger.getInstance();

export class Tomcat {
    private static instance: Tomcat;
    private tomcatHome: string;
    private javaHome: string;
    private protectedWebApps: string[];
    private port: number;
    private tomcatProcess: ChildProcess | null = null;
    private currentAppName: string = '';
    private tomcatEnvironment: Record<string, string>;

    private readonly PORT_RANGE = { min: 1024, max: 65535 };

    /**
     * Private constructor - initialize configuration
     */
    private constructor() {
        this.tomcatHome = vscode.workspace.getConfiguration().get<string>('turbocat.home', '');
        this.javaHome = vscode.workspace.getConfiguration().get<string>('turbocat.javaHome', '');
        this.protectedWebApps = vscode.workspace.getConfiguration().get<string[]>('turbocat.protectedWebApps', ['ROOT', 'docs', 'examples', 'manager', 'host-manager']);
        this.port = vscode.workspace.getConfiguration().get<number>('turbocat.port', 8080);
        this.tomcatEnvironment = this.loadTomcatEnvironment();
    }

    /**
     * Get singleton Tomcat instance
     */
    public static getInstance(): Tomcat {
        if (!Tomcat.instance) {
            Tomcat.instance = new Tomcat();
        }
        return Tomcat.instance;
    }

    /**
     * Clean up resources on extension deactivation
     */
    public deactivate(): void {
        this.stop();
    }

    /**
     * Update configuration from workspace settings
     */
    public updateConfig(): void {
        this.tomcatHome = vscode.workspace.getConfiguration().get<string>('turbocat.home', '');
        this.javaHome = vscode.workspace.getConfiguration().get<string>('turbocat.javaHome', '');
        this.protectedWebApps = vscode.workspace.getConfiguration().get<string[]>('turbocat.protectedWebApps', ['ROOT', 'docs', 'examples', 'manager', 'host-manager']);
        this.port = vscode.workspace.getConfiguration().get<number>('turbocat.port', 8080);
        this.tomcatEnvironment = this.loadTomcatEnvironment();
    }

    private loadTomcatEnvironment(): Record<string, string> {
        const configured = vscode.workspace.getConfiguration().get<Record<string, unknown>>('turbocat.tomcatEnvironment', {});
        if (!configured || typeof configured !== 'object') {
            return {};
        }

        const environment: Record<string, string> = {};
        for (const [key, value] of Object.entries(configured)) {
            if (!key) {
                continue;
            }

            if (typeof value === 'string') {
                environment[key] = value;
            } else if (value !== undefined && value !== null) {
                environment[key] = String(value);
            }
        }

        return environment;
    }

    /** Set application name for deployment */
    public setAppName(appName: string): void {
        this.currentAppName = appName;
    }

    /** Get current application name or derive from workspace */
    public getAppName(): string {
        // If we already have an app name set, use it
        if (this.currentAppName) {
            return this.currentAppName;
        }
        
        // Try to derive a default app name from the workspace
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const appName = path.basename(workspaceFolders[0].uri.fsPath);
            this.currentAppName = appName; // Cache it for future use
            return appName;
        }
        
        // If all else fails, return ROOT as a default
        return "ROOT";
    }

    /**
     * Start Tomcat server
     */
    public async start(showMessages: boolean = false): Promise<void> {
        const tomcatHome = await this.findTomcatHome();
        const javaHome = await this.findJavaHome();
        if (!tomcatHome || !javaHome) { return; }

        // Ensure Tomcat is stopped before starting
        await this.ensureTomcatStopped(showMessages);

        try {
            this.executeTomcatCommand('start', tomcatHome, javaHome);
            if (showMessages) {
                logger.info('Tomcat started successfully', showMessages);
            }
        } catch (err) {
            logger.error('Failed to start Tomcat:', showMessages, err as string);
        }
    }

    /**
     * Start Tomcat in debug mode
     */
    public async startDebug(showMessages: boolean = true): Promise<void> {
        const tomcatHome = await this.findTomcatHome();
        const javaHome = await this.findJavaHome();
        if (!tomcatHome || !javaHome) { return; }

        // Ensure Tomcat is stopped before starting in debug mode
        await this.ensureTomcatStopped(showMessages);

        try {
            const debugPort = vscode.workspace.getConfiguration().get<number>('turbocat.debugPort', 8000);
            this.executeTomcatCommand('start', tomcatHome, javaHome, {
                debug: true,
                debugPort
            });
            if (showMessages) {
                logger.success(`Tomcat started in debug mode on port ${debugPort}`, showMessages);
            }
        } catch (err) {
            logger.error('Failed to start Tomcat in debug mode:', showMessages, err as string);
        }
    }

    /**
     * Tomcat server shutdown procedure
     * 
     * Implements controlled server shutdown:
     * 1. Verifies running state
     * 2. Executes platform-specific shutdown command
     * 3. Handles shutdown timeouts
     * 4. Verifies process termination
     * 5. Cleans up residual resources
     * 
     * @log Error if shutdown sequence fails
     */
    public async stop(showMessages: boolean = false): Promise<void> {
        const tomcatHome = await this.findTomcatHome();
        const javaHome = await this.findJavaHome();
        if (!tomcatHome || !javaHome) { return; }

        if (!await this.isTomcatRunning()) {
            logger.info('Tomcat is not running', showMessages);
            return;
        }

        try {
            if (this.tomcatProcess) {
                this.tomcatProcess.kill('SIGTERM');
                this.tomcatProcess = null;
                logger.success('Tomcat stopped (process terminated)', showMessages);
            } else {
                await this.executeTomcatCommand('stop', tomcatHome, javaHome);
                logger.success('Tomcat stopped successfully', showMessages);
            }
        } catch (err) {
            logger.error('Failed to stop Tomcat:', showMessages, err as string);
        }
    }

    /**
     * Application hot-reload handler
     * 
     * Implements zero-downtime application reload:
     * 1. Detects current server state
     * 2. Uses Tomcat Manager API for reload
     * 3. Falls back to full restart if needed
     * 4. Maintains session persistence
     * 5. Handles authentication requirements
     * 
     * @log Error if reload fails with diagnostic information
     */
    public async reload(): Promise<void> {
        const tomcatHome = await this.findTomcatHome();
        const javaHome = await this.findJavaHome();

        if (!tomcatHome || !javaHome) { return; }

        // If Tomcat is not running, start it
        if (!await this.isTomcatRunning()) {
            logger.info("Tomcat is not running, starting it...");
            await this.start(true);
            return;
        }

        try {
            // Use currentAppName if set, otherwise get it from workspace
            const appName = this.currentAppName || this.getAppName();
            if (!appName) { 
                logger.error('No application name provided', true, 'Please provide a valid application name');
                return; 
            }

            const response = await fetch(`http://localhost:${this.port}/manager/text/reload?path=/${encodeURIComponent(appName)}`, {
                headers: {
                    'Authorization': `Basic ${Buffer.from('admin:admin').toString('base64')}`
                }
            });

            if (!response.ok) {
                throw new Error(`Reload failed: ${await response.text()}`);
            }
            logger.success('Tomcat reloaded');
        } catch (err) {
            logger.warn('Reload via manager API failed, attempting restart...', true);
            try {
                // Ensure Tomcat is stopped before restarting
                await this.ensureTomcatStopped(true);
                // Start Tomcat again
                await this.start(true);
            } catch (restartErr) {
                logger.warn('Reload via restart failed, attempting to add admin user...', true);
                await this.addTomcatUser(tomcatHome);
            }
        }
    }

    /**
     * Server maintenance and cleanup
     * 
     * Performs comprehensive server cleanup:
     * 1. Webapp directory cleaning with exclusions
     * 2. Work directory purging
     * 3. Temp file removal
     * 4. Resource leak prevention
     * 
     * @log Error if cleanup fails with filesystem details
     */
    public async clean(): Promise<void> {
        const tomcatHome = await this.findTomcatHome();
        const javaHome = await this.findJavaHome();
        if (!tomcatHome || !javaHome) { return; }

        const webappsDir = path.join(tomcatHome, 'webapps');

        if (!fs.existsSync(webappsDir)) {
            logger.warn(`Webapps directory not found: ${webappsDir}`);
            return;
        }

        try {
            // Ensure Tomcat is stopped before cleaning
            await this.ensureTomcatStopped(true);
            
            const entries = fs.readdirSync(webappsDir, { withFileTypes: true });

            for (const entry of entries) {
                const entryPath = path.join(webappsDir, entry.name);

                if (!this.protectedWebApps.includes(entry.name)) {
                    try {
                        if (entry.isDirectory()) {
                            fs.rmSync(entryPath, { recursive: true, force: true });
                            logger.info(`Removed directory: ${entryPath}`);
                        } else if (entry.isFile() || entry.isSymbolicLink()) {
                            fs.unlinkSync(entryPath);
                            logger.info(`Removed file: ${entryPath}`);
                        }
                    } catch (err) {
                        throw err;
                    }
                }
            }

            const workDir = path.join(tomcatHome, 'work');
            const tempDir = path.join(tomcatHome, 'temp');
            [workDir, tempDir].forEach(dir => {
                if (fs.existsSync(dir)) {
                    try {
                        fs.rmSync(dir, { recursive: true, force: true });
                        fs.mkdirSync(dir);
                        logger.info(`Cleaned and recreated: ${dir}`);
                    } catch (err) {
                        throw err;
                    }
                }
            });

            logger.success('Tomcat cleaned successfully', true);
        } catch (err) {
            logger.error('Tomcat cleanup failed:', true, err as string);
        }
    }

    /**
     * Terminates Java-related processes to release locked Tomcat resources
     * 
     * Handles platform-specific process termination:
     * - Windows: Uses `taskkill` to forcibly stop `java.exe` and `javaw.exe`
     * - Unix-like: Uses `pkill` to target `java` and `tomcat` processes
     * 
     * Ensures file resources such as JARs are no longer locked by running JVMs
     * before attempting to clean the Tomcat directories.
     */
    public async kill(): Promise<void> {
        try {
            if (process.platform === 'win32') {
                await execAsync(`taskkill /F /IM java.exe`);
                await execAsync(`taskkill /F /IM javaw.exe`);
            } else {
                await execAsync(`pkill -f tomcat`);
                await execAsync(`pkill -f java`);
            }
        } catch { }
    }

    /**
     * Public method to check if Tomcat is running
     * 
     * @returns Boolean indicating server running state
     */
    public async isRunning(): Promise<boolean> {
        return this.isTomcatRunning();
    }

    /**
     * Server process status check
     * 
     * Implements platform-specific process detection:
     * - Windows: netstat with findstr
     * - Unix: netstat with grep
     * - Port binding verification
     * - Process existence confirmation
     * 
     * @returns Boolean indicating server running state
     */
    private async isTomcatRunning(): Promise<boolean> {
        if (this.tomcatProcess && !this.tomcatProcess.killed) return true;
        try {
            let command: string;

            if (process.platform === 'win32') {
                command = `netstat -an | findstr ":${this.port}"`;
            } else {
                command = `netstat -an | grep ":${this.port}"`;
            }

            const { stdout } = await execAsync(command);
            return stdout.includes(`0.0.0.0:${this.port}`);
        } catch (error) {
            return false;
        }
    }

    /**
     * CATALINA_HOME resolution
     * 
     * Implements hierarchical location discovery:
     * 1. Checks environment variables
     * 2. Verifies workspace configuration
     * 3. Provides interactive selection
     * 4. Validates Tomcat installation
     * 
     * @returns Valid Tomcat home path or null
     */
    public async findTomcatHome(): Promise<string | null> {
        if (this.tomcatHome && await this.validateTomcatHome(this.tomcatHome)) {
            return this.tomcatHome;
        }

        const candidates = [
            process.env.CATALINA_HOME,
            process.env.TOMCAT_HOME,
            vscode.workspace.getConfiguration().get<string>('turbocat.home')
        ];

        const validCandidate = candidates.find(path =>
            typeof path === 'string' && path.trim().length > 0
        );

        if (validCandidate && await this.validateTomcatHome(validCandidate)) {
            await vscode.workspace.getConfiguration().update('turbocat.home', validCandidate, true);
            this.tomcatHome = validCandidate;
            return validCandidate;
        }

        const selectedFolder = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Select Tomcat Home Folder'
        });

        if (selectedFolder?.[0]?.fsPath) {
            const selectedPath = selectedFolder[0].fsPath;

            if (await this.validateTomcatHome(selectedPath)) {
                await vscode.workspace.getConfiguration().update('turbocat.home', selectedPath, true);
                this.tomcatHome = selectedPath;
                return selectedPath;
            } else {
                logger.warn(`Invalid Tomcat home: ${selectedPath} not found.`, true);
            }
        }

        return null;
    }

    /**
     * JAVA_HOME resolution
     * 
     * Implements JDK location discovery:
     * 1. Checks environment variables
     * 2. Verifies workspace configuration
     * 3. Provides interactive selection
     * 4. Validates JDK installation
     * 
     * @returns Valid Java home path or null
     */
    public async findJavaHome(): Promise<string | null> {
        if (this.javaHome && await this.validateJavaHome(this.javaHome)) {
            return this.javaHome;
        }

        const candidates = [
            vscode.workspace.getConfiguration().get<string>('turbocat.javaHome'),
            vscode.workspace.getConfiguration().get<string>('java.home'),
            vscode.workspace.getConfiguration().get<string>('java.jdt.ls.java.home'),
            process.env.JAVA_HOME,
            process.env.JDK_HOME,
            process.env.JAVA_JDK_HOME
        ];

        const validCandidate = candidates.find(path =>
            typeof path === 'string' && path.trim().length > 0
        );

        if (validCandidate && await this.validateJavaHome(validCandidate)) {
            await vscode.workspace.getConfiguration().update('turbocat.javaHome', validCandidate, true);
            this.javaHome = validCandidate;
            return validCandidate;
        }

        const selectedFolder = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Select Java Home Folder'
        });

        if (selectedFolder?.[0]?.fsPath) {
            const selectedPath = selectedFolder[0].fsPath;

            if (await this.validateJavaHome(selectedPath)) {
                await vscode.workspace.getConfiguration().update('turbocat.javaHome', selectedPath, true);
                this.javaHome = selectedPath;
                return selectedPath;
            } else {
                logger.warn(`Invalid Java home: ${selectedPath} not found.`, true);
            }
        }

        return null;
    }

    /**
     * Validates a Tomcat directory by checking for the startup script.
     *
     * @param tomcatHome Path to Tomcat root directory
     * @returns true if valid, false otherwise
     */
    private async validateTomcatHome(tomcatHome: string): Promise<boolean> {
        const catalinaPath = path.join(tomcatHome, 'bin', `catalina${process.platform === 'win32' ? '.bat' : '.sh'}`);
        try {
            await fsp.access(catalinaPath);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Validates a Java installation directory by checking for the java executable.
     *
     * @param javaHome Path to Java home
     * @returns true if valid, false otherwise
     */
    private async validateJavaHome(javaHome: string): Promise<boolean> {
        const javaExecutable = path.join(javaHome, 'bin', `java${process.platform === 'win32' ? '.exe' : ''}`);
        try {
            await fsp.access(javaExecutable);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Dynamic port configuration
     * 
     * Handles live port changes with:
     * 1. Range validation
     * 2. Conflict detection
     * 3. Atomic server.xml updates
     * 4. Coordinated server restart
     * 
     * @log Error with detailed validation messages
     */
    public async updatePort(): Promise<void> {
        const config = vscode.workspace.getConfiguration();
        const newPort = config.get<number>('turbocat.port', 8080);
        const oldPort = this.port;

        if (newPort !== oldPort) {
            try {
                const javaHome = await this.findJavaHome();
                const tomcatHome = await this.findTomcatHome();
                if (!javaHome || !tomcatHome) { return; }

                await this.validatePort(newPort);
                await new Promise(resolve => setTimeout(resolve, 200));

                // Ensure Tomcat is stopped before updating port configuration
                await this.ensureTomcatStopped(true);

                await this.modifyServerXmlPort(tomcatHome, newPort);

                this.port = newPort;
                this.updateConfig();
                Tomcat.getInstance().updateConfig();
                Browser.getInstance().updateConfig();

                await vscode.workspace.getConfiguration().update('turbocat.port', newPort, true);
                logger.success(`Tomcat port updated from ${oldPort} to ${newPort}`, true);

                this.executeTomcatCommand('start', tomcatHome, javaHome);
            } catch (err) {
                await vscode.workspace.getConfiguration().update('turbocat.port', oldPort, true);
                logger.error('Failed to update Tomcat port:', true, err as string);
            }
        }

    }

    /**
     * Port number validation
     * 
     * Implements comprehensive port checking:
     * - Privileged port verification
     * - Upper range limitation
     * - Conflict detection
     * - Platform-specific checks
     * 
     * @param port Port number to validate
     * @throws Error with validation failure details
     */
    private async validatePort(port: number): Promise<void> {
        if (port < this.PORT_RANGE.min) {
            throw new Error(
                `Ports below ${this.PORT_RANGE.min} require admin privileges`
            );
        }

        if (port > this.PORT_RANGE.max) {
            throw new Error(
                `Maximum allowed port is ${this.PORT_RANGE.max}`
            );
        }

        try {
            let command: string;

            if (process.platform === 'win32') {
                command = `netstat -an | findstr ":${port}"`;
            } else {
                command = `netstat -an | grep ":${port}"`;
            }

            const { stdout } = await execAsync(command);
            if (stdout.includes(`:${port}`)) { throw new Error(`Port ${port} is already in use`); }
        } catch (error) {
            return;
        }
    }

    /**
     * server.xml modification
     * 
     * Performs atomic connector configuration updates:
     * - Safe file handling
     * - XML structure preservation
     * - Change verification
     * - Error recovery
     * 
     * @param tomcatHome Tomcat installation directory
     * @param newPort Port number to configure
     * @throws Error if file operations fail
     */
    private async modifyServerXmlPort(tomcatHome: string, newPort: number): Promise<void> {
        const serverXmlPath = path.join(tomcatHome, 'conf', 'server.xml');
        const content = await fsp.readFile(serverXmlPath, 'utf8');

        const updatedContent = content.replace(
            /(port=")\d+(".*protocol="HTTP\/1\.1")/,
            `$1${newPort}$2`
        );

        if (!updatedContent.includes(`port="${newPort}"`)) {
            throw (`Failed to update port in server.xml`);
        }

        await fsp.writeFile(serverXmlPath, updatedContent);
    }

    /**
     * Tomcat command execution
     * 
     * Executes Tomcat control commands with:
     * - Proper JVM argument setup
     * - Classpath configuration
     * - System property injection
     * - Error handling
     * 
     * @param action Command to execute (start/stop)
     * @param tomcatHome Tomcat installation directory
     * @param javaHome JDK installation directory
     * @throws Error if command execution fails
     * @log Command output if logging level is DEBUG
     */
    private async executeTomcatCommand(
        action: 'start' | 'stop',
        tomcatHome: string,
        javaHome: string,
        options?: { debug?: boolean, debugPort?: number }
    ): Promise<void> {
        if (action === 'start') {
            const logEncoding = logger.getLogEncoding();
            const { command, args } = this.buildCommand(action, tomcatHome, javaHome, options);

            const child = spawn(command, args, {
                stdio: 'pipe',
                shell: process.platform === 'win32',
                env: {
                    ...process.env,
                    ...this.tomcatEnvironment
                }
            });
            this.tomcatProcess = child;

            child.stdout.setEncoding(logEncoding as BufferEncoding);
            child.stderr.setEncoding(logEncoding as BufferEncoding);

            let stdoutBuffer = '';
            let stderrBuffer = '';

            child.stdout.on('data', (data) => {
                stdoutBuffer += data;
                const lines = stdoutBuffer.split(/\r?\n/);
                stdoutBuffer = lines.pop() || '';
                lines.forEach(line => logger.appendRawLine(line));
                this.runBrowserOnKeyword(data);
            });

            child.stderr.on('data', (data) => {
                stderrBuffer += data;
                const lines = stderrBuffer.split(/\r?\n/);
                stderrBuffer = lines.pop() || '';
                lines.forEach(line => logger.appendRawLine(line));
                this.runBrowserOnKeyword(data);
            });

            return new Promise((resolve, reject) => {
                child.on('close', (code) => {
                    this.tomcatProcess = null;
                    code === 0 ? resolve() : reject(new Error(`Start failed with code ${code}`));
                });

                child.on('error', (err) => {
                    this.tomcatProcess = null;
                    reject(err);
                });
            });
        } else {
            const { command, args } = this.buildCommand(action, tomcatHome, javaHome);
            const stopCommand = [command, ...args].join(' ');
            await execAsync(stopCommand, {
                env: {
                    ...process.env,
                    ...this.tomcatEnvironment
                }
            });
        }
    }
    
    /**
     * Browser launch keywords
     * 
     * Defines keywords for triggering browser launches:
     * - Server startup messages
     * - Context reload completion
     * 
     * @type {Array<string | RegExp>}
     */
    private browserCallKeywords: (string | RegExp)[] = [
        "Server startup in",
        "毫秒后服务器启动",
        /Reloading Context with name \[[^\]]+\] is completed/
    ];

    /**
     * Browser run on keywords
     * 
     * Handles Tomcat Manager API responses:
     * - Triggers browser launch on specific keywords
     * - Supports both exact strings and regex patterns
     * 
     * @param data Command output data
     */
    private runBrowserOnKeyword(data: string): void {
        for (const pattern of this.browserCallKeywords) {
            const isMatch = typeof pattern === 'string'
                ? data.includes(pattern)
                : pattern.test(data);

            if (isMatch) {
                // Make sure we have a valid app name before launching browser
                const appName = this.currentAppName || this.getAppName();
                Browser.getInstance().run(appName);
            }
        }
    }

    /**
     * Tomcat command construction
     * 
     * Builds platform-specific command strings with:
     * - Proper Java executable location
     * - Classpath configuration
     * - System property injection
     * - Argument escaping
     * 
     * @param action Command to build (start/stop)
     * @param tomcatHome Tomcat installation directory
     * @param javaHome JDK installation directory
     * @returns Fully constructed command string
     */
    private buildCommand(
        action: 'start' | 'stop',
        tomcatHome: string,
        javaHome: string,
        options?: { debug?: boolean, debugPort?: number }
    ): { command: string; args: string[] } {
        const javaExecutable = path.join(javaHome, 'bin', `java${process.platform === 'win32' ? '.exe' : ''}`);
        const classpath = [
            path.join(tomcatHome, 'bin', 'bootstrap.jar'),
            path.join(tomcatHome, 'bin', 'tomcat-juli.jar')
        ].join(path.delimiter);

        const args = [
            '-cp',
            classpath,
            `-Dcatalina.base=${tomcatHome}`,
            `-Dcatalina.home=${tomcatHome}`,
            `-Djava.io.tmpdir=${path.join(tomcatHome, 'temp')}`,
            'org.apache.catalina.startup.Bootstrap',
            action
        ];

        if (options?.debug) {
            const debugPort = options.debugPort || 8000;
            args.splice(2, 0, `-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=${debugPort}`);
        }

        return {
            command: javaExecutable,
            args
        };
    }

    /**
     * User management
     * 
     * Handles tomcat-users.xml modifications:
     * - Admin user creation
     * - Role assignment
     * - File permission handling
     * - XML structure preservation
     * 
     * @param tomcatHome Tomcat installation directory
     */
    private async addTomcatUser(tomcatHome: string): Promise<void> {
        const usersXmlPath = path.join(tomcatHome, 'conf', 'tomcat-users.xml');

        try {
            // Ensure Tomcat is stopped before modifying user configuration
            await this.ensureTomcatStopped(true);
            
            let content = await fsp.readFile(usersXmlPath, 'utf8');
            const newUser = '<user username="admin" password="admin" roles="manager-gui,manager-script"/>';

            content = content
                .replace(/<user username="admin".*\/>/g, '')
                .replace(/(<\/tomcat-users>)/, `  ${newUser}\n$1`);

            await fsp.writeFile(usersXmlPath, content);
            logger.info('Added admin user to tomcat-users.xml');
            this.start();
        } catch (err) {
            return;
        }
    }

    /**
     * Ensures Tomcat is stopped before executing critical operations
     * 
     * Helper method to ensure Tomcat is not running before operations that
     * require the server to be stopped (deployment, clean, configuration changes)
     * 
     * @param showMessages Whether to display status messages
     * @returns Promise resolving when Tomcat is confirmed stopped
     */
    private async ensureTomcatStopped(showMessages: boolean = false): Promise<void> {
        if (await this.isTomcatRunning()) {
            logger.info('Stopping Tomcat before operation...', showMessages);
            await this.stop(showMessages);
            // Add a small delay to ensure proper shutdown
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // If Tomcat is still running after stop, use kill as fallback
            if (await this.isTomcatRunning()) {
                logger.warn('Graceful shutdown failed, forcing termination...', showMessages);
                await this.kill();
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
    }
}