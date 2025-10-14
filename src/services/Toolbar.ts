/**
 * Tomcat Control Toolbar - VS Code status bar integration
 * Provides clickable buttons and visual feedback for Tomcat operations
 */

import * as vscode from 'vscode';
import { Tomcat } from './Tomcat';
import { Logger } from './Logger';

export class Toolbar {
    private static instance: Toolbar;

    // Status bar items
    private startButton: vscode.StatusBarItem;
    private stopButton: vscode.StatusBarItem;
    private reloadButton: vscode.StatusBarItem;
    private deployButton: vscode.StatusBarItem;
    private cleanButton: vscode.StatusBarItem; 
    private debugButton: vscode.StatusBarItem;
    private smartDeployButton: vscode.StatusBarItem;
    
    // State tracking
    private isServerRunning: boolean | null = null;
    private isSmartDeployEnabled: boolean = false;
    private updateInterval: NodeJS.Timeout | null = null;

    /** Private constructor - create status bar items */
    private constructor() {
        // Create status bar items with proper positioning
        // We use negative priority values to position them on the right side
        // Higher absolute values (more negative) position items further right
        
        this.startButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.startButton.text = "$(play) Start";
        this.startButton.tooltip = "Start Tomcat Server";
        this.startButton.command = 'turbocat.start';
        
        this.stopButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
        this.stopButton.text = "$(debug-stop) Stop";
        this.stopButton.tooltip = "Stop Tomcat Server";
        this.stopButton.command = 'turbocat.stop';
        
        this.reloadButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
        this.reloadButton.text = "$(refresh) Reload";
        this.reloadButton.tooltip = "Reload Application";
        this.reloadButton.command = 'turbocat.reload';
        
        this.deployButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
        this.deployButton.text = "$(cloud-upload) Deploy";
        this.deployButton.tooltip = "Deploy Application";
        this.deployButton.command = 'turbocat.deploy';
        
        this.cleanButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 96);
        this.cleanButton.text = "$(trash) Clean";
        this.cleanButton.tooltip = "Clean Tomcat";
        this.cleanButton.command = 'turbocat.clean';
        
        this.debugButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
        this.debugButton.text = "$(bug) Debug";
        this.debugButton.tooltip = "Start Tomcat in Debug Mode";
        this.debugButton.command = 'turbocat.startDebug';
        
        this.smartDeployButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 94);
        this.updateSmartDeployButton();
        this.smartDeployButton.command = 'turbocat.toggleSmartDeploy';
    }

    /**
     * Singleton accessor method
     */
    public static getInstance(): Toolbar {
        if (!Toolbar.instance) {
            Toolbar.instance = new Toolbar();
        }
        return Toolbar.instance;
    }

    /**
     * Initialize the toolbar
     * Shows buttons and starts status polling
     */
    public init(): void {
        // Show default button state (server assumed stopped until ping)
        this.startButton.show();
        this.debugButton.show();
        this.deployButton.show();
        this.cleanButton.show();
        this.smartDeployButton.show();
        this.stopButton.hide();
        this.reloadButton.hide();
        
        // Start polling for server status
        this.updateServerStatus();
        this.updateInterval = setInterval(() => this.updateServerStatus(), 3000);
        
        Logger.getInstance().info("Tomcat toolbar initialized");
    }    /**
     * Dispose of toolbar resources
     */
    public dispose(): void {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
        
        this.startButton.dispose();
        this.stopButton.dispose();
        this.reloadButton.dispose();
        this.deployButton.dispose();
        this.cleanButton.dispose();
        this.debugButton.dispose();
        this.smartDeployButton.dispose();
    }    /**
     * Update Smart Deploy button based on current configuration
     */
    private updateSmartDeployButton(): void {
        const smartDeploy = vscode.workspace.getConfiguration().get<string>('turbocat.smartDeploy', 'Disable');
        this.isSmartDeployEnabled = smartDeploy === 'Smart';
        
        if (this.isSmartDeployEnabled) {
            this.smartDeployButton.text = "$(zap) ON";
            this.smartDeployButton.tooltip = "Smart Deploy is enabled - click to disable automatic deployments";
            this.smartDeployButton.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
            this.smartDeployButton.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
        } else {
            this.smartDeployButton.text = "$(zap) OFF";
            this.smartDeployButton.tooltip = "Smart Deploy is disabled - click to enable automatic deployments";
            this.smartDeployButton.backgroundColor = undefined;
            this.smartDeployButton.color = new vscode.ThemeColor('statusBarItem.inactiveForeground');
        }

        this.smartDeployButton.show();
    }
    
    /**
     * Update button visibility and icons based on current server status
     */
    private async updateServerStatus(): Promise<void> {
        try {
            const tomcat = Tomcat.getInstance();
            const isRunning = await tomcat.isRunning();
            
            // Update smart deploy button state
            this.updateSmartDeployButton();
            
            // Only update UI if state has changed
            if (isRunning !== this.isServerRunning) {
                this.isServerRunning = isRunning;
                
                if (isRunning) {
                    // Server is running - show stop & reload, hide start/debug/deploy
                    this.startButton.hide();
                    this.debugButton.hide();
                    this.deployButton.hide();
                    this.stopButton.show();
                    this.reloadButton.show();
                    
                    // Change background color to indicate running state
                    this.stopButton.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                    this.reloadButton.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
                    this.startButton.backgroundColor = undefined;
                    this.debugButton.backgroundColor = undefined;
                    this.deployButton.backgroundColor = undefined;
                } else {
                    // Server is stopped - show start/debug/deploy, hide stop/reload
                    this.startButton.show();
                    this.debugButton.show();
                    this.deployButton.show();
                    this.stopButton.hide();
                    this.reloadButton.hide();
                    
                    // Change background color to indicate ready state
                    this.startButton.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
                    this.debugButton.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
                    this.deployButton.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
                    this.stopButton.backgroundColor = undefined;
                    this.reloadButton.backgroundColor = undefined;
                }
            }
        } catch (err) {
            Logger.getInstance().error('Error updating toolbar status:', false, String(err));
        }
    }    /**
     * Update the toolbar when configuration changes
     */
    public updateConfig(): void {
        // Re-apply visibility based on current server status
        this.updateServerStatus();
        // Update smart deploy button
        this.updateSmartDeployButton();
    }
}
