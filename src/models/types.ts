import * as vscode from 'vscode';

export interface Job {
    name: string;
    jobId: string;
    status: string;
    nodelist: string;
    startTime?: string;  // Start time of the job
    runningTime?: string;  // Running time of the job in HH:MM:SS format
}

export class JobItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly jobId: string,
        public readonly status: string,
        public readonly nodelist: string,
        public readonly runningTime: string | undefined,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly confirmKill: boolean = false
    ) {
        super(label, collapsibleState);
        
        // Get display preferences from settings
        const config = vscode.workspace.getConfiguration('slurmVSCode');
        const showRunningTime = config.get<boolean>('showRunningTime', true);
        const showNodeInfo = config.get<boolean>('showNodeInfo', true);
        
        // Build tooltip with optional information
        let tooltipParts = [`${this.label} (${this.jobId})`, `Status: ${this.status}`];
        if (showNodeInfo && this.nodelist) {
            tooltipParts.push(`Nodes: ${this.nodelist}`);
        }
        if (showRunningTime && this.runningTime) {
            tooltipParts.push(`Running time: ${this.runningTime}`);
        }
        this.tooltip = tooltipParts.join('\n');
        
        // Add context value to enable command handling while preserving the base context
        this.contextValue = confirmKill ? 'slurmJob confirmKill' : 'slurmJob';

        // Add colored circle based on status
        switch (this.status) {
            case 'RUNNING':
                this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed')); // Green
                break;
            case 'PENDING':
                this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconSkipped')); // Gray
                break;
            case 'COMPLETING':
                this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconQueued')); // Orange
                break;
            case 'FAILED':
                this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconFailed')); // Red
                break;
            default:
                this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconSkipped')); // Gray
        }

        // Add description based on status and confirmation state
        if (confirmKill) {
            this.description = "Confirm kill?";
        } else {
            // Build description with optional information
            let descParts = [this.status];
            if (showRunningTime && this.runningTime) {
                descParts.push(`[${this.runningTime}]`);
            }
            if (showNodeInfo && this.nodelist) {
                descParts.push(`on ${this.nodelist}`);
            }
            this.description = descParts.join(' ');
        }
    }
} 