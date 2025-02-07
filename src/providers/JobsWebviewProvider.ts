import * as vscode from 'vscode';
import { SlurmJobProvider } from './SlurmJobProvider';

export class JobsWebviewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private selectedJobs = new Set<string>();
    private monitoredJobs = new Set<string>();
    private highlightRegex: RegExp | null = null;
    private isConfirmingKillAll = false;
    private lastClickedJobId: string | null = null;  // Track last clicked job for shift-click
    private isPastJobsExpanded = false;  // Track if past jobs section is expanded
    private isScheduledJobsExpanded = false;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly slurmJobProvider: SlurmJobProvider
    ) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        this.updateView();

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'regexEnter':
                    try {
                        if (!data.value) {
                            this.highlightRegex = null;
                            this.updateView();
                            return;
                        }
                        const regex = new RegExp(data.value, 'i');
                        const jobs = await this.slurmJobProvider.getSlurmJobs();
                        const visibleJobs = this.getVisibleJobs(jobs);
                        const matchingJobs = visibleJobs.filter(job => regex.test(job.name));
                        const allMatching = matchingJobs.every(job => this.selectedJobs.has(job.jobId));
                        
                        if (allMatching) {
                            // If all matching jobs are already selected, deselect them
                            matchingJobs.forEach(job => this.selectedJobs.delete(job.jobId));
                        } else {
                            // Otherwise, select all matching jobs
                            matchingJobs.forEach(job => this.selectedJobs.add(job.jobId));
                        }
                        
                        // Clear highlighting
                        this.highlightRegex = null;
                        this.updateView();
                    } catch (e) {
                        // Invalid regex, ignore
                    }
                    break;
                case 'regexChange':
                    try {
                        this.highlightRegex = data.value ? new RegExp(data.value, 'i') : null;
                        this.updateView();
                    } catch (e) {
                        // Invalid regex, ignore
                    }
                    break;
                case 'toggleSelection':
                    if (data.forceSelect) {
                        this.selectedJobs.add(data.jobId);
                    } else if (this.selectedJobs.has(data.jobId)) {
                        this.selectedJobs.delete(data.jobId);
                    } else {
                        this.selectedJobs.add(data.jobId);
                    }
                    this.updateView();
                    break;
                case 'selectAll':
                    await this.selectAll(data.forceSelect);
                    break;
                case 'clearSelection':
                    this.clearSelection();
                    break;
                case 'killSelected':
                    const selectedJobIds = Array.from(this.selectedJobs);
                    if (selectedJobIds.length === 0) {
                        vscode.window.showWarningMessage('No jobs selected');
                        return;
                    }
                    this.isConfirmingKillAll = true;
                    this.updateView();
                    break;
                case 'confirmKillAll':
                    const jobsToKill = Array.from(this.selectedJobs);
                    if (jobsToKill.length === 0) {
                        vscode.window.showWarningMessage('No jobs selected');
                        return;
                    }
                    vscode.window.showInformationMessage(`[DEV] Would kill jobs ${jobsToKill.join(' ')}`);
                    // const terminal = vscode.window.createTerminal('Kill Jobs');
                    // terminal.sendText(`scancel ${jobsToKill.join(' ')}`);
                    // terminal.hide();
                    this.selectedJobs.clear();
                    this.isConfirmingKillAll = false;
                    this.updateView();
                    break;
                case 'cancelKillAll':
                    this.isConfirmingKillAll = false;
                    this.updateView();
                    break;
                case 'monitorSelected':
                    const selectedJobsForMonitoring = Array.from(this.selectedJobs);
                    if (selectedJobsForMonitoring.length === 0) {
                        vscode.window.showWarningMessage('No jobs selected');
                        return;
                    }
                    const allMonitored = selectedJobsForMonitoring.every(jobId => this.monitoredJobs.has(jobId));
                    if (allMonitored) {
                        // If all selected jobs are monitored, unmonitor them
                        selectedJobsForMonitoring.forEach(jobId => this.monitoredJobs.delete(jobId));
                        vscode.window.showInformationMessage(`Stopped monitoring ${selectedJobsForMonitoring.length} selected jobs`);
                    } else {
                        // Otherwise, monitor all selected jobs
                        selectedJobsForMonitoring.forEach(jobId => this.monitoredJobs.add(jobId));
                        vscode.window.showInformationMessage(`Started monitoring ${selectedJobsForMonitoring.length} selected jobs`);
                    }
                    this.updateView();
                    break;
                case 'action':
                    await this.handleAction(data.action, data.jobId);
                    break;
                case 'togglePastJobs':
                    this.isPastJobsExpanded = !this.isPastJobsExpanded;
                    this.updateView();
                    break;
                case 'toggleScheduledJobs':
                    this.isScheduledJobsExpanded = !this.isScheduledJobsExpanded;
                    this.updateView();
                    break;
                case 'openSettings':
                    await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:slurm-job-manager');
                    break;
            }
        });
    }

    private async handleAction(action: string, jobId: string) {
        const jobs = await this.slurmJobProvider.getSlurmJobs();
        const job = jobs.find(j => j.jobId === jobId);
        if (!job) return;

        switch (action) {
            case 'attach':
                if (job.status !== 'RUNNING') {
                    vscode.window.showWarningMessage('Can only attach to running jobs');
                    return;
                }
                const attachTerminal = vscode.window.createTerminal(`Job ${job.jobId} Output`);
                attachTerminal.sendText(`sattach ${job.jobId}.0`);
                attachTerminal.show();
                break;
            case 'ssh':
                if (!job.nodelist || job.nodelist === '(None)') {
                    vscode.window.showWarningMessage('No nodes allocated for this job yet');
                    return;
                }
                const firstNode = job.nodelist.split(',')[0];
                await vscode.commands.executeCommand(
                    'vscode.openFolder',
                    vscode.Uri.parse(`vscode-remote://ssh-remote+${firstNode}/`),
                    { forceNewWindow: true }
                );
                break;
            case 'peek':
                const details = `JobId=${job.jobId}\nName=${job.name}\nStatus=${job.status}\nNodes=${job.nodelist}`;
                const channel = vscode.window.createOutputChannel(`Job ${job.jobId}`);
                channel.appendLine(details);
                channel.show();
                break;
            case 'kill':
                this.slurmJobProvider.setJobToConfirm(job.jobId);
                this.updateView();
                break;
            case 'confirmKill':
                vscode.window.showInformationMessage(`[DEV] Would kill job ${job.jobId}`);
                this.slurmJobProvider.clearJobToConfirm(job.jobId);
                this.updateView();
                break;
            case 'cancelKill':
                this.slurmJobProvider.clearJobToConfirm(job.jobId);
                this.updateView();
                break;
            case 'monitor':
                if (this.monitoredJobs.has(jobId)) {
                    this.monitoredJobs.delete(jobId);
                    vscode.window.showInformationMessage(`Stopped monitoring job ${job.name} (${jobId})`);
                } else {
                    this.monitoredJobs.add(jobId);
                    vscode.window.showInformationMessage(`Started monitoring job ${job.name} (${jobId})`);
                }
                this.updateView();
                break;
            case 'viewOutput':
                try {
                    const outputFile = `slurm-${job.jobId}.out`;
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        vscode.window.showErrorMessage('No workspace folder found');
                        return;
                    }
                    const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, outputFile);
                    try {
                        await vscode.workspace.fs.stat(fileUri);
                        const doc = await vscode.workspace.openTextDocument(fileUri);
                        await vscode.window.showTextDocument(doc, { preview: false });
                    } catch (e) {
                        vscode.window.showErrorMessage(`Output file not found: ${outputFile}`);
                    }
                } catch (e) {
                    vscode.window.showErrorMessage('Failed to open output file');
                }
                break;
            case 'viewError':
                try {
                    const errorFile = `slurm-${job.jobId}.err`;
                    const workspaceFolders = vscode.workspace.workspaceFolders;
                    if (!workspaceFolders) {
                        vscode.window.showErrorMessage('No workspace folder found');
                        return;
                    }
                    const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, errorFile);
                    try {
                        await vscode.workspace.fs.stat(fileUri);
                        const doc = await vscode.workspace.openTextDocument(fileUri);
                        await vscode.window.showTextDocument(doc, { preview: false });
                    } catch (e) {
                        vscode.window.showErrorMessage(`Error file not found: ${errorFile}`);
                    }
                } catch (e) {
                    vscode.window.showErrorMessage('Failed to open error file');
                }
                break;
        }
    }

    public clearSelection() {
        this.selectedJobs.clear();
        this.updateView();
    }

    private getVisibleJobs(jobs: any[]): any[] {
        // Running and completing jobs are always visible
        const runningJobs = jobs.filter(job => job.status === 'RUNNING' || job.status === 'COMPLETING');
        
        // Add scheduled jobs if section is expanded
        const scheduledJobs = this.isScheduledJobsExpanded ? 
            jobs.filter(job => job.status === 'PENDING') : [];
        
        // Add past jobs if section is expanded
        const pastJobs = this.isPastJobsExpanded ? 
            jobs.filter(job => ['COMPLETED', 'FAILED'].includes(job.status)) : [];
        
        return [...runningJobs, ...scheduledJobs, ...pastJobs];
    }

    public async selectAll(forceSelect: boolean = true) {
        const jobs = await this.slurmJobProvider.getSlurmJobs();
        const visibleJobs = this.getVisibleJobs(jobs);
        
        if (forceSelect) {
            // Select all visible jobs
            visibleJobs.forEach(job => this.selectedJobs.add(job.jobId));
        } else {
            // Deselect all jobs
            this.selectedJobs.clear();
        }
        this.updateView();
    }

    private getStatusColor(status: string): string {
        switch (status) {
            case 'RUNNING':
                return '#89D185'; // Green
            case 'PENDING':
                return '#CCCCCC'; // Gray
            case 'COMPLETING':
                return '#CCA700'; // Orange
            case 'FAILED':
                return '#F14C4C'; // Red
            case 'COMPLETED':
            case 'FINISHED':
                return '#2D7F43'; // Dark Green
            default:
                return '#CCCCCC'; // Gray
        }
    }

    private async updateView() {
        if (!this._view) return;

        const codiconUri = this._view.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css'));

        const jobs = await this.slurmJobProvider.getSlurmJobs();
        
        // Sort jobs by status and then by name
        const sortedJobs = [...jobs].sort((a, b) => {
            // First sort by status priority
            const statusPriority: { [key: string]: number } = {
                'RUNNING': 0,
                'PENDING': 1,
                'COMPLETING': 2,
                'FAILED': 3
            };
            const statusDiff = (statusPriority[a.status] ?? 999) - (statusPriority[b.status] ?? 999);
            if (statusDiff !== 0) return statusDiff;
            
            // Then sort by name
            return a.name.localeCompare(b.name);
        });

        // Separate jobs into three categories
        const runningJobs = sortedJobs.filter(job => job.status === 'RUNNING' || job.status === 'COMPLETING');
        const scheduledJobs = sortedJobs.filter(job => job.status === 'PENDING');
        const historySize = vscode.workspace.getConfiguration('slurmVSCode').get('jobHistorySize', 25);
        const pastJobs = sortedJobs
            .filter(job => job.status !== 'RUNNING' && job.status !== 'PENDING' && job.status !== 'COMPLETING')
            .slice(0, historySize);

        const runningJobsHtml = this.generateJobsHtml(runningJobs);
        const scheduledJobsHtml = this.generateJobsHtml(scheduledJobs);
        const pastJobsHtml = this.generateJobsHtml(pastJobs);

        const webviewScript = `
            const vscode = acquireVsCodeApi();
            const filterInput = document.querySelector('.filter-input');
            const applyFilterBtn = document.getElementById('apply-filter');
            const selectAllBtn = document.getElementById('select-all');
            const deselectAllBtn = document.getElementById('deselect-all');
            const killSelectedBtn = document.getElementById('kill-selected');
            const confirmKillAllBtn = document.getElementById('confirm-kill-all');
            const cancelKillAllBtn = document.getElementById('cancel-kill-all');
            const monitorSelectedBtn = document.getElementById('monitor-selected');

            // Restore view state
            const previousState = vscode.getState();
            if (previousState?.filterValue) {
                filterInput.value = previousState.filterValue;
                if (previousState.selectionStart !== undefined) {
                    filterInput.selectionStart = previousState.selectionStart;
                    filterInput.selectionEnd = previousState.selectionEnd;
                    filterInput.focus();
                }
            }

            let lastClickedJobId = previousState?.lastClickedJobId || null;

            function saveState() {
                vscode.setState({ 
                    filterValue: filterInput.value,
                    selectionStart: filterInput.selectionStart,
                    selectionEnd: filterInput.selectionEnd,
                    lastClickedJobId: lastClickedJobId
                });
            }

            function applyFilter() {
                const value = filterInput.value;
                vscode.postMessage({
                    type: 'regexEnter',
                    value: value
                });
                filterInput.value = '';
                saveState();
            }

            filterInput.addEventListener('input', () => {
                saveState();
                vscode.postMessage({
                    type: 'regexChange',
                    value: filterInput.value
                });
            });

            filterInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    applyFilter();
                }
            });

            applyFilterBtn.addEventListener('click', applyFilter);

            selectAllBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'selectAll', forceSelect: true });
            });

            if (deselectAllBtn) {
                deselectAllBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'selectAll', forceSelect: false });
                });
            }

            if (monitorSelectedBtn) {
                monitorSelectedBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'monitorSelected' });
                });
            }

            if (killSelectedBtn) {
                killSelectedBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'killSelected' });
                });
            }

            if (confirmKillAllBtn) {
                confirmKillAllBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'confirmKillAll' });
                });
            }

            if (cancelKillAllBtn) {
                cancelKillAllBtn.addEventListener('click', () => {
                    vscode.postMessage({ type: 'cancelKillAll' });
                });
            }

            document.querySelectorAll('.job-checkbox').forEach(checkbox => {
                checkbox.addEventListener('click', () => {
                    vscode.postMessage({
                        type: 'toggleSelection',
                        jobId: checkbox.closest('.job').dataset.jobId
                    });
                });
            });

            document.querySelectorAll('.icon-button').forEach(button => {
                if (button.classList.contains('job-checkbox') || 
                    button.id === 'apply-filter' || 
                    button.id === 'select-all' || 
                    button.id === 'kill-selected' ||
                    button.id === 'confirm-kill-all' ||
                    button.id === 'cancel-kill-all' ||
                    button.id === 'monitor-selected') {
                    return;
                }
                button.addEventListener('click', () => {
                    vscode.postMessage({
                        type: 'action',
                        action: button.dataset.action,
                        jobId: button.dataset.jobId
                    });
                });
            });

            document.querySelectorAll('.job-name').forEach(jobName => {
                jobName.addEventListener('click', (e) => {
                    const jobId = jobName.closest('.job').dataset.jobId;
                    if (!jobId) return;

                    if (e.shiftKey && lastClickedJobId) {
                        // Get all jobs
                        const jobs = Array.from(document.querySelectorAll('.job'));
                        const lastClickedIndex = jobs.findIndex(job => job.dataset.jobId === lastClickedJobId);
                        const currentIndex = jobs.findIndex(job => job.dataset.jobId === jobId);
                        
                        if (lastClickedIndex !== -1 && currentIndex !== -1) {
                            // Determine range bounds
                            const start = Math.min(lastClickedIndex, currentIndex);
                            const end = Math.max(lastClickedIndex, currentIndex);
                            
                            // Select all jobs in range
                            for (let i = start; i <= end; i++) {
                                const rangeJobId = jobs[i].dataset.jobId;
                                if (rangeJobId) {
                                    vscode.postMessage({
                                        type: 'toggleSelection',
                                        jobId: rangeJobId,
                                        forceSelect: true
                                    });
                                }
                            }
                        }
                    } else {
                        vscode.postMessage({
                            type: 'toggleSelection',
                            jobId: jobId
                        });
                    }
                    
                    lastClickedJobId = jobId;
                    saveState();
                });
            });

            // Add section toggles
            const scheduledJobsHeader = document.getElementById('scheduled-jobs-header');
            if (scheduledJobsHeader) {
                scheduledJobsHeader.addEventListener('click', () => {
                    vscode.postMessage({
                        type: 'toggleScheduledJobs'
                    });
                });
            }

            const pastJobsHeader = document.getElementById('past-jobs-header');
            if (pastJobsHeader) {
                pastJobsHeader.addEventListener('click', () => {
                    vscode.postMessage({
                        type: 'togglePastJobs'
                    });
                });
            }
        `;

        this._view.webview.html = `
            <!DOCTYPE html>
            <html>
            <head>
                <link href="${codiconUri}" rel="stylesheet" />
                <style>
                    body {
                        padding: 0;
                        margin: 0;
                        overflow: hidden;
                    }
                    .section-header {
                        padding: 4px 10px;
                        color: var(--vscode-descriptionForeground);
                        font-size: 11px;
                        font-weight: 600;
                        text-transform: uppercase;
                        letter-spacing: 0.04em;
                    }
                    .filter-container {
                        padding: 4px 10px;
                        position: sticky;
                        top: 0;
                        background: var(--vscode-editor-background);
                        z-index: 1;
                        border-bottom: 1px solid var(--vscode-input-border);
                        display: flex;
                        gap: 4px;
                        align-items: center;
                    }
                    .filter-input {
                        flex: 1;
                        padding: 2px 6px;
                        border: 1px solid var(--vscode-input-border);
                        background: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        outline: none;
                        height: 22px;
                    }
                    .filter-input:focus {
                        border-color: var(--vscode-focusBorder);
                    }
                    .filter-actions {
                        display: flex;
                        gap: 2px;
                        align-items: center;
                    }
                    .filter-actions .icon-button:last-child {
                        margin-left: 4px;
                        opacity: 0.8;
                    }
                    .filter-actions .icon-button:last-child:hover {
                        opacity: 1;
                    }
                    .section-actions {
                        width: 100%;
                        display: flex;
                        align-items: center;
                        padding: 2px 10px;
                        height: 22px;
                        justify-content: space-between;
                        background: var(--vscode-editor-background);
                        z-index: 1;
                        border-bottom: 1px solid var(--vscode-input-border);
                    }
                    .section-actions-left {
                        display: flex;
                        align-items: left;
                        gap: 4px;
                    }
                    .section-actions-right {
                        width: 100%;
                        display: flex;
                        align-items: right;
                        gap: 2px;
                        margin-right: 20px;
                        justify-content: flex-end;
                        align-items: center;
                    }
                    .job {
                        padding: 2px 10px;
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        height: 22px;
                    }
                    .job.highlighted {
                        background: var(--vscode-editor-findMatchHighlightBackground);
                    }
                    .job-checkbox {
                        padding: 2px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    }
                    .status-dot {
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                        display: inline-block;
                        margin-left: 4px;
                        margin-right: 4px;
                    }
                    .job-name {
                        flex: 1;
                        line-height: 22px;
                        cursor: pointer;
                        user-select: none;
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }
                    .job-name:hover {
                        background: var(--vscode-list-hoverBackground);
                    }
                    .job-actions {
                        display: flex;
                        gap: 2px;
                    }
                    .icon-button {
                        background: none;
                        border: none;
                        color: var(--vscode-icon-foreground);
                        cursor: pointer;
                        padding: 2px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        height: 22px;
                        width: 22px;
                    }
                    .icon-button:hover {
                        color: var(--vscode-icon-foreground);
                        background: var(--vscode-toolbar-hoverBackground);
                    }
                    .codicon {
                        font-size: 16px;
                        line-height: 16px;
                    }
                    .button-placeholder {
                        width: 22px;
                        height: 22px;
                    }
                    .section-header {
                        padding: 4px 10px;
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        background: var(--vscode-sideBarSectionHeader-background);
                        color: var(--vscode-sideBarSectionHeader-foreground);
                        cursor: pointer;
                        user-select: none;
                    }

                    .section-header:hover {
                        background: var(--vscode-list-hoverBackground);
                    }

                    .section-header .codicon {
                        margin-right: 4px;
                    }

                    .section {
                        display: flex;
                        flex-direction: column;
                    }

                    .section-content {
                        display: none;
                        overflow-y: auto;
                    }

                    .section-content.expanded {
                        display: block;
                        max-height: 50vh;
                        overflow-y: auto;
                    }

                    .section:first-child .section-content.expanded {
                        flex: 1;
                        min-height: 100px;
                    }

                    .section:not(:first-child) .section-content.expanded {
                        flex: 0.5;
                        min-height: 50px;
                    }

                    .jobs-container {
                        display: flex;
                        flex-direction: column;
                        height: 100vh;
                        overflow: hidden;
                    }

                    .empty-state {
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 8px;
                        height: 100%;
                        color: var(--vscode-descriptionForeground);
                        font-style: italic;
                    }

                    .empty-state .codicon {
                        font-size: 16px;
                    }

                    .disabled-text {
                        opacity: 0.5;
                    }

                    .disabled-button {
                        opacity: 0.5;
                        cursor: not-allowed !important;
                    }

                    .disabled-button:hover {
                        background: none !important;
                    }

                    .node-info {
                        font-size: 11px;
                        opacity: 0.8;
                        color: var(--vscode-descriptionForeground);
                        margin-left: auto;
                        padding-right: 8px;
                    }
                </style>
            </head>
            <body>
                <div class="filter-container">
                    <input type="text" class="filter-input" placeholder="Enter regex to highlight/select jobs">
                    <div class="filter-actions">
                        <button class="icon-button codicon codicon-search" title="Apply Filter" id="apply-filter"></button>
                    </div>
                </div>
                <div class="section-actions">
                    <div class="section-actions-left">
                        <button class="icon-button codicon codicon-pass-filled" id="select-all" title="Select All"></button>
                        <button class="icon-button codicon codicon-clear-all" id="deselect-all" title="Deselect All"></button>
                    </div>
                    <div class="section-actions-right">
                        ${this.isConfirmingKillAll ? `
                            <button class="icon-button codicon codicon-check" title="Confirm Kill All Selected" id="confirm-kill-all"></button>
                            <button class="icon-button codicon codicon-close" title="Cancel Kill All" id="cancel-kill-all"></button>
                        ` : `
                            <p>Selection</p>
                            <button class="icon-button codicon codicon-bell" title="Monitor Selected Jobs" id="monitor-selected"></button>
                            <button class="icon-button codicon codicon-trash" title="Kill Selected Jobs" id="kill-selected"></button>
                        `}
                    </div>
                </div>
                <div class="jobs-container">
                    ${runningJobs.length > 0 ? `
                    <div class="section" id="running-section">
                        <div class="section-header">
                            <span class="section-title">Running Jobs (${runningJobs.length})</span>
                        </div>
                        <div class="section-content expanded" style="height: 33%">
                            ${runningJobsHtml}
                        </div>
                    </div>
                    ` : ''}

                    ${scheduledJobs.length > 0 ? `
                    <div class="section" id="scheduled-section">
                        <div class="section-header" id="scheduled-jobs-header">
                            <span class="codicon codicon-${this.isScheduledJobsExpanded ? 'chevron-down' : 'chevron-right'}"></span>
                            <span class="section-title">Scheduled Jobs (${scheduledJobs.length})</span>
                        </div>
                        <div class="section-content ${this.isScheduledJobsExpanded ? 'expanded' : ''}">
                            ${scheduledJobsHtml}
                        </div>
                    </div>
                    ` : ''}

                    ${pastJobs.length > 0 ? `
                    <div class="section" id="past-section">
                        <div class="section-header" id="past-jobs-header">
                            <span class="codicon codicon-${this.isPastJobsExpanded ? 'chevron-down' : 'chevron-right'}"></span>
                            <span class="section-title">Past Jobs (${pastJobs.length})</span>
                        </div>
                        <div class="section-content ${this.isPastJobsExpanded ? 'expanded' : ''}">
                            ${pastJobsHtml}
                        </div>
                    </div>
                    ` : ''}
                    ${runningJobs.length === 0 && scheduledJobs.length === 0 && pastJobs.length === 0 ? `
                    <div class="empty-state">
                        <span class="codicon codicon-info"></span>
                        <span>No jobs found</span>
                    </div>
                    ` : ''}
                </div>
                <script>${webviewScript}</script>
            </body>
            </html>
        `;
    }

    private generateJobsHtml(jobs: any[]): string {
        return jobs.map(job => {
            const isSelected = this.selectedJobs.has(job.jobId);
            const isHighlighted = this.highlightRegex?.test(job.name);
            const statusColor = this.getStatusColor(job.status);
            const isConfirmingKill = this.slurmJobProvider.isJobToConfirm(job.jobId);
            const isMonitored = this.monitoredJobs.has(job.jobId);
            const isActiveRunning = job.status === 'RUNNING';
            const isCompleting = job.status === 'COMPLETING';
            const isFinished = ['COMPLETED', 'FAILED', 'FINISHED'].includes(job.status);
            const nodeInfo = job.nodelist && job.nodelist !== '(None)' ? `<span class="node-info">${job.nodelist}</span>` : '';
            
            return `
                <div class="job ${isHighlighted ? 'highlighted' : ''}" data-job-id="${job.jobId}">
                    <button class="icon-button codicon codicon-${isSelected ? 'pass-filled' : 'circle-large-outline'} job-checkbox" title="${isSelected ? 'Deselect' : 'Select'} Job"></button>
                    <span class="job-name ${!isActiveRunning && !isFinished ? 'disabled-text' : ''}">${job.name}${nodeInfo}<span class="status-dot" style="background-color: ${statusColor}"></span></span>
                    
                    <div class="job-actions">
                        ${isConfirmingKill ? `
                            <button class="icon-button codicon codicon-check" title="Confirm Kill" data-action="confirmKill" data-job-id="${job.jobId}"></button>
                            <button class="icon-button codicon codicon-close" title="Cancel Kill" data-action="cancelKill" data-job-id="${job.jobId}"></button>
                        ` : `
                            ${isActiveRunning ? `
                                <button class="icon-button codicon codicon-terminal" title="Attach to Job" data-action="attach" data-job-id="${job.jobId}"></button>
                                <button class="icon-button codicon codicon-remote-explorer" title="SSH to Node" data-action="ssh" data-job-id="${job.jobId}"></button>
                                <button class="icon-button codicon codicon-file" title="View Details" data-action="peek" data-job-id="${job.jobId}"></button>
                                <button class="icon-button codicon codicon-${isMonitored ? 'bell-slash' : 'bell'}" title="${isMonitored ? 'Stop Monitoring' : 'Monitor Job'}" data-action="monitor" data-job-id="${job.jobId}" style="background-color: ${isMonitored ? 'var(--vscode-toolbar-hoverBackground)' : 'none'}; color: ${isMonitored ? 'var(--vscode-icon-foreground)' : 'var(--vscode-icon-foreground)'}; border-radius: ${isMonitored ? '4px' : '0px'};"></button>
                                <button class="icon-button codicon codicon-trash" title="Kill Job" data-action="kill" data-job-id="${job.jobId}"></button>
                            ` : `
                                ${isFinished ? `
                                    <button class="icon-button codicon codicon-output" title="View Output File" data-action="viewOutput" data-job-id="${job.jobId}"></button>
                                    <button class="icon-button codicon codicon-warning" title="View Error File" data-action="viewError" data-job-id="${job.jobId}"></button>
                                ` : ``}
                            `}
                        `}
                    </div>
                </div>
            `;
        }).join('');
    }
} 