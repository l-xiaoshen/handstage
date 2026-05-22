import type { LaunchedChrome } from "chrome-launcher"

/**
 * Lifecycle state for a V3 instance.
 *
 * - `LAUNCHED`: V3 launched Chrome locally; owns process + temp profile + WS.
 * - `ATTACHED_WS`: V3 opened a WS to an already-running Chrome via `cdpUrl`;
 *   owns the WS but not the Chrome process.
 * - `TRANSPORT`: V3 wrapped a caller-supplied `CDPTransport`; owns the
 *   transport (will call `transport.close()` on shutdown).
 * - `SESSION`: V3 wrapped a caller-supplied `ExternalCDPSession`; owns the
 *   session adapter (will call `session.close()` if available).
 * - `SHARED_CONNECTION`: V3 attached to a pre-existing `CDPConnectionLike`
 *   the caller is managing; V3 does NOT close the connection on shutdown.
 * - `UNINITIALIZED`: post-`close()` terminal state.
 */
export type InitState =
	| {
			kind: "LAUNCHED"
			chrome: LaunchedChrome
			ws: string
			userDataDir?: string
			createdTempProfile?: boolean
			preserveUserDataDir?: boolean
	  }
	| {
			kind: "ATTACHED_WS"
			ws: string
	  }
	| {
			kind: "TRANSPORT"
	  }
	| {
			kind: "SESSION"
	  }
	| {
			kind: "SHARED_CONNECTION"
	  }
	| {
			kind: "UNINITIALIZED"
	  }

export type EncodedId = `${number}-${number}`

/**
 * Represents a path through a Zod schema from the root object down to a
 * particular field. The `segments` array describes the chain of keys/indices.
 *
 * - **String** segments indicate object property names.
 * - **Number** segments indicate array indices.
 *
 * For example, `["users", 0, "homepage"]` might describe reaching
 * the `homepage` field in `schema.users[0].homepage`.
 */
export interface ZodPathSegments {
	/**
	 * The ordered list of keys/indices leading from the schema root
	 * to the targeted field.
	 */
	segments: Array<string | number>
}

export type InitScriptSource<Arg> =
	| string
	| { path?: string; content?: string }
	| ((arg: Arg) => unknown)
