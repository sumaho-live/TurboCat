/**
 * Unified logging service with Tomcat log monitoring
 * Singleton pattern with multi-level filtering and output channel management
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import iconv from 'iconv-lite';
//import { Builder } from './Builder';

type LogContext = 'general' | 'smartDeploy';

export class Logger {
    private static instance: Logger;
    private tomcatHome: string;
    private outputChannel: vscode.OutputChannel;
    private statusBarItem?: vscode.StatusBarItem;
    private currentLogFile: string | null = null;
    private fileCheckInterval?: NodeJS.Timeout;
    private logWatchers: { file: string; listener: fs.StatsListener }[] = []; // Optimized for fewer active watchers
    private accessLogWatcher?: fs.FSWatcher;
    private unifiedLogWatcher?: fs.FSWatcher; // Single watcher for log directory monitoring
    private logLevel: string;
    private showTimestamp: boolean;
    private logEncoding: string;
    private autoShowOutput: boolean;
    private showSmartDeployLog: boolean;
    private invalidEncodingWarned = false;
    private accessLogOffsets: Map<string, number> = new Map();
    private partialLines: Map<string, string> = new Map();
    private logLevels: { [key: string]: number } = {
        DEBUG: 0,
        INFO: 1,
        SUCCESS: 2,
        HTTP: 3,
        APP: 4,
        WARN: 5,
        ERROR: 6
    };

    /**
     * Private constructor - initializes configuration and output channels
     */
    private constructor() {
        this.tomcatHome = vscode.workspace.getConfiguration().get<string>('turbocat.home', '');
        //this.autoDeployMode = vscode.workspace.getConfiguration().get<string>('turbocat.autoDeployMode', 'Disable');
        this.logLevel = vscode.workspace.getConfiguration().get<string>('turbocat.logLevel', 'INFO').toUpperCase();
        if (!Object.keys(this.logLevels).includes(this.logLevel)) {
            this.logLevel = 'INFO';
        }
        this.showTimestamp = vscode.workspace.getConfiguration().get<boolean>('turbocat.showTimestamp', true);
        this.autoShowOutput = vscode.workspace.getConfiguration().get<boolean>('turbocat.autoShowOutput', true);
        this.showSmartDeployLog = vscode.workspace.getConfiguration().get<boolean>('turbocat.showSmartDeployLog', true);
        
        // Single output channel for all logs
        this.outputChannel = vscode.window.createOutputChannel('TurboCat', 'log');
        
        this.logEncoding = this.resolveLogEncoding();
    }

    /**
     * Get singleton Logger instance
     */
    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    /**
     * Get current log encoding setting
     */
    public getLogEncoding(): string {
        return this.logEncoding;
    }

    /**
     * Update configuration from workspace settings
     */
    public updateConfig(): void {
        this.tomcatHome = vscode.workspace.getConfiguration().get<string>('turbocat.home', '');
        //this.autoDeployMode = vscode.workspace.getConfiguration().get<string>('turbocat.autoDeployMode', 'Disable');
        this.logLevel = vscode.workspace.getConfiguration().get<string>('turbocat.logLevel', 'INFO').toUpperCase();
        if (!Object.keys(this.logLevels).includes(this.logLevel)) {
            this.logLevel = 'INFO';
        }
        this.showTimestamp = vscode.workspace.getConfiguration().get<boolean>('turbocat.showTimestamp', true);
        const previousEncoding = this.logEncoding;
        this.logEncoding = this.resolveLogEncoding();
        if (previousEncoding !== this.logEncoding) {
            this.invalidEncodingWarned = false;
            this.partialLines.clear();
            this.accessLogOffsets.clear();
        }
        this.autoShowOutput = vscode.workspace.getConfiguration().get<boolean>('turbocat.autoShowOutput', true);
        this.showSmartDeployLog = vscode.workspace.getConfiguration().get<boolean>('turbocat.showSmartDeployLog', true);
    }

    /**
     * Clean up all resources and watchers
     */
    public deactivate(): void {
        this.outputChannel.dispose();
        this.statusBarItem?.dispose();
        if (this.fileCheckInterval) {
            clearInterval(this.fileCheckInterval);
        }
        if (this.unifiedLogWatcher) {
            this.unifiedLogWatcher.close();
        }
        this.logWatchers.forEach(watcher => fs.unwatchFile(watcher.file, watcher.listener));
        this.accessLogWatcher?.close();
    }

    /**
     * Initialize status bar item
     */
    public init(): void {
        //vscode.commands.executeCommand('setContext', 'turbocat.showdeployButton', true);
        this.startLogFileWatcher();
    }

    /** Log info message */
    public info(message: string, showToast: boolean = false, context: LogContext = 'general'): void {
        this.log('INFO', message, showToast ? vscode.window.showInformationMessage : undefined, false, context);
    }

    /** Log success message */
    public success(message: string, showToast: boolean = false, context: LogContext = 'general'): void {
        this.log('SUCCESS', message, showToast ? vscode.window.showInformationMessage : undefined, false, context);
    }

    /** Log debug message */
    public debug(message: string, showToast: boolean = false, context: LogContext = 'general'): void {
        this.log('DEBUG', message, showToast ? vscode.window.showInformationMessage : undefined, false, context);
    }

    /** Log warning message */
    public warn(message: string, showToast: boolean = false, context: LogContext = 'general'): void {
        this.log('WARN', message, showToast ? vscode.window.showWarningMessage : undefined, false, context);
    }

    /** Log error message */
    public error(message: string, showToast: boolean = false, error?: Error | string, context: LogContext = 'general'): void {
        let errorMsg = '';
        if (error) {
            errorMsg = typeof error === 'string' ? error : error.stack || error.message;
        }
        const fullMessage = errorMsg ? `${message}\n${errorMsg}` : message;
        this.log('ERROR', fullMessage, showToast ? vscode.window.showErrorMessage : undefined, false, context);
    }

   
    /**
     * Start monitoring Tomcat log files
     */
    public startLogFileWatcher(): void {
        if (!this.tomcatHome) {
            return;
        }

        const logsDir = path.join(this.tomcatHome, 'logs');
        
        // Use a single directory watcher instead of polling interval + multiple file watchers
        this.setupUnifiedLogWatcher(logsDir);
        this.watchAccessLogDirectly(this.tomcatHome);
    }

    /**
     * Clear the output channel so the next server run shows fresh logs
     */
    public clearOutput(): void {
        this.outputChannel.clear();
    }

    /**
     * Append raw Tomcat log line to output channel
     */
    public appendRawLine(message: string): void {
        // Skip empty lines
        if (!message.trim()) {
            return;
        }
        
        // Output original message without any processing or filtering
        this.log('APP', message, undefined, true);
    }

    /**
     * Monitor access logs directly for real-time updates
     */
    private async watchAccessLogDirectly(tomcatHome: string) {
        const logsDir = path.join(tomcatHome, 'logs');
        const accessLogPattern = /localhost_access_log\.\d{4}-\d{2}-\d{2}\.log/;

        this.accessLogWatcher?.close();
        this.accessLogWatcher = undefined;

        const files = await fs.promises.readdir(logsDir);
        const accessLogs = files.filter(f => accessLogPattern.test(f))
            .sort().reverse();

        if (accessLogs.length > 0) {
            const logPath = path.join(logsDir, accessLogs[0]);
            this.setupRealtimeAccessLog(logPath);
        }
    }

    /**
     * Setup real-time access log monitoring
     */
    private setupRealtimeAccessLog(logPath: string) {
        this.accessLogWatcher = fs.watch(logPath, (eventType) => {
            if (eventType === 'change') {
                this.handleLiveLogUpdate(logPath);
            }
        });

        try {
            const size = fs.statSync(logPath).size;
            this.accessLogOffsets.set(logPath, size);
            this.partialLines.set(logPath, '');
        } catch {
            this.accessLogOffsets.delete(logPath);
            this.partialLines.delete(logPath);
        }
    }

    /** Handle live log file updates */
    private handleLiveLogUpdate(logPath: string) {
        try {
            const newSize = fs.statSync(logPath).size;
            const oldSize = this.accessLogOffsets.get(logPath) ?? 0;

            if (newSize > oldSize) {
                this.tailFile(logPath, oldSize, newSize);
                this.accessLogOffsets.set(logPath, newSize);
            } else if (newSize < oldSize) {
                // File was truncated (rotation) – reset cursors
                this.accessLogOffsets.set(logPath, newSize);
                this.partialLines.set(logPath, '');
            }
        } catch {
            this.accessLogOffsets.delete(logPath);
            this.partialLines.delete(logPath);
        }
    }

    /** Process access log entries without reformatting */
    private processAccessLogLine(rawLine: string) {
        this.appendRawLine(rawLine);
    }

    /** Check for new log files due to rotation */
    private checkForNewLogFile(logsDir: string): void {
        fs.readdir(logsDir, (err, files) => {
            if (err) {
                return;
            }

            const logFiles = files
                .filter(file => file.startsWith('localhost_access_log.'))
                .sort((a, b) => this.extractDate(b) - this.extractDate(a));

            if (logFiles.length === 0) {
                return;
            }

            const latestFile = path.join(logsDir, logFiles[0]);
            if (latestFile !== this.currentLogFile) {
                this.switchLogFile(latestFile);
            }
        });
    }

    /**
     * Active log file switcher (Optimized)
     * 
     * Uses single file watcher instead of multiple watchers:
     * 1. Disposes previous single watcher efficiently
     * 2. Sets up new single file watcher for the current log
     * 3. Maintains consistent monitoring with reduced overhead
     * 
     * @param newFile Path to new log file to monitor
     */
    private switchLogFile(newFile: string): void {
        // Dispose existing watchers - now more efficient with single watcher
        this.logWatchers.forEach(({ file, listener }) => {
            fs.unwatchFile(file, listener);
            this.partialLines.delete(file);
            this.accessLogOffsets.delete(file);
        });
        this.logWatchers = [];

        this.currentLogFile = newFile;
        this.partialLines.set(newFile, '');

        fs.stat(newFile, (err) => {
            if (err) {
                return;
            }

            // Create single optimized file watcher
            const listener: fs.StatsListener = (curr, prev) => {
                if (curr.size > prev.size) {
                    this.handleLogUpdate(newFile, prev.size, curr.size);
                }
            };

            fs.watchFile(newFile, { interval: 1000 }, listener);
            this.logWatchers.push({ file: newFile, listener });
        });
    }

    /**
     * Log update handler
     * 
     * Processes new log entries with:
     * - Delta change detection
     * - Stream-based partial reading
     * - Log line sanitization
     * - HTTP event extraction
     * 
     * @param filePath Path to modified log file
     * @param prevSize Previous file size in bytes
     * @param currSize Current file size in bytes
     */
    private handleLogUpdate(filePath: string, prevSize: number, currSize: number): void {
        this.tailFile(filePath, prevSize, currSize);
    }

    private tailFile(filePath: string, start: number, end: number): void {
        if (end <= start) {
            return;
        }

        const stream = fs.createReadStream(filePath, {
            start,
            end: end - 1
        });

        const buffers: Buffer[] = [];
        stream.on('data', chunk => {
            if (Buffer.isBuffer(chunk)) {
                buffers.push(chunk);
            } else {
                buffers.push(Buffer.from(chunk));
            }
        });

        stream.on('end', () => {
            if (!buffers.length) {
                return;
            }
            this.processLogBuffer(filePath, Buffer.concat(buffers));
        });

        stream.on('error', (error) => {
            this.warn(`Failed to read log updates from ${filePath}: ${(error as Error).message}`);
        });
    }

    private processLogBuffer(filePath: string, buffer: Buffer): void {
        const decoded = this.decodeBuffer(buffer);
        this.processDecodedLines(filePath, decoded);
    }

    private decodeBuffer(buffer: Buffer): string {
        const encoding = this.logEncoding;
        try {
            if (iconv.encodingExists(encoding)) {
                this.invalidEncodingWarned = false;
                return iconv.decode(buffer, encoding);
            }

            if (!this.invalidEncodingWarned) {
                this.warn(`Encoding '${encoding}' is not recognized. Falling back to UTF-8.`, false);
                this.invalidEncodingWarned = true;
            }
        } catch (error) {
            if (!this.invalidEncodingWarned) {
                this.warn(`Failed to decode log chunk with encoding '${encoding}'. Falling back to UTF-8.`, false);
                this.invalidEncodingWarned = true;
            }
        }

        return buffer.toString('utf8');
    }

    private processDecodedLines(filePath: string, decoded: string): void {
        const previous = this.partialLines.get(filePath) ?? '';
        const combined = previous + decoded;
        const lines = combined.split(/\r?\n/);

        const hasTrailingNewline = /(\r?\n)$/.test(combined);
        const remainder = hasTrailingNewline ? '' : (lines.pop() ?? '');
        this.partialLines.set(filePath, remainder);

        for (const raw of lines) {
            const line = raw.replace(/\r$/, '');
            if (line.trim().length > 0) {
                this.processAccessLogLine(line);
            }
        }
    }

    private resolveLogEncoding(): string {
        const config = vscode.workspace.getConfiguration();
        const custom = (config.get<string>('turbocat.logEncodingCustom', '') ?? '').trim();
        if (custom) {
            return custom;
        }

        return config.get<string>('turbocat.logEncoding', 'utf8');
    }

    /**
     * Log filename date extractor
     * 
     * Parses timestamp from log filenames for:
     * - Chronological sorting
     * - Rotation pattern detection
     * - File version comparison
     * - Temporal correlation
     * 
     * @param filename Access log filename
     * @returns Parsed timestamp in milliseconds
     */
    private extractDate(filename: string): number {
        const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
        return dateMatch ? Date.parse(dateMatch[1]) : 0;
    }

    /**
     * Core logging mechanism (modified).
     * 
     * @param level The log severity level.
     * @param message The content of the log.
     * @param showUI Optional callback to show a UI notification.
     * @param isTomcatLog Whether this is a raw Tomcat log line
     */
    private log(
        level: string,
        message: string,
        showUI?: (message: string) => Thenable<string | undefined>,
        isTomcatLog: boolean = false,
        context: LogContext = 'general'
    ): void {
        const messageLevel = level.toUpperCase();
        const messageLevelValue = this.logLevels[messageLevel] ?? this.logLevels.INFO;
        if (!isTomcatLog && messageLevelValue < this.logLevels[this.logLevel]) {
            return;
        }

        if (!isTomcatLog && !this.showSmartDeployLog && context === 'smartDeploy') {
            if (messageLevelValue < this.logLevels.WARN) {
                return;
            }
        }

        let formattedMessage: string;
        
        if (isTomcatLog) {
            // For Tomcat logs, output original message without any modification
            formattedMessage = message;
        } else {
            // For extension logs, apply standard formatting
            const timestamp = this.showTimestamp ? `[${new Date().toLocaleString()}] ` : '';
            formattedMessage = `${timestamp}[TurboCat][${messageLevel}] ${message}`;
        }

        // Determine which output channel to use
        this.outputChannel.appendLine(formattedMessage);

        if (showUI) {
            showUI(message).then(selection => {
                if (selection) {
                    const timestamp = this.showTimestamp ? `[${new Date().toLocaleString()}] ` : '';
                    this.outputChannel.appendLine(`${timestamp}[TurboCat][INFO] User selected: ${selection}`);
                }
            });
        }

        // Only show the output channel automatically if configured to do so
        if (this.autoShowOutput && (['ERROR', 'WARN', 'APP'].includes(messageLevel))) {
            this.outputChannel.show(true);
        }
    }

    /**
     * Setup unified log directory watcher (New)
     * 
     * Replaces polling-based log rotation detection with:
     * - Single filesystem watcher on logs directory
     * - Event-driven log file creation/modification detection
     * - Automatic log rotation handling
     * - Reduced resource usage compared to interval polling
     * 
     * @param logsDir Path to Tomcat logs directory
     */
    private setupUnifiedLogWatcher(logsDir: string): void {
        // Dispose existing interval-based checking
        if (this.fileCheckInterval) {
            clearInterval(this.fileCheckInterval);
            this.fileCheckInterval = undefined;
        }

        // Dispose existing unified watcher if any
        if (this.unifiedLogWatcher) {
            this.unifiedLogWatcher.close();
        }

        // Create single directory watcher for log rotation detection
        try {
            this.unifiedLogWatcher = fs.watch(logsDir, (eventType, filename) => {
                // Only respond to log file changes
                if (filename && filename.startsWith('localhost_access_log.')) {
                    if (eventType === 'rename' || eventType === 'change') {
                        // Log rotation or new content detected
                        this.checkForNewLogFile(logsDir);
                    }
                }
            });
            
            // Initial check for existing log files
            this.checkForNewLogFile(logsDir);
            
        } catch (error) {
            // Fallback to polling if directory watching fails
            this.fileCheckInterval = setInterval(() => {
                this.checkForNewLogFile(logsDir);
            }, 1000); // Increased interval since it's a fallback
        }
    }
}
