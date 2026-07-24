import { v3ScriptContent } from "@handstage/dom/build/scriptV3Content"
import {
	type CDPCommand,
	type CDPCommandParams,
	type CDPConnectionLike,
	type CDPSessionLike,
	queueCDPCommand,
} from "./cdp"

type SetupOperation = {
	dispatched: Promise<boolean>
	response: Promise<boolean>
}

export type PausedTargetSetupResult = {
	success: boolean
	scriptsInstalled: boolean
	piercerPreRegistered: boolean
	diagnostics: {
		preResumeDispatched: boolean
		resumeDispatched: boolean
		resumeAcknowledged: boolean
	}
}

export async function preparePausedTargetSession(options: {
	connection: CDPConnectionLike
	session: CDPSessionLike
	signal: AbortSignal
	initScripts: readonly string[]
	extraHttpHeaders: Readonly<Record<string, string>> | null
}): Promise<PausedTargetSetupResult> {
	const queue = <M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): SetupOperation => {
		const queued = queueCDPCommand(
			options.connection,
			options.session,
			method,
			options.signal,
			...params,
		)
		return {
			dispatched: queued.dispatched.then(() => true).catch(() => false),
			response: queued.response.then(() => true).catch(() => false),
		}
	}

	// Commands are queued in document-start order before the paused target resumes.
	const coreOperations = [
		queue("Page.enable"),
		queue("Runtime.enable"),
		queue("Target.setAutoAttach", {
			autoAttach: true,
			waitForDebuggerOnStart: true,
			flatten: true,
		}),
	]
	const headerOperations: SetupOperation[] = []
	if (options.extraHttpHeaders) {
		const headers = { ...options.extraHttpHeaders }
		headerOperations.push(queue("Network.enable"))
		headerOperations.push(queue("Network.setExtraHTTPHeaders", { headers }))
	}
	const scriptOperations = options.initScripts.map((source) =>
		queue("Page.addScriptToEvaluateOnNewDocument", {
			source,
			runImmediately: true,
		}),
	)
	const piercerOperation = queue("Page.addScriptToEvaluateOnNewDocument", {
		source: v3ScriptContent,
		runImmediately: true,
	})

	const preResumeDispatched = (
		await Promise.all([
			...coreOperations.map((operation) => operation.dispatched),
			...headerOperations.map((operation) => operation.dispatched),
			...scriptOperations.map((operation) => operation.dispatched),
			piercerOperation.dispatched,
		])
	).every(Boolean)

	const resumeOperation = queue("Runtime.runIfWaitingForDebugger")
	const [resumeDispatched, resumeAcknowledged] = await Promise.all([
		resumeOperation.dispatched,
		resumeOperation.response,
	])
	const [coreResults, , scriptResults, piercerPreRegistered] =
		await Promise.all([
			Promise.all(coreOperations.map((operation) => operation.response)),
			Promise.all(headerOperations.map((operation) => operation.response)),
			Promise.all(scriptOperations.map((operation) => operation.response)),
			piercerOperation.response,
		])
	const coreReady = coreResults.every(Boolean)

	return {
		success:
			preResumeDispatched &&
			resumeDispatched &&
			resumeAcknowledged &&
			coreReady,
		scriptsInstalled: coreReady && scriptResults.every(Boolean),
		piercerPreRegistered,
		diagnostics: {
			preResumeDispatched,
			resumeDispatched,
			resumeAcknowledged,
		},
	}
}
