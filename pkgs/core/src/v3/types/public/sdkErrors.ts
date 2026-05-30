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

export class CDPConnectionClosedError extends HandstageError {
	constructor(reason: string) {
		super(`CDP connection closed: ${reason}`)
	}
}

/**
 * Raised when a caller tries to wrap a `CDPTransport` (via
 * `new CDPConnection(transport)` / `connectTransport`) or an
 * `ExternalCDPSession` (via `connectSession`) that is already owned by
 * another `CDPConnection` / `ExternalConnectionAdapter`.
 *
 * Silently double-wrapping would clobber `transport.onmessage` / `.onclose` /
 * `.onerror` and stall the first owner.  If you actually want two `V3`
 * instances sharing one CDP connection, construct the connection once and
 * use `connectConnection(existingConnection)` for both instances.
 */
export class HandstageTransportAlreadyOwnedError extends HandstageError {
	constructor(kind: "transport" | "session") {
		super(
			kind === "transport"
				? "CDPTransport already owned by another CDPConnection. " +
						"Construct the CDPConnection once and share it via connectConnection() " +
						"instead of wrapping the same transport twice."
				: "ExternalCDPSession already owned by another ExternalConnectionAdapter. " +
						"Construct the adapter once and share the resulting CDPConnectionLike via " +
						"connectConnection() instead of calling connectSession twice with the same session.",
		)
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
