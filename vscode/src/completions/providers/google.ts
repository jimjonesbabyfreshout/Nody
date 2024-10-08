import {
    type AutocompleteContextSnippet,
    type CodeCompletionsParams,
    type Message,
    PromptString,
    ps,
} from '@sourcegraph/cody-shared'

import { type PrefixComponents, fixBadCompletionStart, getHeadAndTail } from '../text-processing'
import { forkSignal, generatorWithTimeout, messagesToText, zipGenerators } from '../utils'

import {
    type FetchCompletionResult,
    fetchAndProcessDynamicMultilineCompletions,
} from './shared/fetch-and-process-completions'
import {
    type CompletionProviderTracer,
    type GenerateCompletionsOptions,
    Provider,
    type ProviderFactoryParams,
} from './shared/provider'

const MARKERS = {
    Prefix: ps`<|prefix|>`,
    Suffix: ps`<|suffix|>`,
    Response: ps`<|fim|>`,
}

class GoogleGeminiProvider extends Provider {
    public stopSequences = [`${MARKERS.Response}`]

    public emptyPromptLength(options: GenerateCompletionsOptions): number {
        const { messages } = this.createPrompt(options, [])
        const promptNoSnippets = messagesToText(messages)
        return promptNoSnippets.length - 10
    }

    protected createPrompt(
        options: GenerateCompletionsOptions,
        snippets: AutocompleteContextSnippet[]
    ): {
        messages: Message[]
        prefix: PrefixComponents
    } {
        const { prefix, suffix } = PromptString.fromAutocompleteDocumentContext(
            options.docContext,
            options.document.uri
        )

        const { head, tail, overlap } = getHeadAndTail(prefix)

        const relativeFilePath = PromptString.fromDisplayPath(options.document.uri)

        let groupedSnippets = ps``

        for (const snippet of snippets) {
            const { uri } = snippet
            const { content, symbol } = PromptString.fromAutocompleteContextSnippet(snippet)
            const contextPrompt = this.createContext(
                symbol ? ps`symbol` : ps`file`,
                symbol ? symbol : PromptString.fromDisplayPath(uri),
                content
            )

            if (
                contextPrompt.length + 1 > this.promptChars - this.emptyPromptLength(options) ||
                !contextPrompt.length
            ) {
                break
            }

            groupedSnippets = groupedSnippets.concat(contextPrompt)
        }

        if (groupedSnippets.length) {
            groupedSnippets = ps`Context:\n${groupedSnippets}\n`
        }

        // See official docs on prompting for Gemini models:
        // https://ai.google.dev/gemini-api/docs/prompting-intro
        const fimPrompt = ps`${MARKERS.Prefix}${prefix}${MARKERS.Response}${suffix}${MARKERS.Suffix}`

        const humanText = ps`You are a code completion AI, designed to autofill code enclosed in special markers based on its surrounding context.
${groupedSnippets}

Code from ${relativeFilePath} file:
${fimPrompt}

Your mission is to generate completed code that I can replace the ${MARKERS.Response} markers with, ensuring a seamless and syntactically correct result.

Do not repeat code from before and after ${MARKERS.Response} in your output.
Maintain consistency with the indentation, spacing, and coding style used in the code.
Leave the output markers empty if no code is required to bridge the gap.
Your response should contains only the code required to connect the gap, and the code must be enclosed between ${MARKERS.Response} WITHOUT backticks`

        const messages: Message[] = [
            { speaker: 'human', text: humanText },
            { speaker: 'assistant', text: ps`${MARKERS.Response}` },
        ]

        return { messages, prefix: { head, tail, overlap } }
    }

    public getRequestParams(options: GenerateCompletionsOptions): CodeCompletionsParams {
        const { snippets } = options
        const { messages } = this.createPrompt(options, snippets)

        return {
            ...this.defaultRequestParams,
            messages,
            topP: 0.95,
            temperature: 0,
            model: this.legacyModel,
        }
    }

    public async generateCompletions(
        generateOptions: GenerateCompletionsOptions,
        abortSignal: AbortSignal,
        tracer?: CompletionProviderTracer
    ): Promise<AsyncGenerator<FetchCompletionResult[]>> {
        const { numberOfCompletionsToGenerate } = generateOptions

        const requestParams = this.getRequestParams(generateOptions)
        tracer?.params(requestParams)

        const completionsGenerators = Array.from({ length: numberOfCompletionsToGenerate }).map(
            async () => {
                const abortController = forkSignal(abortSignal)

                const completionResponseGenerator = generatorWithTimeout(
                    await this.client.complete(requestParams, abortController),
                    requestParams.timeoutMs,
                    abortController
                )

                return fetchAndProcessDynamicMultilineCompletions({
                    completionResponseGenerator,
                    abortController,
                    generateOptions,
                    providerSpecificPostProcess: this.postProcess,
                })
            }
        )

        return zipGenerators(await Promise.all(completionsGenerators))
    }

    private postProcess = (rawResponse: string): string => {
        let completion = rawResponse

        // Because the response should be enclosed with RESPONSE_CODE for consistency.
        completion = completion.replaceAll(`${MARKERS.Response}`, '').replaceAll(`${MARKERS.Suffix}`, '')

        // Remove bad symbols from the start of the completion string.
        completion = fixBadCompletionStart(completion)

        return completion
    }

    private createContext(type: PromptString, name: PromptString, content: PromptString) {
        return ps`\n-TYPE: ${type}\n-NAME: ${name}\n-CONTENT: ${content.trimEnd()}\n---\n`
    }
}

const SUPPORTED_GEMINI_MODELS = ['gemini-1.5-flash', 'gemini-pro', 'gemini-1.0-pro'] as const

export function createProvider({ legacyModel, source }: ProviderFactoryParams): Provider {
    const clientModel = legacyModel ?? 'google/gemini-1.5-flash'

    if (!SUPPORTED_GEMINI_MODELS.some(m => clientModel.includes(m))) {
        throw new Error(`Model ${legacyModel} is not supported by GeminiProvider`)
    }

    return new GoogleGeminiProvider({
        id: 'google',
        legacyModel: clientModel,
        source,
    })
}
