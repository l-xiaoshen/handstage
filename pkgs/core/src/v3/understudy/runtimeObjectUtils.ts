import type { Protocol } from "devtools-protocol"
import { type CDPSessionLike, sendCDPWithSignal } from "./cdp"

type EvaluationResponse = {
	result: Protocol.Runtime.RemoteObject
	exceptionDetails?: Protocol.Runtime.ExceptionDetails
}

const REMOTE_OBJECT_CLEANUP_TIMEOUT_MS = 1000

function boundedCleanupSignal(
	signal: AbortSignal | undefined,
	timeoutMessage: string,
): { signal: AbortSignal; clear: () => void } {
	const controller = new AbortController()
	const timer = setTimeout(
		() => controller.abort(new Error(timeoutMessage)),
		REMOTE_OBJECT_CLEANUP_TIMEOUT_MS,
	)
	return {
		signal: signal
			? AbortSignal.any([signal, controller.signal])
			: controller.signal,
		clear: () => clearTimeout(timer),
	}
}

/** Stop awaiting cleanup on abort without cancelling the bounded cleanup itself. */
export async function raceCleanupAgainstAbort(
	cleanup: Promise<void>,
	signal?: AbortSignal,
): Promise<void> {
	const settledCleanup = cleanup.catch(() => {})
	if (!signal) {
		await settledCleanup
		return
	}
	if (signal.aborted) {
		void settledCleanup
		return
	}

	let onAbort!: () => void
	const aborted = new Promise<void>((resolve) => {
		onAbort = resolve
		signal.addEventListener("abort", onAbort, { once: true })
		if (signal.aborted) {
			onAbort()
		}
	})
	try {
		await Promise.race([settledCleanup, aborted])
	} finally {
		signal.removeEventListener("abort", onAbort)
	}
}

export async function releaseObjectIds(
	session: CDPSessionLike,
	objectIds: Iterable<Protocol.Runtime.RemoteObjectId | undefined>,
	signal?: AbortSignal,
): Promise<void> {
	const uniqueIds = new Set<Protocol.Runtime.RemoteObjectId>()
	for (const objectId of objectIds) {
		if (objectId) {
			uniqueIds.add(objectId)
		}
	}

	if (uniqueIds.size === 0) {
		return
	}
	const cleanup = boundedCleanupSignal(
		signal,
		"Remote object cleanup timed out",
	)
	try {
		await Promise.allSettled(
			[...uniqueIds].map((objectId) =>
				sendCDPWithSignal(session, "Runtime.releaseObject", cleanup.signal, {
					objectId,
				}),
			),
		)
	} finally {
		cleanup.clear()
	}
}

export async function releaseObjectGroup(
	session: CDPSessionLike,
	objectGroup: string,
	signal?: AbortSignal,
): Promise<void> {
	const cleanup = boundedCleanupSignal(signal, "Object group cleanup timed out")
	try {
		await sendCDPWithSignal(
			session,
			"Runtime.releaseObjectGroup",
			cleanup.signal,
			{ objectGroup },
		).catch(() => {})
	} finally {
		cleanup.clear()
	}
}

export async function releaseDiscardedEvaluationHandles(
	session: CDPSessionLike,
	response: EvaluationResponse,
): Promise<void> {
	await releaseObjectIds(session, [
		response.result.objectId,
		response.exceptionDetails?.exception?.objectId,
	])
}
