import * as vscode from 'vscode'

import { spawnBfg } from '../../../../graph/bfg/spawn-bfg'
import type { MessageHandler } from '../../../../jsonrpc/jsonrpc'
import { logDebug } from '../../../../log'
import type { Repository } from '../../../../repository/builtinGitExtension'
import { vscodeGitAPI } from '../../../../repository/git-extension-api'
import { captureException } from '../../../../services/sentry/sentry'
import type { ContextRetriever, ContextRetrieverOptions } from '../../../types'

import type { AutocompleteContextSnippet } from '@sourcegraph/cody-shared'
import { RetrieverIdentifier } from '../../utils'
import {
    getLastNGraphContextIdentifiersFromDocument,
    getLastNGraphContextIdentifiersFromString,
} from '../graph/identifiers'
import { type SimpleRepository, inferGitRepository } from './simple-git'

export class BfgRetriever implements ContextRetriever {
    public identifier = RetrieverIdentifier.BfgRetriever
    private loadedBFG: Promise<MessageHandler>
    private bfgIndexingPromise = Promise.resolve<void>(undefined)
    private awaitIndexing: boolean
    private didFailLoading = false
    // Keys are repository URIs, values are revisions (commit hashes).
    private indexedRepositoryRevisions = new Map<string, string>()
    constructor(private context: vscode.ExtensionContext) {
        this.awaitIndexing = vscode.workspace
            .getConfiguration()
            .get<boolean>('cody.experimental.cody-engine.await-indexing', false)
        this.loadedBFG = this.loadBFG()

        this.loadedBFG.then(
            () => {},
            error => {
                captureException(error)
                this.didFailLoading = true
                logDebug('CodyEngine', 'failed to initialize', error)
            }
        )

        this.bfgIndexingPromise = this.indexWorkspace()
    }

    private async indexWorkspace(): Promise<void> {
        await this.indexGitRepositories()
        await this.indexRemainingWorkspaceFolders()
    }
    private isWorkspaceIndexed(folder: vscode.Uri): boolean {
        const uri = folder.toString()
        logDebug('CodyEngine', 'Checking if folder is indexed', uri)
        for (const key of this.indexedRepositoryRevisions.keys()) {
            if (uri.startsWith(key)) {
                return true
            }
        }
        return false
    }

    private async indexRemainingWorkspaceFolders(): Promise<void> {
        logDebug(
            'CodyEngine',
            'workspaceFolders',
            vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()) ?? []
        )
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            if (this.isWorkspaceIndexed(folder.uri)) {
                continue
            }
            await this.indexEntry({ workspace: folder.uri })
        }
    }
    private async indexGitRepositories(): Promise<void> {
        // TODO: Only works in the VS Code extension where the Git extension is available.
        // We should implement fallbacks for the Git methods used below.
        if (!vscodeGitAPI) {
            return
        }

        // TODO: scan workspace folders for git repos to support this in the agent.
        // https://github.com/sourcegraph/cody/issues/4137
        for (const repository of vscodeGitAPI.repositories) {
            await this.didChangeGitExtensionRepository(repository)
        }
        this.context.subscriptions.push(
            // TODO: https://github.com/sourcegraph/cody/issues/4138
            vscodeGitAPI.onDidOpenRepository(repository =>
                this.didChangeGitExtensionRepository(repository)
            )
        )
        this.context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.indexInferredGitRepositories())
        )
        // TODO: handle closed repositories

        await this.indexInferredGitRepositories()
    }

    private shouldInferGitRepositories(): boolean {
        // Some users may not want to allow Cody to index code outside the VS
        // Code workspace folder so we support an escape hatch to disable this
        // functionality. This setting is hidden because all the other
        // BFG-related settings are hidden.
        return vscode.workspace
            .getConfiguration()
            .get<boolean>('cody.experimental.cody-engine.index-parent-git-folder', false)
    }

    // Infers what git repositories that are relevant but may not be "open" by
    // the git extension.  For example, by default, the git extension doesn't
    // open git repositories when the workspace root is a subfolder. There's a
    // setting to automatically open parent git repositories but the setting is
    // disabled by default.
    private async indexInferredGitRepositories(): Promise<void> {
        if (!this.shouldInferGitRepositories()) {
            return
        }
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            if (this.indexedRepositoryRevisions.has(folder.uri.toString())) {
                continue
            }
            const repo = await inferGitRepository(folder.uri)
            if (repo) {
                await this.didChangeSimpleRepository(repo)
            }
        }
    }

    private async didChangeGitExtensionRepository(repository: Repository): Promise<void> {
        const commit = repository?.state?.HEAD?.commit
        if (!commit) {
            return
        }
        await this.didChangeSimpleRepository({ uri: repository.rootUri, commit })
    }

    private async didChangeSimpleRepository(repository: SimpleRepository): Promise<void> {
        const uri = repository.uri.toString()
        if (repository.commit !== this.indexedRepositoryRevisions.get(uri)) {
            this.indexedRepositoryRevisions.set(uri, repository.commit ?? '')
            await this.indexEntry({ repository })
        }
    }

    private async indexEntry(params: {
        repository?: SimpleRepository
        workspace?: vscode.Uri
    }): Promise<void> {
        const { repository, workspace } = params
        if (!repository && !workspace) {
            return
        }
        const bfg = await this.loadedBFG
        const indexingStartTime = Date.now()
        // TODO: include commit?
        try {
            if (repository) {
                await bfg.request('bfg/gitRevision/didChange', {
                    gitDirectoryUri: repository.uri.toString(),
                })
            }
            if (workspace) {
                await bfg.request('bfg/workspace/didChange', { workspaceUri: workspace.toString() })
            }
            const elapsed = Date.now() - indexingStartTime
            const label = repository
                ? `${repository.uri.fsPath}:${repository.commit}`
                : workspace
                  ? workspace.fsPath
                  : ''
            if (label) {
                logDebug('CodyEngine', `gitRevision/didChange ${label} indexing time ${elapsed}ms`)
            }
        } catch (error) {
            logDebug('CodyEngine', `indexing error ${error}`)
        }
    }

    public async retrieve({
        document,
        position,
        docContext,
        hints,
        lastCandidate,
    }: ContextRetrieverOptions): Promise<AutocompleteContextSnippet[]> {
        try {
            if (this.didFailLoading) {
                return []
            }
            const bfg = await this.loadedBFG
            if (!bfg.isAlive()) {
                logDebug('CodyEngine', 'not alive')
                return []
            }

            if (this.awaitIndexing) {
                await this.bfgIndexingPromise
            }

            const lastCandidateCurrentLine =
                (lastCandidate?.lastTriggerDocContext.currentLinePrefix || '') +
                lastCandidate?.result.items[0].insertText

            const bfgRequestStart = performance.now()
            const inputIdentifiers = Array.from(
                new Set([
                    // Get last 10 identifiers from the last candidate insert text
                    // in hopes that LLM partially guessed the right completion.
                    ...getLastNGraphContextIdentifiersFromString({
                        n: 10,
                        uri: document.uri,
                        languageId: document.languageId,
                        source: lastCandidateCurrentLine,
                    }),
                    // Get last 10 identifiers from the current document prefix.
                    ...getLastNGraphContextIdentifiersFromDocument({
                        n: 10,
                        document,
                        position,
                    }),
                ])
            )

            const response = await bfg.request('bfg/contextForIdentifiers', {
                uri: document.uri.toString(),
                identifiers: inputIdentifiers.map(snippetRequest => snippetRequest.symbolName),
                maxSnippets: 20,
                maxDepth: 4,
            })

            // Just in case, handle non-object results
            if (typeof response !== 'object') {
                return []
            }

            // Convert BFG snippets to match the format expected on the client.
            const symbols = (response.symbols || []).map(contextSnippet => ({
                ...contextSnippet,
                identifier: RetrieverIdentifier.BfgRetriever,
                uri: vscode.Uri.from({ scheme: 'file', path: contextSnippet.fileName }),
            })) satisfies Omit<AutocompleteContextSnippet, 'startLine' | 'endLine'>[]

            logDebug('CodyEngine', 'bfg/contextForIdentifiers', {
                verbose: {
                    inputIdentifiers,
                    duration: `${performance.now() - bfgRequestStart}ms`,
                    symbols: symbols.map(s => `${s.symbol} ${s.content}`),
                },
            })

            // TODO: add `startLine` and `endLine` to `responses` or explicitly add
            // another context snippet type to the client.
            // @ts-ignore
            return symbols
        } catch (error) {
            logDebug('CodyEngine:error', `${error}`)
            return []
        }
    }

    public isSupportedForLanguageId(languageId: string): boolean {
        switch (languageId) {
            case 'typescript':
            case 'typescriptreact':
            case 'javascript':
            case 'javascriptreact':
            case 'java':
            case 'go':
            case 'dart':
            case 'python':
            case 'zig':
                return true
            default:
                return false
        }
    }

    public dispose(): void {
        if (this.didFailLoading) {
            return
        }
        this.loadedBFG.then(
            bfg => bfg.request('bfg/shutdown', null),
            () => {}
        )
    }

    // We lazily load BFG to allow the Cody extension to finish activation as
    // quickly as possible.
    private loadBFG(): Promise<MessageHandler> {
        // This is implemented as a custom promise instead of async/await so that we can reject
        // the promise in the 'exit' handler if we fail to start the bfg process for some reason.
        return new Promise<MessageHandler>((resolve, reject) => {
            logDebug('CodyEngine', 'loading bfg')
            this.doLoadBFG(reject).then(
                bfg => resolve(bfg),
                error => {
                    captureException(error)
                    reject(error)
                }
            )
        })
    }

    private async doLoadBFG(reject: (reason?: any) => void): Promise<MessageHandler> {
        const bfg = await spawnBfg(this.context, reject)
        await bfg.request('bfg/initialize', { clientName: 'vscode' })
        return bfg
    }
}
