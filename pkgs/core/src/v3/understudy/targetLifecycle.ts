import {
	CDPConnectionClosedError,
	TimeoutError,
} from "../types/public/sdkErrors"
import { delayWithSignal } from "./abortUtils"
import { type CDPConnectionLike, sendCDPWithSignal } from "./cdp"
import { isMissingTargetError } from "./protocolError"

export async function closeTargetAndConfirm(
	connection: CDPConnectionLike,
	targetId: string,
	options?: { timeoutMs?: number; operation?: string },
): Promise<void> {
	const timeoutMs = options?.timeoutMs ?? 2000
	const operation = options?.operation ?? "Target.closeTarget"
	const controller = new AbortController()
	const timer =
		Number.isFinite(timeoutMs) && timeoutMs > 0
			? setTimeout(
					() => controller.abort(new TimeoutError(operation, timeoutMs)),
					timeoutMs,
				)
			: null

	const targetExists = async (): Promise<boolean> => {
		const { targetInfos } = await sendCDPWithSignal(
			connection,
			"Target.getTargets",
			controller.signal,
		)
		return targetInfos.some((target) => target.targetId === targetId)
	}

	try {
		const result = await sendCDPWithSignal(
			connection,
			"Target.closeTarget",
			controller.signal,
			{ targetId },
		)
		if (result.success === false && (await targetExists())) {
			throw new Error(`Browser refused to close target ${targetId}`)
		}

		while (await targetExists()) {
			await delayWithSignal(25, controller.signal, `${operation} aborted`)
		}
	} catch (error) {
		if (
			error instanceof CDPConnectionClosedError ||
			isMissingTargetError(error)
		) {
			return
		}
		if (!controller.signal.aborted) {
			try {
				if (!(await targetExists())) {
					return
				}
			} catch (verificationError) {
				if (
					verificationError instanceof CDPConnectionClosedError ||
					isMissingTargetError(verificationError)
				) {
					return
				}
			}
		}
		throw error
	} finally {
		if (timer) {
			clearTimeout(timer)
		}
	}
}
