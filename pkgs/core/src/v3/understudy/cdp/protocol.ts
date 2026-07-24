import type { Protocol } from "devtools-protocol"
import type { ProtocolMapping } from "devtools-protocol/types/protocol-mapping"
import { abortError, raceAgainstSignal } from "../abortUtils"

export type CDPCommand = Extract<keyof ProtocolMapping.Commands, string>
export type CDPEvent = Extract<keyof ProtocolMapping.Events, string>
export type CDPCommandParams<M extends CDPCommand> =
	ProtocolMapping.Commands[M]["paramsType"]
export type CDPCommandResult<M extends CDPCommand> =
	ProtocolMapping.Commands[M]["returnType"]
export type CDPEventParams<E extends CDPEvent> = ProtocolMapping.Events[E][0]
export type CDPAnyCommandParams = {
	[M in CDPCommand]: CDPCommandParams<M>[0]
}[CDPCommand]
export type CDPAnyCommandResult = {
	[M in CDPCommand]: CDPCommandResult<M>
}[CDPCommand]
export type CDPAnyEventParams = {
	[E in CDPEvent]: CDPEventParams<E>
}[CDPEvent]

export type CDPQueuedCommand<T> = {
	dispatched: Promise<void>
	response: Promise<T>
}

/**
 * CDP transport & session multiplexer
 *
 * Owns the browser WebSocket and multiplexes flattened Target sessions.
 * Tracks inflight CDP calls, routes responses to the right session, and forwards events.
 *
 * This does not interpret Page/DOM/Runtime semantics — callers own that logic.
 */
export interface CDPSessionLike {
	send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>>
	sendWithSignal?<M extends CDPCommand>(
		method: M,
		signal: AbortSignal,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>>
	sendWithSignalAndLateResult?<M extends CDPCommand>(
		method: M,
		signal: AbortSignal,
		onLateResult: (result: CDPCommandResult<M>) => void | Promise<void>,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>>
	sendQueued?<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): CDPQueuedCommand<CDPCommandResult<M>>
	sendQueuedWithSignal?<M extends CDPCommand>(
		method: M,
		signal: AbortSignal,
		...params: CDPCommandParams<M>
	): CDPQueuedCommand<CDPCommandResult<M>>
	on<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void
	off<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void
	close(): Promise<void>
	readonly id: string | null
}

export interface ExternalCDPSession {
	send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>>
	on<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void
	off<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void
	onclose?: (reason: string) => void
	close?(): Promise<void>
	readonly id: string | null
}

export interface CDPConnectionLike extends CDPSessionLike {
	getSession(sessionId: string): CDPSessionLike | undefined
	enableAutoAttach(signal?: AbortSignal): Promise<void>
	attachToTarget(
		targetId: string,
		signal?: AbortSignal,
	): Promise<CDPSessionLike>
	getTargets(signal?: AbortSignal): Promise<Protocol.Target.TargetInfo[]>
	/** @internal Release a failed factory's ownership when close cannot finish. */
	abandonOwnership?(): void
	onTransportClosed(handler: (why: string) => void): void
	offTransportClosed(handler: (why: string) => void): void
	waitForSessionDispatch<M extends CDPCommand>(
		sessionId: string,
		method: M,
		...params: CDPCommandParams<M>
	): Promise<void>
	waitForSessionDispatchWithSignal?<M extends CDPCommand>(
		sessionId: string,
		method: M,
		signal: AbortSignal,
		...params: CDPCommandParams<M>
	): Promise<void>
}

export function queueCDPCommand<M extends CDPCommand>(
	connection: CDPConnectionLike,
	session: CDPSessionLike,
	method: M,
	signal: AbortSignal,
	...params: CDPCommandParams<M>
): CDPQueuedCommand<CDPCommandResult<M>> {
	const sessionId = session.id
	if (!sessionId) {
		throw new Error("Queued CDP commands require a child session id")
	}
	if (session.sendQueuedWithSignal) {
		return session.sendQueuedWithSignal(method, signal, ...params)
	}

	if (session.sendQueued) {
		const queued = session.sendQueued(method, ...params)
		return {
			dispatched: raceAgainstSignal(
				queued.dispatched,
				signal,
				"CDP dispatch wait aborted",
			),
			response: raceAgainstSignal(
				queued.response,
				signal,
				"CDP command aborted",
			),
		}
	}

	const dispatched = connection.waitForSessionDispatchWithSignal
		? connection.waitForSessionDispatchWithSignal(
				sessionId,
				method,
				signal,
				...params,
			)
		: raceAgainstSignal(
				connection.waitForSessionDispatch(sessionId, method, ...params),
				signal,
				"CDP dispatch wait aborted",
			)
	const response = sendCDPWithSignal(session, method, signal, ...params)
	return { dispatched, response }
}

export function sendCDPWithSignal<M extends CDPCommand>(
	session: CDPSessionLike,
	method: M,
	signal: AbortSignal,
	...params: CDPCommandParams<M>
): Promise<CDPCommandResult<M>> {
	if (session.sendWithSignal) {
		try {
			return session.sendWithSignal(method, signal, ...params)
		} catch (error) {
			return Promise.reject(error)
		}
	}
	if (signal.aborted) {
		return Promise.reject(abortError(signal, "CDP command aborted"))
	}
	return new Promise<CDPCommandResult<M>>((resolve, reject) => {
		let settled = false
		const cleanup = () => signal.removeEventListener("abort", onAbort)
		const rejectOnce = (error: unknown) => {
			if (settled) {
				return
			}
			settled = true
			cleanup()
			reject(error)
		}
		const onAbort = () => {
			rejectOnce(abortError(signal, "CDP command aborted"))
		}
		signal.addEventListener("abort", onAbort, { once: true })
		let command: Promise<CDPCommandResult<M>>
		try {
			command = session.send(method, ...params)
		} catch (error) {
			rejectOnce(error)
			return
		}
		command.then(
			(result) => {
				if (settled) {
					return
				}
				settled = true
				cleanup()
				resolve(result)
			},
			(error) => rejectOnce(error),
		)
	})
}

export function sendCDPWithSignalAndLateResult<M extends CDPCommand>(
	session: CDPSessionLike,
	method: M,
	signal: AbortSignal,
	onLateResult: (result: CDPCommandResult<M>) => void | Promise<void>,
	...params: CDPCommandParams<M>
): Promise<CDPCommandResult<M>> {
	if (session.sendWithSignalAndLateResult) {
		try {
			return session.sendWithSignalAndLateResult(
				method,
				signal,
				onLateResult,
				...params,
			)
		} catch (error) {
			return Promise.reject(error)
		}
	}
	if (signal.aborted) {
		return Promise.reject(abortError(signal, "CDP command aborted"))
	}
	return new Promise<CDPCommandResult<M>>((resolve, reject) => {
		let settled = false
		let aborted = false
		const cleanup = () => signal.removeEventListener("abort", onAbort)
		const onAbort = () => {
			if (settled) {
				return
			}
			settled = true
			aborted = true
			cleanup()
			reject(abortError(signal, "CDP command aborted"))
		}
		signal.addEventListener("abort", onAbort, { once: true })
		let command: Promise<CDPCommandResult<M>>
		try {
			command = session.send(method, ...params)
		} catch (error) {
			settled = true
			cleanup()
			reject(error)
			return
		}
		command.then(
			(result) => {
				if (aborted) {
					void Promise.resolve(onLateResult(result)).catch(() => {})
					return
				}
				if (settled) {
					return
				}
				settled = true
				cleanup()
				resolve(result)
			},
			(error) => {
				if (settled) {
					return
				}
				settled = true
				cleanup()
				reject(error)
			},
		)
		if (signal.aborted) {
			onAbort()
		}
	})
}
