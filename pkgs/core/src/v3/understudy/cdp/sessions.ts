import type { ExternalConnectionAdapter } from "./externalConnection"
import type { CDPConnection } from "./nativeConnection"
import type {
	CDPAnyEventParams,
	CDPCommand,
	CDPCommandParams,
	CDPCommandResult,
	CDPEvent,
	CDPEventParams,
	CDPQueuedCommand,
	CDPSessionLike,
} from "./protocol"

export class ExternalSessionAdapter implements CDPSessionLike {
	private static unsupportedChildSessionError(): Error {
		return new Error(
			"ExternalCDPSession does not support child target CDP sessions. Use connectTransport/connectWS for flattened session routing.",
		)
	}

	constructor(
		private adapter: ExternalConnectionAdapter,
		public readonly id: string,
	) {}

	send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		const error = ExternalSessionAdapter.unsupportedChildSessionError()
		this.adapter._rejectSessionDispatch(this.id, method, error, ...params)
		return Promise.reject(error)
	}

	sendQueued<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): CDPQueuedCommand<CDPCommandResult<M>> {
		const error = ExternalSessionAdapter.unsupportedChildSessionError()
		this.adapter._rejectSessionDispatch(this.id, method, error, ...params)
		return {
			dispatched: Promise.reject(error),
			response: Promise.reject(error),
		}
	}

	sendQueuedWithSignal<M extends CDPCommand>(
		method: M,
		_signal: AbortSignal,
		...params: CDPCommandParams<M>
	): CDPQueuedCommand<CDPCommandResult<M>> {
		return this.sendQueued(method, ...params)
	}

	on<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		void event
		void handler
		throw ExternalSessionAdapter.unsupportedChildSessionError()
	}

	off<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		void event
		void handler
		throw ExternalSessionAdapter.unsupportedChildSessionError()
	}

	async close(): Promise<void> {
		await this.adapter.send("Target.detachFromTarget", { sessionId: this.id })
	}
}

export class CDPSession implements CDPSessionLike {
	constructor(
		private readonly root: CDPConnection,
		public readonly id: string,
	) {}

	send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		return this.root._sendViaSession(this.id, method, ...params)
	}

	sendWithSignal<M extends CDPCommand>(
		method: M,
		signal: AbortSignal,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		return this.root._sendViaSessionWithSignal(
			this.id,
			method,
			signal,
			...params,
		)
	}

	sendWithSignalAndLateResult<M extends CDPCommand>(
		method: M,
		signal: AbortSignal,
		onLateResult: (result: CDPCommandResult<M>) => void | Promise<void>,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		return this.root._sendViaSessionWithSignalAndLateResult(
			this.id,
			method,
			signal,
			onLateResult,
			...params,
		)
	}

	sendQueued<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): CDPQueuedCommand<CDPCommandResult<M>> {
		return this.root._sendViaSessionQueued(this.id, method, ...params)
	}

	sendQueuedWithSignal<M extends CDPCommand>(
		method: M,
		signal: AbortSignal,
		...params: CDPCommandParams<M>
	): CDPQueuedCommand<CDPCommandResult<M>> {
		return this.root._sendViaSessionQueuedWithSignal(
			this.id,
			method,
			signal,
			...params,
		)
	}

	on<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		this.root._onSessionEvent(this.id, event, handler)
	}

	off<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		this.root._offSessionEvent(this.id, event, handler)
	}

	async close(): Promise<void> {
		await this.root.send("Target.detachFromTarget", {
			sessionId: this.id,
		})
	}

	dispatch(event: CDPEvent, params: CDPAnyEventParams): void {
		this.root._dispatchToSession(this.id, event, params)
	}
}
