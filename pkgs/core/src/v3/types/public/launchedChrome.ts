export interface LaunchedChrome {
	/**
	 * Reads from Chrome's CDP pipe (fd 3).
	 */
	stdout: ReadableStream<Uint8Array>
	/**
	 * Writes to Chrome's CDP pipe (fd 4).
	 */
	stdin: WritableStream<Uint8Array>
	/**
	 * Closes the browser process.
	 */
	close: () => Promise<void>
}
