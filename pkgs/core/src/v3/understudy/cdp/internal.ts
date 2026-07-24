import type {
	CDPAnyCommandParams,
	CDPAnyCommandResult,
	CDPAnyEventParams,
} from "./protocol"

type EventHandlerResult = void | PromiseLike<void>

export type EventHandler = (params: CDPAnyEventParams) => EventHandlerResult

export type SessionDispatchWaiter = {
	sessionId: string
	method: string
	params?: CDPAnyCommandParams
	resolve: () => void
	reject: (error: Error) => void
	cleanup?: () => void
}

export type PendingTargetAttach = {
	targetId: string
	detachedSessionIds: Set<string>
	targetDestroyed: boolean
}

export type LateResponseHandler = {
	handle?: (result: CDPAnyCommandResult) => void | Promise<void>
	retained?: () => void
	settled?: () => void
	sessionId?: string | null
}

export type LateResultCallbacks<T> = {
	handle: (result: T) => void | Promise<void>
	retained?: () => void
	settled?: () => void
}

function ignoreEventHandlerError(): void {}

export function invokeEventHandler(
	handler: EventHandler,
	params: CDPAnyEventParams,
): void {
	try {
		const result = handler(params)
		if (result !== undefined) {
			void Promise.resolve(result).catch(ignoreEventHandlerError)
		}
	} catch {}
}
