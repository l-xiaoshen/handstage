import type { $ZodFormattedError } from "zod/v4/core"
// Avoid .js extension so bundlers resolve TS source
import { HANDSTAGE_VERSION } from "../../../version"

export class HandstageError extends Error {
	public override readonly cause?: unknown

	constructor(message: string, cause?: unknown) {
		super(message)
		this.name = this.constructor.name
		if (cause !== undefined) {
			this.cause = cause
		}
	}
}

export class HandstageDefaultError extends HandstageError {
	constructor(error?: unknown) {
		if (error instanceof Error || error instanceof HandstageError) {
			super(
				`\nHey! We're sorry you ran into an error. \nHandstage version: ${HANDSTAGE_VERSION} \nIf you need help, please open a Github issue or reach out to us on Discord: https://handstage.dev/discord\n\nFull error:\n${error.message}`,
			)
		}
	}
}

export class HandstageEnvironmentError extends HandstageError {
	constructor(
		currentEnvironment: string,
		requiredEnvironment: string,
		feature: string,
	) {
		super(
			`You seem to be setting the current environment to ${currentEnvironment}.` +
				`Ensure the environment is set to ${requiredEnvironment} if you want to use ${feature}.`,
		)
	}
}

export class MissingEnvironmentVariableError extends HandstageError {
	constructor(missingEnvironmentVariable: string, feature: string) {
		super(
			`${missingEnvironmentVariable} is required to use ${feature}.` +
				`Please set ${missingEnvironmentVariable} in your environment.`,
		)
	}
}

export class UnsupportedModelError extends HandstageError {
	constructor(supportedModels: string[], feature?: string) {
		const message = feature
			? `${feature} requires a valid model.`
			: `Unsupported model.`

		const guidance =
			`\n\nPlease use the provider/model format (e.g., "openai/gpt-4o", "anthropic/claude-sonnet-4-5", "google/gemini-3-flash-preview").` +
			`\n\nFor a complete list of supported models and providers, see: https://docs.handstage.dev/v3/configuration/models#configuration-setup`

		super(`${message}${guidance}`)
	}
}

export class UnsupportedModelProviderError extends HandstageError {
	constructor(supportedProviders: string[], feature?: string) {
		super(
			feature
				? `${feature} requires one of the following model providers: ${supportedProviders}`
				: `please use one of the supported model providers: ${supportedProviders}`,
		)
	}
}

export class UnsupportedAISDKModelProviderError extends HandstageError {
	constructor(provider: string, supportedProviders: string[]) {
		super(
			`${provider} is not currently supported for aiSDK. please use one of the supported model providers: ${supportedProviders}`,
		)
	}
}

export class InvalidAISDKModelFormatError extends HandstageError {
	constructor(modelName: string) {
		super(
			`${modelName} does not follow correct format for specifying aiSDK models. Please define your model as 'provider/model-name'. For example: \`model: 'openai/gpt-4o-mini'\``,
		)
	}
}

export class CaptchaTimeoutError extends HandstageError {
	constructor() {
		super("Captcha timeout")
	}
}

export class MissingLLMConfigurationError extends HandstageError {
	constructor() {
		super(
			"No LLM API key or LLM Client configured. An LLM API key or a custom LLM Client " +
				"is required to use act, extract, or observe.",
		)
	}
}

export class HandlerNotInitializedError extends HandstageError {
	constructor(handlerType: string) {
		super(`${handlerType} handler not initialized`)
	}
}

export class HandstageInvalidArgumentError extends HandstageError {
	constructor(message: string) {
		super(`InvalidArgumentError: ${message}`)
	}
}

export class CookieValidationError extends HandstageError {
	constructor(message: string) {
		super(message)
	}
}

export class CookieSetError extends HandstageError {
	constructor(message: string) {
		super(message)
	}
}

export class HandstageElementNotFoundError extends HandstageError {
	constructor(xpaths: string[]) {
		super(`Could not find an element for the given xPath(s): ${xpaths}`)
	}
}

export class AgentScreenshotProviderError extends HandstageError {
	constructor(message: string) {
		super(`ScreenshotProviderError: ${message}`)
	}
}

export class HandstageMissingArgumentError extends HandstageError {
	constructor(message: string) {
		super(`MissingArgumentError: ${message}`)
	}
}

export class CreateChatCompletionResponseError extends HandstageError {
	constructor(message: string) {
		super(`CreateChatCompletionResponseError: ${message}`)
	}
}

export class HandstageEvalError extends HandstageError {
	constructor(message: string) {
		super(`HandstageEvalError: ${message}`)
	}
}

export class HandstageDomProcessError extends HandstageError {
	constructor(message: string) {
		super(`Error Processing Dom: ${message}`)
	}
}

export class HandstageLocatorError extends HandstageError {
	constructor(action: string, selector: string, message: string) {
		super(
			`Error ${action} Element with selector: ${selector} Reason: ${message}`,
		)
	}
}

export class HandstageClickError extends HandstageError {
	constructor(message: string, selector: string) {
		super(
			`Error Clicking Element with selector: ${selector} Reason: ${message}`,
		)
	}
}

export class LLMResponseError extends HandstageError {
	constructor(primitive: string, message: string) {
		super(`${primitive} LLM response error: ${message}`)
	}
}

export class HandstageIframeError extends HandstageError {
	constructor(frameUrl: string, message: string) {
		super(
			`Unable to resolve frameId for iframe with URL: ${frameUrl} Full error: ${message}`,
		)
	}
}

export class ContentFrameNotFoundError extends HandstageError {
	constructor(selector: string) {
		super(`Unable to obtain a content frame for selector: ${selector}`)
	}
}

export class XPathResolutionError extends HandstageError {
	constructor(xpath: string) {
		super(`XPath "${xpath}" does not resolve in the current page or frames`)
	}
}

export class ZodSchemaValidationError extends Error {
	constructor(
		public readonly received: unknown,
		public readonly issues: $ZodFormattedError<unknown>,
	) {
		super(`Zod schema validation failed

— Received —
${JSON.stringify(received, null, 2)}

— Issues —
${JSON.stringify(issues, null, 2)}`)
		this.name = "ZodSchemaValidationError"
	}
}

export class HandstageInitError extends HandstageError {
	constructor(message: string) {
		super(message)
	}
}

export class HandstageShadowRootMissingError extends HandstageError {
	constructor(detail?: string) {
		super(
			`No shadow root present on the resolved host` +
				(detail ? `: ${detail}` : ""),
		)
	}
}

export class HandstageShadowSegmentEmptyError extends HandstageError {
	constructor() {
		super(`Empty selector segment after shadow-DOM hop ("//")`)
	}
}

export class HandstageShadowSegmentNotFoundError extends HandstageError {
	constructor(segment: string, hint?: string) {
		super(
			`Shadow segment '${segment}' matched no element inside shadow root` +
				(hint ? ` ${hint}` : ""),
		)
	}
}

export class ElementNotVisibleError extends HandstageError {
	constructor(selector: string) {
		super(`Element not visible (no box model): ${selector}`)
	}
}

export class ResponseBodyError extends HandstageError {
	constructor(message: string) {
		super(`Failed to retrieve response body: ${message}`)
	}
}

export class ResponseParseError extends HandstageError {
	constructor(message: string) {
		super(`Failed to parse response: ${message}`)
	}
}

export class TimeoutError extends HandstageError {
	constructor(operation: string, timeoutMs: number) {
		super(`${operation} timed out after ${timeoutMs}ms`)
	}
}

export class PageNotFoundError extends HandstageError {
	constructor(identifier: string) {
		super(`No Page found for ${identifier}`)
	}
}

export class ConnectionTimeoutError extends HandstageError {
	constructor(message: string) {
		super(`Connection timeout: ${message}`)
	}
}

export class HandstageClosedError extends HandstageError {
	constructor() {
		super("Handstage session was closed")
	}
}

export class CDPConnectionClosedError extends HandstageError {
	constructor(reason: string) {
		super(`CDP connection closed: ${reason}`)
	}
}

export class HandstageSetExtraHTTPHeadersError extends HandstageError {
	public readonly failures: string[]

	constructor(failures: string[]) {
		super(
			`setExtraHTTPHeaders failed for ${failures.length} session(s): ${failures.join(", ")}`,
		)
		this.failures = failures
	}
}

export class HandstageSnapshotError extends HandstageError {
	constructor(cause?: unknown) {
		const suffix =
			cause instanceof Error
				? `: ${cause.message}`
				: cause
					? `: ${String(cause)}`
					: ""
		super(`error taking snapshot${suffix}`, cause)
	}
}

export class UnderstudyCommandException extends HandstageError {
	constructor(message: string, cause?: unknown) {
		super(message, cause)
		this.name = "UnderstudyCommandException"
	}
}
