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
import { ChildProcess, spawn } from 'child_process';
import * as net from 'net';
import iconv from 'iconv-lite';

const execAsync = promisify(exec);
const logger = Logger.getInstance();

export class Tomcat {
    private static instance: Tomcat;
    private tomcatHome: string;
    private javaHome: string;
    private port: number;
    private shutdownPort: number;
    private tomcatProcess: ChildProcess | null = null;
    private currentAppName: string = '';
    private tomcatEnvironment: Record<string, string>;
    private tomcatDebugEnvironment: Record<string, string>;
    private lastStartMode: 'run' | 'debug';
    private deployPath: string;

    private readonly PORT_RANGE = { min: 1024, max: 65535 };

    /**
     * Private constructor - initialize configuration
     */
    private constructor() {
        this.tomcatHome = vscode.workspace.getConfiguration().get<string>('turbocat.home', '');
        this.javaHome = vscode.workspace.getConfiguration().get<string>('turbocat.javaHome', '');
        this.port = vscode.workspace.getConfiguration().get<number>('turbocat.port', 8080);
        this.shutdownPort = vscode.workspace.getConfiguration().get<number>('turbocat.shutdownPort', 8005);
        this.tomcatEnvironment = this.loadTomcatEnvironment('turbocat.tomcatEnvironment');
        this.tomcatDebugEnvironment = this.loadTomcatEnvironment('turbocat.tomcatDebugEnvironment');
        this.lastStartMode = 'run';
        this.deployPath = this.resolveDeployPathSetting();
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
        const previousDeployPath = this.deployPath;
        this.tomcatHome = vscode.workspace.getConfiguration().get<string>('turbocat.home', '');
        this.javaHome = vscode.workspace.getConfiguration().get<string>('turbocat.javaHome', '');
        this.port = vscode.workspace.getConfiguration().get<number>('turbocat.port', 8080);
        this.shutdownPort = vscode.workspace.getConfiguration().get<number>('turbocat.shutdownPort', 8005);
        this.tomcatEnvironment = this.loadTomcatEnvironment('turbocat.tomcatEnvironment');
        this.tomcatDebugEnvironment = this.loadTomcatEnvironment('turbocat.tomcatDebugEnvironment');
        this.deployPath = this.resolveDeployPathSetting();
        if (previousDeployPath !== this.deployPath) {
            this.currentAppName = '';
        }
    }

    private loadTomcatEnvironment(settingKey: string): Record<string, string> {
        const configured = vscode.workspace.getConfiguration().get<Record<string, unknown>>(settingKey, {});
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
        this.currentAppName = this.normalizeDeployPath(appName);
    }

    /** Get current application name or derive from workspace */
    public getAppName(): string {
        // If we already have an app name set, use it
        if (this.currentAppName) {
            return this.currentAppName;
        }

        if (this.deployPath) {
            this.currentAppName = this.deployPath;
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

    /** Return the configured deployment path override */
    public getConfiguredDeploymentPath(): string {
        return this.deployPath;
    }

    /**
     * Start Tomcat server
     */
    public async start(showMessages: boolean = false): Promise<boolean> {
        const tomcatHome = await this.findTomcatHome();
        const javaHome = await this.findJavaHome();
        if (!tomcatHome || !javaHome) { return false; }

        // Ensure Tomcat is stopped before starting
        await this.ensureTomcatStopped(false);

        try {
            await this.executeTomcatCommand('start', tomcatHome, javaHome, {
                environment: this.tomcatEnvironment
            });
            const started = await this.waitForServerState('running');
            if (started) {
                this.lastStartMode = 'run';
                logger.success('Tomcat started successfully', showMessages);
                return true;
            }

            logger.warn('Tomcat start command completed, but the server did not begin listening in time.', showMessages);
            return false;
        } catch (err) {
            logger.error('Failed to start Tomcat:', showMessages, err as string);
            return false;
        }
    }

    /**
     * Start Tomcat in debug mode
     */
    public async startDebug(showMessages: boolean = true): Promise<boolean> {
        const tomcatHome = await this.findTomcatHome();
        const javaHome = await this.findJavaHome();
        if (!tomcatHome || !javaHome) { return false; }

        // Ensure Tomcat is stopped before starting in debug mode
        await this.ensureTomcatStopped(false);

        try {
            const debugPort = vscode.workspace.getConfiguration().get<number>('turbocat.debugPort', 8000);
            await this.executeTomcatCommand('start', tomcatHome, javaHome, {
                debug: true,
                debugPort,
                environment: this.tomcatDebugEnvironment
            });
            const started = await this.waitForServerState('running');
            if (started) {
                this.lastStartMode = 'debug';
                logger.success(`Tomcat started in debug mode on port ${debugPort}`, showMessages);
                return true;
            }

            logger.warn('Tomcat debug start request timed out before the server began listening.', showMessages);
            return false;
        } catch (err) {
            logger.error('Failed to start Tomcat in debug mode:', showMessages, err as string);
            return false;
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
    public async stop(showMessages: boolean = false): Promise<boolean> {
        const tomcatHome = await this.findTomcatHome();
        const javaHome = await this.findJavaHome();
        if (!tomcatHome || !javaHome) { return false; }

        if (!await this.isTomcatRunning()) {
            logger.info('Tomcat is not running', showMessages);
            return false;
        }

        try {
            const shutdownSent = await this.sendShutdownSignal(tomcatHome);
            if (!shutdownSent) {
                if (this.tomcatProcess && !this.tomcatProcess.killed) {
                    await this.terminateSpawnedProcess();
                } else {
                    const environment = this.lastStartMode === 'debug'
                        ? this.tomcatDebugEnvironment
                        : this.tomcatEnvironment;
                    await this.executeTomcatCommand('stop', tomcatHome, javaHome, { environment });
                }
            }

            const stopped = await this.waitForServerState('stopped', 15000);
            if (stopped) {
                logger.success('Tomcat stopped successfully', showMessages);
                return true;
            }

            logger.warn('Graceful stop timed out, attempting forced termination...', showMessages);
            await this.kill();
            const forced = await this.waitForServerState('stopped', 5000);
            if (forced) {
                logger.success('Tomcat stopped after force termination', showMessages);
                return true;
            }

            logger.error('Tomcat could not be terminated and may still be running.', showMessages);
            return false;
        } catch (err) {
            logger.error('Failed to stop Tomcat:', showMessages, err as string);
            return false;
        }
    }

    /**
     * Ensure Tomcat is running in debug mode before attaching the debugger.
     * Automatically restarts the server in debug mode when necessary.
     */
    public async ensureDebugModeActive(showMessages: boolean = false): Promise<boolean> {
        const running = await this.isTomcatRunning();
        if (running && this.lastStartMode === 'debug') {
            return true;
        }

        if (running && this.lastStartMode !== 'debug') {
            logger.info('Restarting Tomcat in debug mode for debugger attach...', showMessages);
        }

        return this.startDebug(showMessages);
    }

    /**
     * Application hot-reload handler
     * 
     * Performs a controlled restart that preserves the previous run mode:
     * 1. Detects whether Tomcat is currently running
     * 2. Records if the last launch was in debug mode
     * 3. Stops the running instance gracefully
     * 4. Restarts Tomcat in the same mode (debug or standard)
     * 
     * @log Error if reload fails with diagnostic information
     */
    public async reload(): Promise<void> {
        if (!await this.findTomcatHome() || !await this.findJavaHome()) { return; }

        const wasDebugMode = this.lastStartMode === 'debug';
        const wasRunning = await this.isTomcatRunning();

        if (!wasRunning) {
            logger.info('Tomcat is not running, starting it...');
            const started = wasDebugMode
                ? await this.startDebug(true)
                : await this.start(true);

            if (!started) {
                logger.error('Tomcat reload failed: unable to start Tomcat.', true);
            }
            return;
        }

        try {
            await this.ensureTomcatStopped(true);
            logger.clearOutput();

            const restarted = wasDebugMode
                ? await this.startDebug(false)
                : await this.start(false);

            if (restarted) {
                logger.success(wasDebugMode ? 'Tomcat reloaded in debug mode' : 'Tomcat reloaded');
            } else {
                logger.error('Tomcat reload failed: the server did not restart.', true);
            }
        } catch (err) {
            logger.error('Failed to reload Tomcat:', true, err as string);
        }
    }

    /**
     * Server maintenance and cleanup
     * 
     * Removes only the currently tracked web application artifacts:
     * 1. Deletes the deployed webapp directory under webapps/
     * 2. Clears the matching work/ cache folder
     * 3. Removes temp files that belong to the same context
     * 
     * @log Error if cleanup fails with filesystem details
     */
    public async clean(): Promise<void> {
        const tomcatHome = await this.findTomcatHome();
        const javaHome = await this.findJavaHome();
        if (!tomcatHome || !javaHome) { return; }

        try {
            const appName = this.currentAppName || this.getAppName();
            if (!appName) {
                logger.error('No application name provided', true, 'Please provide a valid application name');
                return;
            }

            // Ensure Tomcat is stopped before cleaning
            await this.ensureTomcatStopped(true);

            const appDir = path.join(tomcatHome, 'webapps', appName);

            if (!fs.existsSync(appDir)) {
                logger.warn(`Webapp directory not found: ${appDir}`);
                return;
            }

            fs.rmSync(appDir, { recursive: true, force: true });
            logger.info(`Removed directory: ${appDir}`);

            const workDir = path.join(tomcatHome, 'work', appName);
            if (fs.existsSync(workDir)) {
                fs.rmSync(workDir, { recursive: true, force: true });
                logger.info(`Cleaned work directory: ${workDir}`);
            }

            const tempDir = path.join(tomcatHome, 'temp', appName);
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
                fs.mkdirSync(tempDir, { recursive: true });
                logger.info(`Cleaned temp directory: ${tempDir}`);
            }

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
        this.tomcatProcess = null;
    }

    private async terminateSpawnedProcess(): Promise<void> {
        if (!this.tomcatProcess) {
            return;
        }

        const pid = this.tomcatProcess.pid;
        const childRef = this.tomcatProcess;
        this.tomcatProcess = null;

        if (process.platform === 'win32' && pid) {
            try {
                await execAsync(`taskkill /T /PID ${pid}`);
            } catch {
                await execAsync(`taskkill /F /PID ${pid}`).catch(() => undefined);
            }
        } else {
            try {
                childRef.kill('SIGTERM');
            } catch {
                try {
                    childRef.kill();
                } catch {
                    // Ignore failures; force termination handled elsewhere
                }
            }
        }
    }

    private async sendShutdownSignal(tomcatHome: string): Promise<boolean> {
        if (!this.shutdownPort || this.shutdownPort <= 0) {
            return false;
        }

        const serverXmlPath = path.join(tomcatHome, 'conf', 'server.xml');
        let shutdownCommand = 'SHUTDOWN';
        try {
            const xml = await fsp.readFile(serverXmlPath, 'utf8');
            const shutdownMatch = xml.match(/<Server\b[^>]*shutdown="([^"]+)"/i);
            if (shutdownMatch?.[1]) {
                shutdownCommand = shutdownMatch[1];
            }
        } catch {
            // Ignore; fall back to default shutdown command
        }

        const attempt = (host: string): Promise<boolean> => {
            return new Promise<boolean>((resolve) => {
                let settled = false;
                let hadError = false;

                const finish = (result: boolean) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    socket.removeAllListeners();
                    resolve(result);
                };

                const socket = net.createConnection(
                    {
                        host,
                        port: this.shutdownPort
                    },
                    () => {
                        socket.write(shutdownCommand);
                        socket.end();
                    }
                );

                socket.setTimeout(5000, () => {
                    hadError = true;
                    socket.destroy();
                });

                socket.once('error', () => {
                    hadError = true;
                    finish(false);
                });

                socket.once('close', () => {
                    finish(!hadError);
                });
            });
        };

        const hosts = ['127.0.0.1', '::1'];
        for (const host of hosts) {
            const success = await attempt(host);
            if (success) {
                return true;
            }
        }

        return false;
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
     * Check whether a valid Tomcat home directory is currently configured.
     */
    public async hasValidTomcatHomeConfigured(): Promise<boolean> {
        if (!this.tomcatHome) {
            return false;
        }
        try {
            return await this.validateTomcatHome(this.tomcatHome);
        } catch {
            return false;
        }
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
        if (this.tomcatProcess && !this.tomcatProcess.killed) {
            return true;
        }

        if (await this.isPortListening(this.port)) {
            return true;
        }

        if (this.shutdownPort > 0 && await this.isPortListening(this.shutdownPort)) {
            return true;
        }

        return false;
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
        const newShutdownPort = config.get<number>('turbocat.shutdownPort', 8005);
        const oldPort = this.port;
        const oldShutdownPort = this.shutdownPort;

        if (newPort === oldPort && newShutdownPort === oldShutdownPort) {
            return;
        }

        try {
            const javaHome = await this.findJavaHome();
            const tomcatHome = await this.findTomcatHome();
            if (!javaHome || !tomcatHome) { return; }

            await this.validatePort(newPort);
            await this.validatePort(newShutdownPort);

            if (newPort === newShutdownPort && newShutdownPort > 0) {
                throw new Error('HTTP port and shutdown port must be different.');
            }

            const wasRunning = await this.isTomcatRunning();
            await this.ensureTomcatStopped(true);

            await this.modifyServerXmlPorts(tomcatHome, {
                http: newPort,
                shutdown: newShutdownPort
            });

            this.port = newPort;
            this.shutdownPort = newShutdownPort;

            logger.success(
                `Updated Tomcat ports (HTTP: ${oldPort} → ${newPort}, Shutdown: ${oldShutdownPort} → ${newShutdownPort})`,
                true
            );

            if (wasRunning) {
                try {
                    await this.executeTomcatCommand('start', tomcatHome, javaHome);
                } catch (startError) {
                    logger.error('Tomcat failed to restart after port change:', true, startError as string);
                }
            }
        } catch (err) {
            this.port = oldPort;
            this.shutdownPort = oldShutdownPort;
            await config.update('turbocat.port', oldPort, true);
            await config.update('turbocat.shutdownPort', oldShutdownPort, true);
            logger.error('Failed to update Tomcat port configuration:', true, err as string);
        }
    }

    private async isPortListening(port: number): Promise<boolean> {
        if (port <= 0) {
            return false;
        }

        try {
            const command = process.platform === 'win32'
                ? `netstat -ano | findstr ":${port}"`
                : `netstat -an | grep ":${port}"`;

            const { stdout } = await execAsync(command);
            const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            return lines.some(line =>
                line.includes(`:${port}`) &&
                /(LISTENING|LISTEN)/i.test(line)
            );
        } catch {
            return false;
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
        if (port <= 0) {
            return;
        }

        if (port < this.PORT_RANGE.min) {
            throw new Error(`Ports below ${this.PORT_RANGE.min} require admin privileges`);
        }

        if (port > this.PORT_RANGE.max) {
            throw new Error(`Maximum allowed port is ${this.PORT_RANGE.max}`);
        }

        if (await this.isPortListening(port)) {
            throw new Error(`Port ${port} is already in use`);
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
    private async modifyServerXmlPorts(tomcatHome: string, ports: { http: number; shutdown: number }): Promise<void> {
        const serverXmlPath = path.join(tomcatHome, 'conf', 'server.xml');
        const content = await fsp.readFile(serverXmlPath, 'utf8');

        let updatedContent = content.replace(
            /(<Server\b[^>]*port=")\d+(")/i,
            `$1${ports.shutdown}$2`
        );

        if (updatedContent === content) {
            throw new Error('Failed to update shutdown port in server.xml');
        }

        let httpConnectorUpdated = false;
        updatedContent = updatedContent.replace(/<Connector\b[^>]*>/gi, (tag) => {
            if (httpConnectorUpdated) {
                return tag;
            }

            const isAJP = /protocol\s*=\s*".*AJP/i.test(tag);
            if (isAJP) {
                return tag;
            }

            const isHttp = /protocol\s*=\s*".*http/i.test(tag) || !/protocol\s*=\s*"/i.test(tag);
            if (!isHttp) {
                return tag;
            }

            if (!/port\s*=\s*"\d+"/i.test(tag)) {
                return tag;
            }

            httpConnectorUpdated = true;
            return tag.replace(/port\s*=\s*"\d+"/i, `port="${ports.http}"`);
        });

        if (!httpConnectorUpdated) {
            throw new Error('Failed to locate HTTP connector in server.xml');
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
        options?: { debug?: boolean, debugPort?: number, environment?: Record<string, string> }
    ): Promise<void> {
        const environment = options?.environment ?? this.tomcatEnvironment;

        if (action === 'start') {
            const logEncoding = logger.getLogEncoding();
            const { command, args } = this.buildCommand(action, tomcatHome, javaHome, options);

            const child = spawn(command, args, {
                stdio: 'pipe',
                shell: process.platform === 'win32',
                env: {
                    ...process.env,
                    ...environment
                }
            });
            this.tomcatProcess = child;

            let stdoutBuffer = '';
            let stderrBuffer = '';
            const resolvedEncoding = iconv.encodingExists(logEncoding) ? logEncoding : 'utf8';

            const decode = (data: Buffer | string): string => {
                const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
                try {
                    return iconv.decode(buffer, resolvedEncoding);
                } catch {
                    return buffer.toString('utf8');
                }
            };

            child.stdout.on('data', (data) => {
                stdoutBuffer += decode(data);
                const lines = stdoutBuffer.split(/\r?\n/);
                stdoutBuffer = lines.pop() || '';
                lines.forEach(line => logger.appendRawLine(line));
            });

            child.stderr.on('data', (data) => {
                stderrBuffer += decode(data);
                const lines = stderrBuffer.split(/\r?\n/);
                stderrBuffer = lines.pop() || '';
                lines.forEach(line => logger.appendRawLine(line));
            });

            child.stdout.on('end', () => {
                if (stdoutBuffer.trim()) {
                    logger.appendRawLine(stdoutBuffer);
                }
                stdoutBuffer = '';
            });

            child.stderr.on('end', () => {
                if (stderrBuffer.trim()) {
                    logger.appendRawLine(stderrBuffer);
                }
                stderrBuffer = '';
            });

            return new Promise((resolve, reject) => {
                child.on('close', (code, signal) => {
                    this.tomcatProcess = null;
                    if (code === 0 || code === 143 || signal === 'SIGTERM') {
                        resolve();
                    } else {
                        reject(new Error(`Start failed with code ${code}`));
                    }
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
                    ...environment
                }
            });
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
     * Ensures Tomcat is stopped before executing critical operations
     * 
     * Helper method to ensure Tomcat is not running before operations that
     * require the server to be stopped (deployment, clean, configuration changes)
     * 
     * @param showMessages Whether to display status messages
     * @returns Promise resolving when Tomcat is confirmed stopped
     */
    private async ensureTomcatStopped(showMessages: boolean = false): Promise<void> {
        if (!await this.isTomcatRunning()) {
            return;
        }

        logger.info('Stopping Tomcat before operation...', showMessages);
        const stoppedGracefully = await this.stop(showMessages);

        if (stoppedGracefully || !await this.isTomcatRunning()) {
            return;
        }

        logger.warn('Graceful shutdown failed, forcing termination...', showMessages);
        await this.kill();
        const forced = await this.waitForServerState('stopped', 5000);
        if (!forced) {
            logger.error('Forced termination failed; Tomcat may still be running.', showMessages);
        } else if (showMessages) {
            logger.success('Tomcat stopped after force termination', showMessages);
        }
    }

    private async waitForServerState(
        expected: 'running' | 'stopped',
        timeoutMs: number = 10000,
        pollInterval: number = 250
    ): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            const running = await this.isTomcatRunning();
            if ((expected === 'running' && running) || (expected === 'stopped' && !running)) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        const running = await this.isTomcatRunning();
        return expected === 'running' ? running : !running;
    }

    private resolveDeployPathSetting(): string {
        const configured = vscode.workspace.getConfiguration().get<string>('turbocat.deployPath', '') || '';
        return this.normalizeDeployPath(configured);
    }

    private normalizeDeployPath(value: string): string {
        const trimmed = (value ?? '').trim();
        if (!trimmed) {
            return '';
        }

        const normalized = trimmed.replace(/\\/g, '/');
        const withoutLeading = normalized.replace(/^\/+/, '');
        const withoutTrailing = withoutLeading.replace(/\/+$/, '');

        return withoutTrailing;
    }
}
