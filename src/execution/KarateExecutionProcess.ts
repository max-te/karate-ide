import * as karateTestManager from '@/execution/KarateTestsManager';
import { karateExecutionsTreeProvider as executionsTreeProvider } from '@/views/KarateExecutionsTreeProvider';
import { karateNetworkLogsTreeProvider } from '@/views/KarateNetworkLogsTreeProvider';
import { ChildProcessWithoutNullStreams, exec, spawn } from 'child_process';
import * as http from 'http';
import * as net from 'net';
import * as vscode from 'vscode';
import { karateOutputChannel } from './KarateOutputChannel';

export type Event = {
    event: string;
    locationHint: string;
    cwd: string;
    name: string;
    message: string;
    details: string;
    features: string;
    featuresFound: string;
    outline: boolean;
    dynamic: boolean;
    duration: number;
};

export type SummaryEvent = { running: boolean; passed: number; failed: number };
type TestServerProcess = { cwd?: string; env?: string; port?: number; process?: ChildProcessWithoutNullStreams };
export class KarateExecutionProcess {
    static debugProcess: TestServerProcess = {};
    static runProcess: TestServerProcess = {};
    static isExecuting = false;
    static summary: SummaryEvent = { running: false, passed: 0, failed: 0 };
    static onExecuting: vscode.EventEmitter<SummaryEvent> = new vscode.EventEmitter<SummaryEvent>();

    private static progress: vscode.Progress<{ message: string }>;
    private static reportProgress(message: { message: string }) {
        return this.progress ? this.progress.report(message) : null;
    }

    public static get onExecutingEvent(): vscode.Event<any> {
        return this.onExecuting.event;
    }

    public static stopTestProcesses() {
        this.debugProcess.process && this.debugProcess.process.kill();
        this.runProcess.process && this.runProcess.process.kill();
        this.debugProcess.process = this.debugProcess.port = this.runProcess.process = this.runProcess.port = null;
        this.isExecuting = false;
    }

    public static executeInTestServer(cwd: string, command: string) {
        command = this.useKarateTestServer(command);
        this.killProcessIfDifferentCwd(this.runProcess, cwd);
        this.executeProcess(this.runProcess, command, false, port => this.executeOnTestProcess(port, command));
    }

    public static executeInDebugServer(cwd: string, command: string, onDebugReadyCallback?: (port: number) => any) {
        command = this.useKarateTestServer(command);
        this.killProcessIfDifferentCwd(this.debugProcess, cwd);
        this.executeProcess(this.debugProcess, command, true, onDebugReadyCallback);
    }

    private static executeProcess(testServer: TestServerProcess, command: string, isDebug: boolean, onPortReadyCallback?: (port: number) => any) {
        if (this.isExecuting) {
            vscode.window.showInformationMessage('Karate is already running', 'Cancel').then(selection => {
                if (selection === 'Cancel' && this.isExecuting) {
                    testServer.process && testServer.process.kill();
                    karateOutputChannel.append('[Canceled]\n', false);
                    this.onExecuting.fire({ running: false, passed: 0, failed: 0 });
                }
            });
            return;
        }
        this.isExecuting = true;
        executionsTreeProvider.clear();
        karateNetworkLogsTreeProvider.clear(); // karateNetworkLogsTreeProvider.collapsePreviousExecutions();
        karateOutputChannel.clear();
        karateOutputChannel.appendAll(`cwd: ${testServer.cwd}\nExecuting: ${command}\n\n`, true);
        vscode.commands.executeCommand('karate-executions.focus');
        vscode.commands.executeCommand('karate-network-logs.focus');

        const location = isDebug ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification;
        const title = isDebug ? 'Karate' : '';
        vscode.window.withProgress({ location, title, cancellable: true }, async (progress, token) => {
            this.progress = progress;
            token.onCancellationRequested(() => {
                testServer.process && testServer.process.kill();
                karateTestManager.processEvent({ event: 'testSuiteFinished' } as any);
                karateOutputChannel.append('[Canceled]\n', false);
                this.onExecuting.fire({ running: false, passed: 0, failed: 0 });
            });

            // start the test process and execute callback when the port is ready
            this.startTestProcess(testServer, command, onPortReadyCallback);

            // wait for the test execution to finish
            await new Promise<void>(resolve => {
                let interval = setInterval(() => {
                    if (!this.isExecuting) {
                        clearInterval(interval);
                        resolve();
                    }
                }, 1000);
            });
        });
    }

    private static executeOnTestProcess(port: number, command: string) {
        http.get(`http://localhost:${port}/${command.split('vscode.KarateTestProcess')[1]}`, res => {
            if (res.statusCode !== 200) {
                let errorMessage = '';
                res.on('data', chunk => (errorMessage += chunk));
                res.on('end', () => {
                    vscode.window.showErrorMessage(`Karate test server returned ${res.statusCode}\n ${errorMessage}`);
                });
            }
        });
    }

    private static startTestProcess(testServerProcess: TestServerProcess, command: string, onPortReadyCallback?: (port: number) => any) {
        // console.log('startTestProcess', command);
        this.summary = { running: true, passed: 0, failed: 0 };
        this.onExecuting.fire(this.summary);
        if (testServerProcess.process && testServerProcess.port) {
            return onPortReadyCallback && onPortReadyCallback(testServerProcess.port);
        } else {
            const child = (testServerProcess.process = exec(command, { cwd: testServerProcess.cwd }));
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', data => {
                data.trim()
                    .split(/\r?\n/g)
                    .forEach(line => {
                        if ((onPortReadyCallback && line.includes('debug server started')) || line.includes('test server started')) {
                            const port = parseInt(/\d+$/.exec(line)[0]);
                            testServerProcess.port = port;
                            onPortReadyCallback(port);
                        }
                        if (line.startsWith('##vscode {')) {
                            try {
                                const event: Event = JSON.parse(line.substring(9, line.lastIndexOf('}') + 1));
                                executionsTreeProvider.processEvent({ ...event, cwd: testServerProcess.cwd });
                                karateTestManager.processEvent({ ...event, cwd: testServerProcess.cwd });

                                if (event.event === 'featureStarted') {
                                    karateOutputChannel.startFeature(event.locationHint);
                                    this.reportProgress({ message: `${event.name}` });
                                } else if (event.event === 'testStarted') {
                                    karateOutputChannel.startScenario(event.locationHint);
                                    this.reportProgress({ message: `${getFeatureName(event)} ${event.name}` });
                                } else if (event.event === 'testOutlineStarted') {
                                    karateOutputChannel.startScenarioOutline(event.locationHint);
                                    this.reportProgress({ message: `${getFeatureName(event)} / ${event.name}` });
                                } else if (event.event === 'testFinished' || event.event === 'testFailed') {
                                    karateOutputChannel.endScenario(event.locationHint);
                                    event.event === 'testFailed' ? this.summary.failed++ : this.summary.passed++;
                                    this.onExecuting.fire(this.summary);
                                } else if (event.event === 'testOutlineFinished') {
                                    karateOutputChannel.endScenarioOutline(event.locationHint);
                                } else if (event.event === 'featureFinished') {
                                    karateOutputChannel.endFeature(event.locationHint);
                                } else if (event.event === 'testSuiteFinished') {
                                    this.isExecuting = false;
                                    this.summary.running = false;
                                    this.onExecuting.fire(this.summary);
                                } else if (event.event === 'testSuiteStarted') {
                                }
                            } catch (e) {
                                console.error('KarateExecutionProcess.on.data', line, e);
                            }
                            // karateOutputChannel.appendAll(line + '\n');
                        } else {
                            if (this.isExecuting) {
                                karateOutputChannel.appendAll(line + '\n');
                            }
                        }
                    });
            });

            child.stderr.setEncoding('utf8');
            child.stderr.on('data', data => {
                karateOutputChannel.append(data);
                if (data.includes('java.lang.ClassNotFoundException: com.intuit.karate.Main')) {
                    this.isExecuting = false;
                    karateTestManager.processEvent({ event: 'testSuiteFinished' } as any);
                    testServerProcess.cwd = testServerProcess.port = testServerProcess.process = null;

                    const message = `
NOTE: If you're seeing this message your "karateIDE.karateCli.classpath" setting is probably misconfigured.
Please, refer to https://github.com/ZenWave360/karate-ide#karate-classpath
Consider installing https://marketplace.visualstudio.com/items?itemName=KarateIDE.karate-classpath-jar
And run the "KarateIDE: Configure Classpath" command for assistance (View > Command Palette or Ctrl+Shift+P).
                    `;
                    setTimeout(() => karateOutputChannel.append(message), 100);
                }
            });

            child.on('close', code => {
                this.isExecuting = false;
                karateOutputChannel.append('.\n');
                testServerProcess.cwd = testServerProcess.port = testServerProcess.process = null;
            });
        }
    }

    private static killProcessIfDifferentCwd(process: TestServerProcess, cwd: string) {
        const env: string = vscode.workspace.getConfiguration('karateIDE.karateCli').get('karateEnv');
        if (process.process && (process.cwd !== cwd || process.env !== env)) {
            process.process && process.process.kill();
            process.process = process.port = null;
        }
        process.cwd = cwd;
        process.env = env;
    }

    private static useKarateTestServer(command: string, isDebug: boolean = false) {
        const useKarateTestServer = vscode.workspace.getConfiguration('karateIDE.karateCli').get<boolean>('useKarateTestServer');
        if (isDebug && !useKarateTestServer) {
            command = command.replace('--keep-debug-server', '');
        }
        return useKarateTestServer ? command.replace('com.intuit.karate.Main', 'vscode.KarateTestProcess') : command;
    }
}

function getFeatureName(event: Event) {
    return event.locationHint.substring(event.locationHint.lastIndexOf('/') + 1, event.locationHint.lastIndexOf('.') + 1);
}
