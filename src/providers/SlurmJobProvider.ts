import * as vscode from 'vscode';
import { Job, JobItem } from '../models/types';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class SlurmJobProvider implements vscode.TreeDataProvider<JobItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<JobItem | undefined | null | void> = new vscode.EventEmitter<JobItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<JobItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private jobsToConfirm = new Set<string>();
    private filterRegex: RegExp | null = null;
    private refreshInterval: NodeJS.Timeout | null = null;
    private lastKnownJobs: Map<string, Job> = new Map();
    private notifiedJobs: Set<string> = new Set();

    constructor() {
        // Initialize auto-refresh based on settings
        this.setupAutoRefresh();

        // Watch for settings changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('slurmVSCode.autoRefresh') || 
                e.affectsConfiguration('slurmVSCode.refreshInterval')) {
                this.setupAutoRefresh();
            }
        });
    }

    private setupAutoRefresh() {
        const config = vscode.workspace.getConfiguration('slurmVSCode');
        const autoRefresh = config.get<boolean>('autoRefresh', true);
        const refreshInterval = config.get<number>('refreshInterval', 5);

        // Clear existing interval if any
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }

        // Set up new interval if auto-refresh is enabled
        if (autoRefresh) {
            this.refreshInterval = setInterval(() => {
                this.refresh();
            }, refreshInterval * 1000);
        }
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    refreshJob(jobId: string): void {
        this._onDidChangeTreeData.fire();
    }

    setJobToConfirm(jobId: string): void {
        this.jobsToConfirm.add(jobId);
        this.refreshJob(jobId);
    }

    clearJobToConfirm(jobId: string): void {
        this.jobsToConfirm.delete(jobId);
        this.refreshJob(jobId);
    }

    isJobToConfirm(jobId: string): boolean {
        return this.jobsToConfirm.has(jobId);
    }

    getJobsToConfirm(): string[] {
        return Array.from(this.jobsToConfirm);
    }

    setFilter(pattern: string | null) {
        try {
            this.filterRegex = pattern ? new RegExp(pattern, 'i') : null;
            this.refresh();
        } catch (e) {
            vscode.window.showErrorMessage('Invalid regex pattern');
        }
    }

    private parseJobTime(timeStr: string): string {
        // Convert slurm time format to HH:MM:SS
        const parts = timeStr.split(':');
        if (parts.length === 3) {
            return timeStr; // Already in HH:MM:SS format
        }
        if (parts.length === 2) {
            return `00:${timeStr}`; // MM:SS format
        }
        return '00:00:00'; // Default
    }

    private async executeSlurmCommand(command: string): Promise<string> {
        try {
            const { stdout, stderr } = await execAsync(command);
            if (stderr) {
                console.error('Slurm command error:', stderr);
            }
            return stdout.trim();
        } catch (error: any) {
            // Check if the error is due to command not found
            if (error.code === 'ENOENT' || (error.message && error.message.includes('command not found'))) {
                // Silently handle missing slurm commands
                console.log('Slurm commands not available on this system');
                return '';
            }
            // For other errors, log but don't throw
            console.error('Failed to execute slurm command:', error);
            return '';
        }
    }

    public async getSlurmJobs(): Promise<Job[]> {
        try {
            // First check if squeue is available by running a simple command
            const testOutput = await this.executeSlurmCommand('squeue --version');
            if (!testOutput) {
                // Slurm is not available, return empty list without error
                return [];
            }

            // Get current jobs using squeue
            const squeueOutput = await this.executeSlurmCommand(
                'squeue -o "%i|%j|%T|%N|%M|%V" -h'
            );

            if (!squeueOutput) {
                return [];
            }

            const currentJobs = new Map<string, Job>();
            
            // Parse squeue output
            const jobs = squeueOutput.split('\n').filter(line => line.trim()).map(line => {
                const [jobId, name, status, nodelist, runningTime, startTime] = line.split('|');
                const job: Job = {
                    jobId: jobId.trim(),
                    name: name.trim(),
                    status: status.trim(),
                    nodelist: nodelist.trim() === '(None)' ? '' : nodelist.trim(),
                    runningTime: this.parseJobTime(runningTime.trim()),
                    startTime: startTime.trim()
                };
                currentJobs.set(jobId, job);
                return job;
            });

            // Check for completed jobs only if sacct is available
            for (const [jobId, lastJob] of this.lastKnownJobs.entries()) {
                if (!currentJobs.has(jobId) && !this.notifiedJobs.has(jobId)) {
                    // Job is no longer in queue and we haven't notified about it yet
                    if (lastJob.status === 'RUNNING' || lastJob.status === 'PENDING') {
                        // Get job completion status from sacct
                        try {
                            const sacctOutput = await this.executeSlurmCommand(
                                `sacct -j ${jobId} -o State -n -P`
                            );
                            if (sacctOutput) {
                                const finalStatus = sacctOutput.split('\n')[0].trim();
                                
                                // Show notification
                                const message = `Job ${lastJob.name} (${jobId}) has ${finalStatus.toLowerCase()}`;
                                vscode.window.showInformationMessage(message);
                                
                                // Add to completed jobs list with final status
                                jobs.push({
                                    ...lastJob,
                                    status: finalStatus
                                });
                            }
                            // Mark as notified regardless of sacct availability
                            this.notifiedJobs.add(jobId);
                        } catch (error) {
                            console.error('Failed to get job completion status:', error);
                            this.notifiedJobs.add(jobId); // Mark as notified to prevent repeated attempts
                        }
                    }
                }
            }

            // Update last known jobs
            this.lastKnownJobs = currentJobs;

            return jobs;
        } catch (error) {
            console.error('Failed to get slurm jobs:', error);
            // Don't show error message to user, just return empty list
            return [];
        }
    }

    getTreeItem(element: JobItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: JobItem): Promise<JobItem[]> {
        if (element) {
            return [];
        }

        const jobs = await this.getSlurmJobs();
        
        // Filter jobs if there's a regex pattern
        const filteredJobs = this.filterRegex 
            ? jobs.filter(job => this.filterRegex!.test(job.name))
            : jobs;
        
        // Create JobItems
        const jobItems = filteredJobs.map(job => new JobItem(
            job.name,
            job.jobId,
            job.status,
            job.nodelist,
            job.runningTime,
            vscode.TreeItemCollapsibleState.None,
            this.isJobToConfirm(job.jobId)
        ));

        // Sort jobs: RUNNING first, then PENDING, COMPLETING, FAILED, and others
        const statusOrder = {
            'RUNNING': 0,
            'COMPLETING': 1,
            'PENDING': 2,
            'FAILED': 3,
            'FINISHED': 4,
            'COMPLETED': 4
        };

        return jobItems.sort((a, b) => {
            const statusA = statusOrder[a.status as keyof typeof statusOrder] ?? 999;
            const statusB = statusOrder[b.status as keyof typeof statusOrder] ?? 999;
            if (statusA !== statusB) {
                return statusA - statusB;
            }
            return a.label.localeCompare(b.label);
        });
    }
} 