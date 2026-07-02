/// <reference types="node" />
import fs from "node:fs"

/**
 * Chrome crash-supervisor. Honors the `LaunchedChrome.pid` contract: if the
 * host process dies without a graceful `handstage.close()` (SIGTERM, uncaught
 * exception, non-interactive exit), the launched browser would otherwise be
 * orphaned and its temp profile leaked.
 *
 * Safety:
 * - Hooks `exit` + termination signals only. Node runs `exit` listeners after
 *   an uncaught exception too, so we avoid an `uncaughtException` handler that
 *   would suppress default crash behavior / clobber user handlers.
 * - `exit` cleanup is synchronous (`process.kill` / `fs.rmSync`).
 * - On a signal we clean up, remove our handlers, then re-raise so the process
 *   still terminates correctly and user handlers still run.
 * - Handlers install once and are removed when the registry empties (no listener
 *   accumulation); entries are deregistered on close so we never kill a recycled
 *   PID.
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
