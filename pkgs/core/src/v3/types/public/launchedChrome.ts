export interface LaunchedChrome {
	/**
	 * Reads from Chrome's CDP pipe (fd 4).
	 */
	stdout: ReadableStream<Uint8Array>
	/**
	 * Writes to Chrome's CDP pipe (fd 3).
	 */
	stdin: WritableStream<Uint8Array>
	/**
	 * Closes the browser process.
	 */
	close: () => Promise<void>
	/**
	 * Optional process identifier used by Handstage to register a crash-supervisor.
	 * If provided, Handstage will attempt to clean up this process if the main node process exits unexpectedly.
	 */
	pid?: number
	/**
	 * Optional path to the user data directory that was created for this process.
	 */
	userDataDir?: string
	/**
	 * Optional flag indicating whether the user data directory was created as a temporary profile.
	 */
	createdTempProfile?: boolean
}
