/// <reference types="node" />
import fs from "node:fs"

/**
 * Chrome crash-supervisor.
 *
 * Honors the `LaunchedChrome.pid` contract: *"used by Handstage to register a
 * crash-supervisor … Handstage will attempt to clean up this process if the
 * main node process exits unexpectedly."*
 *
 * Without this, a host process that dies without calling `handstage.close()`
 * (SIGTERM, an uncaught exception, or any non-interactive exit) would orphan
 * the launched Chrome process and leak its temporary profile directory.
 *
 * Design notes / safety:
 * - We hook `exit` plus the termination signals only. Node runs `exit`
 *   listeners after an uncaught exception too, so we deliberately do NOT add an
 *   `uncaughtException` handler (which would suppress Node's default crash
 *   behavior and clobber user handlers).
 * - `exit` handlers must be synchronous; `process.kill` and `fs.rmSync` are.
 * - On a termination signal we clean up, remove our handlers, and re-raise the
 *   signal so the process still terminates with the correct semantics and any
 *   user-installed signal handlers still run.
 * - Handlers are installed once and removed again as soon as the registry is
 *   empty, so repeated launch/close cycles never accumulate `process`
 *   listeners.
 * - Entries are always deregistered on graceful close, so we never kill a PID
 *   that may have been recycled by the OS.
 */

export interface SupervisedBrowser {
	pid?: number
	userDataDir?: string
	createdTemp: boolean
	preserveUserDataDir?: boolean
}

const entries = new Set<SupervisedBrowser>()
let installed = false

const TERMINATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]

function hasProcess(): boolean {
	return (
		typeof process !== "undefined" &&
		typeof process.on === "function" &&
		typeof process.kill === "function"
	)
}

function cleanupEntry(entry: SupervisedBrowser): void {
	if (typeof entry.pid === "number") {
		try {
			process.kill(entry.pid, "SIGKILL")
		} catch {
			// Already gone / not permitted — best effort.
		}
	}
	if (entry.createdTemp && !entry.preserveUserDataDir && entry.userDataDir) {
		try {
			fs.rmSync(entry.userDataDir, { recursive: true, force: true })
		} catch {
			// Locked/removed already — best effort.
		}
	}
}

function cleanupAll(): void {
	for (const entry of [...entries]) {
		cleanupEntry(entry)
		entries.delete(entry)
	}
}

const onExit = (): void => {
	cleanupAll()
}

const onSignal = (signal: NodeJS.Signals): void => {
	cleanupAll()
	// Remove our handlers and re-raise so default (or user-installed) behavior
	// applies and the process exits with the right code.
	uninstall()
	try {
		process.kill(process.pid, signal)
	} catch {
		// If re-raise fails for any reason, fall back to a conventional exit.
		process.exit(1)
	}
}

function install(): void {
	if (installed || !hasProcess()) return
	installed = true
	process.on("exit", onExit)
	for (const sig of TERMINATION_SIGNALS) process.on(sig, onSignal)
}

function uninstall(): void {
	if (!installed || !hasProcess()) return
	installed = false
	process.removeListener("exit", onExit)
	for (const sig of TERMINATION_SIGNALS) process.removeListener(sig, onSignal)
}

/**
 * Register a launched browser so it is force-killed and its temp profile
 * removed if the host process exits unexpectedly. Returns a disposer that must
 * be called on graceful shutdown (it also removes the global process listeners
 * once no browsers remain registered).
 */
export function registerBrowserForCleanup(
	entry: SupervisedBrowser,
): () => void {
	entries.add(entry)
	install()
	let disposed = false
	return () => {
		if (disposed) return
		disposed = true
		entries.delete(entry)
		if (entries.size === 0) uninstall()
	}
}

/** Test-only: number of currently supervised browsers. */
export function supervisedCount(): number {
	return entries.size
}

/** Test-only: whether the global process listeners are currently installed. */
export function supervisorInstalled(): boolean {
	return installed
}
