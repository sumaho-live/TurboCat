/**
 * Unified logging service with Tomcat log monitoring
 * Singleton pattern with multi-level filtering and output channel management
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import iconv from "iconv-lite";
import { getWorkspaceConfiguration } from "../core/workspace";
import { getActiveWorkspaceFolder } from "../core/workspace";
//import { Builder } from './Builder';

type LogContext = "general" | "smartDeploy";

export class Logger {
  private static readonly instances = new Map<string, Logger>();
  private static readonly outputChannels = new Map<string, vscode.OutputChannel>();
  private readonly workspaceFolder: vscode.WorkspaceFolder | undefined;
  private tomcatHome: string;
  private runtimeBase: string;
  private outputChannel: vscode.OutputChannel;

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
    ERROR: 6,
  };

  /**
   * Private constructor - initializes configuration and output channels
   */
  private constructor(workspaceFolder?: vscode.WorkspaceFolder) {
    this.workspaceFolder = workspaceFolder;
    const config = this.getConfiguration();
    this.tomcatHome = config.get<string>("home", "");
    this.runtimeBase = this.tomcatHome;
    //this.autoDeployMode = vscode.workspace.getConfiguration().get<string>('turbocat.autoDeployMode', 'Disable');
    this.logLevel = (config.get<string>("logLevel", "INFO") || "INFO")
      .trim()
      .toUpperCase();
    if (!(this.logLevel in this.logLevels)) {
      this.logLevel = "INFO";
    }
    this.showTimestamp = config.get<boolean>("showTimestamp", true);
    this.autoShowOutput = config.get<boolean>("autoShowOutput", true);
    this.showSmartDeployLog = config.get<boolean>("showSmartDeployLog", true);

    // Single output channel for all logs
    const channelName = workspaceFolder
      ? `TurboCat • ${workspaceFolder.name}`
      : "TurboCat";
    const channelKey = workspaceFolder?.uri.toString() ?? "__global__";
    this.outputChannel =
      Logger.outputChannels.get(channelKey) ??
      vscode.window.createOutputChannel(channelName, "log");
    Logger.outputChannels.set(channelKey, this.outputChannel);

    this.logEncoding = this.resolveLogEncoding();
  }

  /**
   * Get singleton Logger instance
   */
  public static getInstance(resource?: vscode.Uri): Logger {
    const workspaceFolder = getActiveWorkspaceFolder(resource);
    const key = workspaceFolder?.uri.toString() ?? "__global__";
    let instance = Logger.instances.get(key);
    if (!instance) {
      instance = new Logger(workspaceFolder);
      Logger.instances.set(key, instance);
    }
    return instance;
  }

  public static getAllInstances(): readonly Logger[] {
    return [...Logger.instances.values()];
  }

  public static removeInstance(resource: vscode.Uri): void {
    const key = resource.toString();
    Logger.instances.get(key)?.releaseRuntime();
    Logger.instances.delete(key);
  }

  public static disposeAll(): void {
    for (const instance of Logger.instances.values()) {
      instance.releaseRuntime();
    }
    for (const channel of Logger.outputChannels.values()) {
      channel.dispose();
    }
    Logger.instances.clear();
    Logger.outputChannels.clear();
  }

  public static clearInstancesForTests(): void {
    // Tests replace workspace folders repeatedly inside one extension host.
    // Do not dispose VS Code output channels here because recreating a channel
    // with the same name after disposal is not supported by older hosts.
    Logger.instances.clear();
    Logger.outputChannels.clear();
  }

  private getConfiguration(): vscode.WorkspaceConfiguration {
    return getWorkspaceConfiguration("turbocat", this.workspaceFolder?.uri);
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
    const config = this.getConfiguration();
    this.tomcatHome = config.get<string>("home", "");
    if (!this.runtimeBase) {
      this.runtimeBase = this.tomcatHome;
    }
    //this.autoDeployMode = vscode.workspace.getConfiguration().get<string>('turbocat.autoDeployMode', 'Disable');
    this.logLevel = (config.get<string>("logLevel", "INFO") || "INFO")
      .trim()
      .toUpperCase();
    if (!(this.logLevel in this.logLevels)) {
      this.logLevel = "INFO";
    }
    this.showTimestamp = config.get<boolean>("showTimestamp", true);
    const previousEncoding = this.logEncoding;
    this.logEncoding = this.resolveLogEncoding();
    if (previousEncoding !== this.logEncoding) {
      this.invalidEncodingWarned = false;
      this.partialLines.clear();
      this.accessLogOffsets.clear();
    }
    this.autoShowOutput = config.get<boolean>("autoShowOutput", true);
    this.showSmartDeployLog = config.get<boolean>("showSmartDeployLog", true);
  }

  /**
   * Clean up all resources and watchers
   */
  public deactivate(): void {
    this.releaseRuntime();
  }

  public releaseRuntime(): void {
    if (this.unifiedLogWatcher) {
      this.unifiedLogWatcher.close();
      this.unifiedLogWatcher = undefined;
    }
    this.accessLogWatcher?.close();
    this.accessLogWatcher = undefined;
    this.partialLines.clear();
    this.accessLogOffsets.clear();
  }

  /**
   * Initialize status bar item
   */
  public init(): void {
    //vscode.commands.executeCommand('setContext', 'turbocat.showdeployButton', true);
    this.startLogFileWatcher();
  }

  public setRuntimeBase(runtimeBase: string): void {
    this.runtimeBase = runtimeBase;
    this.startLogFileWatcher();
  }

  /** Log info message */
  public info(
    message: string,
    showToast: boolean = false,
    context: LogContext = "general",
  ): void {
    this.log(
      "INFO",
      message,
      showToast ? vscode.window.showInformationMessage : undefined,
      false,
      context,
    );
  }

  /** Log success message */
  public success(
    message: string,
    showToast: boolean = false,
    context: LogContext = "general",
  ): void {
    this.log(
      "SUCCESS",
      message,
      showToast ? vscode.window.showInformationMessage : undefined,
      false,
      context,
    );
  }

  /** Log debug message */
  public debug(
    message: string,
    showToast: boolean = false,
    context: LogContext = "general",
  ): void {
    this.log(
      "DEBUG",
      message,
      showToast ? vscode.window.showInformationMessage : undefined,
      false,
      context,
    );
  }

  /** Log warning message */
  public warn(
    message: string,
    showToast: boolean = false,
    context: LogContext = "general",
  ): void {
    this.log(
      "WARN",
      message,
      showToast ? vscode.window.showWarningMessage : undefined,
      false,
      context,
    );
  }

  /** Log error message */
  public error(
    message: string,
    showToast: boolean = false,
    error?: Error | string,
    context: LogContext = "general",
  ): void {
    let errorMsg = "";
    if (error) {
      errorMsg =
        typeof error === "string" ? error : error.stack || error.message;
    }
    const fullMessage = errorMsg ? `${message}\n${errorMsg}` : message;
    this.log(
      "ERROR",
      fullMessage,
      showToast ? vscode.window.showErrorMessage : undefined,
      false,
      context,
    );
  }

  /**
   * Start monitoring Tomcat log files
   */
  public startLogFileWatcher(): void {
    const runtimeBase = this.runtimeBase || this.tomcatHome;
    if (!runtimeBase) {
      return;
    }

    const logsDir = path.join(runtimeBase, "logs");

    // Single real-time watcher for current log file
    this.watchAccessLogDirectly(runtimeBase);
    // Lightweight directory watcher for log rotation detection only
    this.setupLogRotationWatcher(logsDir);
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
    this.log("APP", message, undefined, true);
  }

  /**
   * Monitor access logs directly for real-time updates
   */
  private async watchAccessLogDirectly(tomcatHome: string) {
    const logsDir = path.join(tomcatHome, "logs");
    const accessLogPattern = /localhost_access_log\.\d{4}-\d{2}-\d{2}\.log/;

    this.accessLogWatcher?.close();
    this.accessLogWatcher = undefined;

    let files: string[];
    try {
      files = await fs.promises.readdir(logsDir);
    } catch {
      return;
    }

    const accessLogs = files
      .filter((f) => accessLogPattern.test(f))
      .sort()
      .reverse();

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
      if (eventType === "change") {
        this.handleLiveLogUpdate(logPath);
      }
    });

    try {
      const size = fs.statSync(logPath).size;
      this.accessLogOffsets.set(logPath, size);
      this.partialLines.set(logPath, "");
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
        this.partialLines.set(logPath, "");
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

  private tailFile(filePath: string, start: number, end: number): void {
    if (end <= start) {
      return;
    }

    const stream = fs.createReadStream(filePath, {
      start,
      end: end - 1,
    });

    const buffers: Buffer[] = [];
    stream.on("data", (chunk) => {
      if (Buffer.isBuffer(chunk)) {
        buffers.push(chunk);
      } else {
        buffers.push(Buffer.from(chunk));
      }
    });

    stream.on("end", () => {
      if (!buffers.length) {
        return;
      }
      this.processLogBuffer(filePath, Buffer.concat(buffers));
    });

    stream.on("error", (error) => {
      this.warn(
        `Failed to read log updates from ${filePath}: ${(error as Error).message}`,
      );
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
        this.warn(
          `Encoding '${encoding}' is not recognized. Falling back to UTF-8.`,
          false,
        );
        this.invalidEncodingWarned = true;
      }
    } catch (error) {
      if (!this.invalidEncodingWarned) {
        this.warn(
          `Failed to decode log chunk with encoding '${encoding}'. Falling back to UTF-8.`,
          false,
        );
        this.invalidEncodingWarned = true;
      }
    }

    return buffer.toString("utf8");
  }

  private processDecodedLines(filePath: string, decoded: string): void {
    const previous = this.partialLines.get(filePath) ?? "";
    const combined = previous + decoded;
    const lines = combined.split(/\r?\n/);

    const hasTrailingNewline = /(\r?\n)$/.test(combined);
    const remainder = hasTrailingNewline ? "" : (lines.pop() ?? "");
    this.partialLines.set(filePath, remainder);

    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (line.trim().length > 0) {
        this.processAccessLogLine(line);
      }
    }
  }

  private resolveLogEncoding(): string {
    const config = this.getConfiguration();
    return config.get<string>("logEncoding", "utf8");
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
    context: LogContext = "general",
  ): void {
    const messageLevel = level.toUpperCase();
    const messageLevelValue =
      this.logLevels[messageLevel] ?? this.logLevels.INFO;
    const threshold = this.logLevels[this.logLevel] ?? this.logLevels.INFO;

    if (!isTomcatLog && messageLevelValue < threshold) {
      return;
    }

    if (!isTomcatLog && !this.showSmartDeployLog && context === "smartDeploy") {
      // When smart deploy logs are hidden, respect the user's logLevel
      // instead of hardcoding INFO, so logLevel=DEBUG still shows debug chatter.
      if (messageLevelValue < threshold) {
        return;
      }
    }

    let formattedMessage: string;

    if (isTomcatLog) {
      // For Tomcat logs, output original message without any modification
      formattedMessage = message;
    } else {
      // For extension logs, apply standard formatting
      const timestamp = this.showTimestamp
        ? `[${new Date().toLocaleString()}] `
        : "";
      formattedMessage = `${timestamp}[TurboCat][${messageLevel}] ${message}`;
    }

    // Determine which output channel to use
    this.outputChannel.appendLine(formattedMessage);

    if (showUI) {
      showUI(message).then((selection) => {
        if (selection) {
          const timestamp = this.showTimestamp
            ? `[${new Date().toLocaleString()}] `
            : "";
          this.outputChannel.appendLine(
            `${timestamp}[TurboCat][INFO] User selected: ${selection}`,
          );
        }
      });
    }

    // Only show the output channel automatically if configured to do so
    if (
      this.autoShowOutput &&
      ["ERROR", "WARN", "APP"].includes(messageLevel)
    ) {
      this.outputChannel.show(true);
    }
  }

  /**
   * Lightweight directory watcher for log rotation detection.
   * Only detects when new log files appear and re-attaches the real-time watcher.
   */
  private setupLogRotationWatcher(logsDir: string): void {
    if (this.unifiedLogWatcher) {
      this.unifiedLogWatcher.close();
    }

    try {
      this.unifiedLogWatcher = fs.watch(logsDir, (eventType, filename) => {
        if (
          filename &&
          filename.startsWith("localhost_access_log.") &&
          eventType === "rename"
        ) {
          // New log file detected (rotation) - re-attach real-time watcher
          this.watchAccessLogDirectly(this.runtimeBase || this.tomcatHome);
        }
      });
    } catch {
      // Directory watching not available - gracefully degrade
    }
  }
}
