import * as vscode from 'vscode';
import KarateTestsProvider from '@/views/tests/KarateTestsProvider';
import ProviderDebugAdapter from '@/debug/ProviderDebugAdapter';
import StatusBarProvider from '@/views/status-bar/StatusBarProvider';
import CodeLensProvider from '@/codelens/CodeLensProvider';
import DefinitionProvider from '@/codelens/DefinitionProvider';
import KarateNetworkLogsTreeProvider from '@/views/logs/KarateNetworkLogsTreeProvider';
import EventLogsServer from '@/server/EventLogsServer';
import HoverRunDebugProvider from '@/codelens/HoverRunDebugProvider';
//import ProviderFoldingRange from "./providerFoldingRange";
import {
    runKarateTest,
    debugKarateTest,
    runAllKarateTests,
    debugAllKarateTests,
    relaunchDebugAll,
    relaunchRunAll,
    relaunchDebug,
    relaunchRun,
    startMockServer,
    relaunchLastExecution,
} from '@/commands/RunDebug';
import { openFileInEditor } from '@/commands/DisplayCommands';
import { smartPaste } from '@/commands/SmartPaste';

import { karateExecutionsTreeProvider as executionsTreeProvider } from '@/views/executions/KarateExecutionsTreeProvider';
import { generateKarateTestFromOpenAPI, generateKarateMocksFromOpenAPI } from '@/generators/openapi/OpenAPIGenerator';
import { LocalStorageService } from '@/commands/LocalStorageService';
import { CompletionItemProvider } from './codelens/CompletionProvider';
import { NetworkLog, NetworkRequestResponseLog } from './server/KarateEventLogsModels';
import { KarateExecutionProcess } from './debug/KarateExecutionProcess';
import { configureClasspath } from './commands/ConfigureClasspath';

let karateTestsWatcher = null;

export function activate(context: vscode.ExtensionContext) {
    const extensionId = 'KarateIDE.karate-ide';
    const version = vscode.extensions.getExtension(extensionId).packageJSON.version;
    const [mayor, minor, patch] = version.split('.');
    if (mayor > 0 && new Date() > new Date('2021-10-11')) {
        vscode.window
            .showErrorMessage(
                `${extensionId}: Due to an error in version numbers this version number v${version} is no longer supported and it will not receive updates.
                Please use extension page to manually uninstall this version and then search and reinstall version 0.9.x/1.0.x from Marketplace`,
                'Open Extension Page'
            )
            .then(result => {
                if (result === 'Open Extension Page') {
                    vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(`vscode:extension/${extensionId}`));
                }
            });
    }

    let karateTestsProvider = new KarateTestsProvider();
    let debugAdapterProvider = new ProviderDebugAdapter();
    let statusBarProvider = new StatusBarProvider(context);
    let codeLensProvider = new CodeLensProvider();
    //let foldingRangeProvider = new ProviderFoldingRange();

    let karateFile = { language: 'karate', scheme: 'file' };

    function registerCommand(command: string, callback: (...args: any[]) => any, thisArg?: any) {
        context.subscriptions.push(vscode.commands.registerCommand(command, callback));
    }

    LocalStorageService.initialize(context.workspaceState);

    registerCommand('karateIDE.paste', smartPaste);
    registerCommand('karateIDE.tests.debug', debugKarateTest);
    registerCommand('karateIDE.tests.run', runKarateTest);
    registerCommand('karateIDE.tests.runAll', runAllKarateTests);
    registerCommand('karateIDE.tests.debugAll', debugAllKarateTests);
    registerCommand('karateIDE.tests.refreshTree', async () => await karateTestsProvider.refresh());
    registerCommand('karateIDE.tests.switchKarateEnv', () => karateTestsProvider.switchKarateEnv());
    registerCommand('karateIDE.tests.configureFocus', () => karateTestsProvider.configureTestsFocus());
    registerCommand('karateIDE.tests.open', openFileInEditor);
    registerCommand('karateIDE.generators.openapi.test', generateKarateTestFromOpenAPI);
    registerCommand('karateIDE.generators.openapi.mocks', generateKarateMocksFromOpenAPI);
    registerCommand('karateIDE.mocks.start', startMockServer);
    registerCommand('karateIDE.configureClasspath', configureClasspath);
    registerCommand('karateIDE.karateNetworkLogs.copyAsPayload', (item: vscode.TreeItem | any) => {
        if (item.value) {
            vscode.env.clipboard.writeText(JSON.stringify(item.value, null, 2));
        } else if (item.label) {
            vscode.env.clipboard.writeText(item.label.toString());
        }
    });
    registerCommand('karateIDE.karateNetworkLogs.copyAsCURL', (item: NetworkLog | NetworkRequestResponseLog) => {
        const httplog: NetworkRequestResponseLog = item instanceof NetworkLog ? item.parent : item;
        const request = httplog.request;
        const headers = request.headers.headers.map(h => `-H "${h.key}: ${h.value}"`);
        const payload = request.payload.payload ? `-d '${request.payload.payload}'` : '';
        const template = `curl --request ${httplog.method} ${headers.join(' ')} '${httplog.url}' ${payload}`;
        vscode.env.clipboard.writeText(template);
        vscode.window.showInformationMessage('Copied to clipboard');
    });
    registerCommand('karateIDE.karateNetworkLogs.copyAsKarateMock', item => {
        vscode.window.showWarningMessage('This feature is coming soon.');
    });

    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('karate-ide', debugAdapterProvider));
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('karate-ide', debugAdapterProvider));
    context.subscriptions.push(vscode.languages.registerCodeLensProvider(karateFile, codeLensProvider));
    context.subscriptions.push(vscode.languages.registerHoverProvider(karateFile, new HoverRunDebugProvider(context)));
    context.subscriptions.push(vscode.languages.registerDefinitionProvider(karateFile, new DefinitionProvider()));
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider(karateFile, new CompletionItemProvider(), ...["'", '"']));
    //let registerFoldingRangeProvider = vscode.languages.registerFoldingRangeProvider(foldingRangeTarget, foldingRangeProvider);

    context.subscriptions.push(vscode.window.createTreeView('karate-ide-tests', { showCollapseAll: true, treeDataProvider: karateTestsProvider }));

    // NetworkLogs View
    const networkLogsProvider = new KarateNetworkLogsTreeProvider();
    registerCommand('karateIDE.karateNetworkLogs.clearTree', () => networkLogsProvider.clear());
    registerCommand('karateIDE.karateNetworkLogs.showScenarios.true', () => networkLogsProvider.setShowScenarios(true));
    registerCommand('karateIDE.karateNetworkLogs.showScenarios.false', () => networkLogsProvider.setShowScenarios(false));
    context.subscriptions.push(vscode.window.createTreeView('karate-network-logs', { showCollapseAll: true, treeDataProvider: networkLogsProvider }));
    // Executions View
    registerCommand('karateIDE.karateExecutionsTree.relaunchDebugAll', relaunchDebugAll);
    registerCommand('karateIDE.karateExecutionsTree.relaunchDebug', relaunchDebug);
    registerCommand('karateIDE.karateExecutionsTree.relaunchRunAll', relaunchRunAll);
    registerCommand('karateIDE.karateExecutionsTree.relaunchRun', relaunchRun);
    registerCommand('karateIDE.karateExecutionsTree.showOutputLogs', KarateExecutionProcess.showOutputLogs);
    registerCommand('karateIDE.karateExecutionsTree.relaunchLastExecution', relaunchLastExecution);
    context.subscriptions.push(
        vscode.window.createTreeView('karate-executions', { showCollapseAll: false, treeDataProvider: executionsTreeProvider })
    );
    const eventLogsServer = new EventLogsServer(data => {
        try {
            networkLogsProvider.processLoggingEvent(data);
        } catch (e) {
            console.error('ERROR networkLogsProvider.processLoggingEvent', data, e);
        }
    });
    eventLogsServer.start();

    setupWatcher(karateTestsWatcher, String(vscode.workspace.getConfiguration('karateIDE.tests').get('globFilter')), karateTestsProvider);

    vscode.workspace.onDidChangeConfiguration(e => {
        let karateTestsGlobFilter = e.affectsConfiguration('karateIDE.tests.globFilter');
        if (karateTestsGlobFilter) {
            try {
                karateTestsWatcher.dispose();
            } catch (e) {
                // do nothing
            }

            setupWatcher(karateTestsWatcher, String(vscode.workspace.getConfiguration('karateIDE.tests').get('globFilter')), karateTestsProvider);
        }
    });
}

export function deactivate() {
    karateTestsWatcher.dispose();
}

function setupWatcher(watcher, watcherGlob, provider) {
    watcher = vscode.workspace.createFileSystemWatcher(watcherGlob);

    watcher.onDidCreate(e => {
        provider.refresh();
    });
    watcher.onDidChange(e => {
        provider.refresh();
    });
    watcher.onDidDelete(e => {
        provider.refresh();
    });

    provider.refresh();
}
