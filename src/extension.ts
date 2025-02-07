import * as vscode from 'vscode';
import { SlurmJobProvider } from './providers/SlurmJobProvider';
import { JobsWebviewProvider } from './providers/JobsWebviewProvider';
import { JobItem } from './models/types';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export function activate(context: vscode.ExtensionContext) {
    const slurmJobProvider = new SlurmJobProvider();
    const jobsWebviewProvider = new JobsWebviewProvider(context.extensionUri, slurmJobProvider);

    // Register the webview provider
    const view = vscode.window.registerWebviewViewProvider('slurmJobs', jobsWebviewProvider);
    
    // Register settings command
    let openSettingsCommand = vscode.commands.registerCommand('slurm_job_manager.openSettings', () => {
        vscode.commands.executeCommand('workbench.action.openSettings', '@ext:slurm_job_manager');
    });

    context.subscriptions.push(
        view,
        openSettingsCommand
    );

    // Register select all command
    let selectAllCommand = vscode.commands.registerCommand('slurm_job_manager.selectAll', () => {
        jobsWebviewProvider.selectAll();
    });

    // Register clear selection command
    let clearSelectionCommand = vscode.commands.registerCommand('slurm_job_manager.clearSelection', () => {
        jobsWebviewProvider.clearSelection();
    });

    // Register refresh command
    let refreshCommand = vscode.commands.registerCommand('slurm_job_manager.refresh', () => {
        slurmJobProvider.refresh();
    });

    // Register a command to open the job manager
    let openManagerCommand = vscode.commands.registerCommand('slurm_job_manager.openJobManager', () => {
        vscode.window.showInformationMessage('Slurm Job Manager is now active!');
    });

    // Register command to kill a job
    let killJobCommand = vscode.commands.registerCommand('slurm_job_manager.killJob', async (job: JobItem) => {
        // Set the job to confirm state
        slurmJobProvider.setJobToConfirm(job.jobId);
    });

    // Register command to confirm kill
    let confirmKillCommand = vscode.commands.registerCommand('slurm_job_manager.confirmKill', async (job: JobItem) => {
        try {
            // Execute scancel command
            await execAsync(`scancel ${job.jobId}`);
            vscode.window.showInformationMessage(`Successfully cancelled job ${job.jobId}`);
            slurmJobProvider.clearJobToConfirm(job.jobId);
            slurmJobProvider.refresh();
        } catch (error) {
            vscode.window.showErrorMessage('Failed to kill job: ' + error);
            slurmJobProvider.clearJobToConfirm(job.jobId);
        }
    });

    // Register command to cancel kill
    let cancelKillCommand = vscode.commands.registerCommand('slurm_job_manager.cancelKill', async (job: JobItem) => {
        slurmJobProvider.clearJobToConfirm(job.jobId);
    });

    // Add all commands to subscriptions
    context.subscriptions.push(
        view,
        selectAllCommand,
        clearSelectionCommand,
        refreshCommand,
        openManagerCommand,
        killJobCommand,
        confirmKillCommand,
        cancelKillCommand,
        openSettingsCommand
    );
}