import { reRenderScriptContent } from "@handstage/dom/build/reRenderScriptContent"
import { v3ScriptContent } from "@handstage/dom/build/scriptV3Content"
import type { Protocol } from "devtools-protocol"
import { defaultLogger, type LogSink } from "../logger"
import { LogLevel } from "../types/public/logs"
import {
	type CDPCommand,
	type CDPCommandParams,
	type CDPSessionLike,
	sendCDPWithSignal,
	sendCDPWithSignalAndLateResult,
} from "./cdp"
import {
	isTerminalRuntimeError,
	isTransientExecutionContextError,
} from "./protocolError"
import {
	raceCleanupAgainstAbort,
	releaseDiscardedEvaluationHandles,
	releaseObjectGroup,
	releaseObjectIds,
} from "./runtimeObjectUtils"

let piercerObjectGroupSequence = 0

function evaluationExceptionMessage(
	response: Protocol.Runtime.EvaluateResponse,
): string {
	const details = response.exceptionDetails
	if (!details) {
		return ""
	}
	return [
		details.text,
		details.exception?.description,
		details.exception?.value,
	]
		.filter((value) => value !== undefined && value !== null)
		.map(String)
		.join(" ")
}

export async function installV3PiercerIntoSession(
	session: CDPSessionLike,
	signal?: AbortSignal,
): Promise<boolean> {
	const send = <M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	) =>
		signal
			? sendCDPWithSignal(session, method, signal, ...params)
			: session.send(method, ...params)
	const pageEnabled = await send("Page.enable")
		.then(() => true)
		.catch(() => false)
	if (!pageEnabled) {
		return false
	}

	await send("Runtime.enable").catch(() => {})
	let preloadRegistered = false
	try {
		await send("Page.addScriptToEvaluateOnNewDocument", {
			source: v3ScriptContent,
			runImmediately: true,
		})
		preloadRegistered = true
	} catch (e) {
		// If the session vanished during attach (common with short-lived OOPIFs),
		// swallow and report failure so callers can early-return.
		if (signal?.aborted || isTerminalRuntimeError(e)) {
			return false
		}
		// For other errors, keep going but don't throw — the next evaluate is idempotent.
	}
	const objectGroup = `handstage-piercer-${++piercerObjectGroupSequence}`
	const sendEvaluation = (params: Protocol.Runtime.EvaluateRequest) =>
		signal
			? sendCDPWithSignalAndLateResult(
					session,
					"Runtime.evaluate",
					signal,
					() => releaseObjectGroup(session, objectGroup),
					params,
				)
			: session.send("Runtime.evaluate", params)
	let installed = false
	try {
		let installEvaluation: Protocol.Runtime.EvaluateResponse | undefined
		try {
			installEvaluation = await sendEvaluation({
				expression: v3ScriptContent,
				returnByValue: true,
				awaitPromise: true,
				objectGroup,
			})
		} catch (error) {
			installed =
				!signal?.aborted &&
				preloadRegistered &&
				isTransientExecutionContextError(error)
		}
		if (installEvaluation) {
			await releaseDiscardedEvaluationHandles(session, installEvaluation)
			if (installEvaluation.exceptionDetails) {
				const error = evaluationExceptionMessage(installEvaluation)
				installed = preloadRegistered && isTransientExecutionContextError(error)
			} else {
				installed = true

				// Re-render custom elements whose closed roots predate the hook.
				try {
					const reRenderEvaluation = await sendEvaluation({
						expression: reRenderScriptContent,
						returnByValue: true,
						awaitPromise: false,
						objectGroup,
					})
					await releaseDiscardedEvaluationHandles(session, reRenderEvaluation)
				} catch (error) {
					if (signal?.aborted || isTerminalRuntimeError(error)) {
						installed = false
					}
				}
			}
		}
	} finally {
		await raceCleanupAgainstAbort(
			releaseObjectGroup(session, objectGroup),
			signal,
		)
	}
	return preloadRegistered && installed && !signal?.aborted
}

/** (Optional) stream patch logs in your node console during bring-up */
export function tapPiercerConsole(
	session: CDPSessionLike,
	label: string,
	logger?: LogSink,
): () => void {
	const sink = logger ?? defaultLogger()
	const handler = (evt: Protocol.Runtime.ConsoleAPICalledEvent) => {
		const value = evt.args?.[0]?.value
		const head = typeof value === "string" ? value : undefined
		if (head?.startsWith?.("[v3-piercer]")) {
			try {
				sink({
					category: "piercer",
					message: `[${label}] ${head}`,
					level: LogLevel.Debug,
					attributes: {
						value: String(evt.args?.[1]?.value ?? ""),
					},
				})
			} finally {
				void releaseObjectIds(
					session,
					evt.args?.map((arg) => arg.objectId) ?? [],
				)
			}
		}
	}
	session.on("Runtime.consoleAPICalled", handler)
	return () => session.off("Runtime.consoleAPICalled", handler)
}
