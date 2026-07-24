import { describe, expect, jest, test } from "bun:test"
import { connectConnection } from "../src/v3/connect/connection"
import { connectLocal } from "../src/v3/connect/local"
import { createOwnedHandstage } from "../src/v3/connect/shared"
import { connectTransport } from "../src/v3/connect/transport"
import { withTimeout } from "../src/v3/timeoutConfig"
import type { LaunchedChrome } from "../src/v3/types/public/launchedChrome"
import { LogLevel } from "../src/v3/types/public/logs"
import { HandstageTransportAlreadyOwnedError } from "../src/v3/types/public/sdkErrors"
import {
	type CDPCommand,
	type CDPCommandParams,
	type CDPCommandResult,
	CDPConnection,
	type CDPEvent,
	type CDPEventParams,
	type ExternalCDPSession,
	ExternalConnectionAdapter,
} from "../src/v3/understudy/cdp"
import { ExecutionContextRegistry } from "../src/v3/understudy/executionContextRegistry"
import {
	getTargetRouter,
	type TargetRouterDelegate,
} from "../src/v3/understudy/targetRouter"
import {
	attachedEvent,
	FakeConnection,
	FakeSession,
	InMemoryTransport,
	pageTarget,
	waitFor,
} from "./_fakes"

class SplitResponsePipeChrome implements LaunchedChrome {
	public readonly sentMethods: string[] = []
	public closeCalls = 0
	public readonly stdout: ReadableStream<Uint8Array>
	public readonly stdin: WritableStream<Uint8Array>
	private readonly decoder = new TextDecoder()
	private readonly encoder = new TextEncoder()
	private requestBuffer = ""
	private stdoutController!: ReadableStreamDefaultController<Uint8Array>

	constructor(private closeFailuresRemaining = 0) {
		this.stdout = new ReadableStream<Uint8Array>({
			start: (controller) => {
				this.stdoutController = controller
			},
		})
		this.stdin = new WritableStream<Uint8Array>({
			write: (chunk) => {
				this.requestBuffer += this.decoder.decode(chunk, { stream: true })
				this.flushRequests()
			},
		})
	}

	close = async (): Promise<void> => {
		this.closeCalls += 1
		if (this.closeFailuresRemaining > 0) {
			this.closeFailuresRemaining -= 1
			throw new Error("Chrome close failed")
		}
		try {
			this.stdoutController.close()
		} catch {}
	}

	closePipe(): void {
		try {
			this.stdoutController.close()
		} catch {}
	}

	private flushRequests(): void {
		let frameStart = 0

		while (true) {
			const frameEnd = this.requestBuffer.indexOf("\0", frameStart)
			if (frameEnd === -1) {
				break
			}

			const raw = this.requestBuffer.slice(frameStart, frameEnd)
			frameStart = frameEnd + 1
			if (raw) {
				this.replyTo(raw)
			}
		}

		if (frameStart > 0) {
			this.requestBuffer = this.requestBuffer.slice(frameStart)
		}
	}

	private replyTo(raw: string): void {
		const request = JSON.parse(raw) as { id?: number; method?: string }
		if (typeof request.id !== "number") {
			return
		}

		const method = request.method ?? ""
		this.sentMethods.push(method)
		const response = JSON.stringify({
			id: request.id,
			result: this.synthesize(method),
		})
		const unhandledEvent = JSON.stringify({
			method: "HandstageTest.unhandled",
			params: { method },
		})
		const payload = `${response}\0${unhandledEvent}\0`
		const splitAt = Math.max(1, Math.floor(payload.length / 2))

		this.stdoutController.enqueue(
			this.encoder.encode(payload.slice(0, splitAt)),
		)
		queueMicrotask(() => {
			try {
				this.stdoutController.enqueue(
					this.encoder.encode(payload.slice(splitAt)),
				)
			} catch {}
		})
	}

	private synthesize(method: string): object {
		switch (method) {
			case "Target.createBrowserContext":
				return { browserContextId: "ctx-pipe-1" }
			case "Target.getTargets":
				return { targetInfos: [] }
			case "Target.getBrowserContexts":
				return { browserContextIds: [] }
			case "Target.setAutoAttach":
			case "Target.setDiscoverTargets":
			case "Browser.setDownloadBehavior":
			case "Target.disposeBrowserContext":
				return {}
			default:
				return {}
		}
	}
}

class ClosablePipeChrome implements LaunchedChrome {
	public closeCalls = 0
	public readonly stdout: ReadableStream<Uint8Array>
	public readonly stdin: WritableStream<Uint8Array>
	private stdoutController!: ReadableStreamDefaultController<Uint8Array>

	constructor(write?: () => void | Promise<void>) {
		this.stdout = new ReadableStream<Uint8Array>({
			start: (controller) => {
				this.stdoutController = controller
			},
		})
		this.stdin = new WritableStream<Uint8Array>(write ? { write } : {})
	}

	close = async (): Promise<void> => {
		this.closeCalls += 1
		try {
			this.stdoutController.close()
		} catch {}
	}
}

class BlackholedExternalSession implements ExternalCDPSession {
	public readonly id: string | null = null

	send<M extends CDPCommand>(
		_method: M,
		..._params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		return new Promise<CDPCommandResult<M>>(() => {})
	}

	on<E extends CDPEvent>(
		_event: E,
		_handler: (params: CDPEventParams<E>) => void,
	): void {}

	off<E extends CDPEvent>(
		_event: E,
		_handler: (params: CDPEventParams<E>) => void,
	): void {}
}

class DeferredAttachExternalSession implements ExternalCDPSession {
	public readonly id: string | null = null
	public readonly sent: Array<{ method: string; params?: unknown }> = []
	private readonly attachResolvers: Array<
		(result: { sessionId: string }) => void
	> = []
	private readonly handlers = new Map<string, Set<(params: unknown) => void>>()

	send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		this.sent.push({ method, params: params[0] })
		if (method !== "Target.attachToTarget") {
			return Promise.resolve({} as CDPCommandResult<M>)
		}
		return new Promise<CDPCommandResult<M>>((resolve) => {
			this.attachResolvers.push((result) => {
				resolve(result as unknown as CDPCommandResult<M>)
			})
		})
	}

	resolveAttach(index: number, sessionId: string): void {
		const resolve = this.attachResolvers[index]
		if (!resolve) {
			throw new Error(`missing attach request ${index}`)
		}
		resolve({ sessionId })
	}

	on<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		const handlers = this.handlers.get(event) ?? new Set()
		handlers.add(handler as (params: unknown) => void)
		this.handlers.set(event, handlers)
	}

	off<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		this.handlers.get(event)?.delete(handler as (params: unknown) => void)
	}

	emit<E extends CDPEvent>(event: E, params: CDPEventParams<E>): void {
		for (const handler of this.handlers.get(event) ?? []) {
			handler(params)
		}
	}

	async close(): Promise<void> {}
}

describe("CDPConnection transport ownership", () => {
	test("wrapping the same transport twice throws", () => {
		const transport = new InMemoryTransport()
		const conn = new CDPConnection(transport)
		expect(() => new CDPConnection(transport)).toThrow(
			HandstageTransportAlreadyOwnedError,
		)
		// close releases the marker so re-wrapping later is allowed
		void conn.close()
	})

	test("close releases the ownership marker", async () => {
		const transport = new InMemoryTransport()
		const first = new CDPConnection(transport)
		await first.close()
		// no throw now
		const second = new CDPConnection(transport)
		expect(second).toBeInstanceOf(CDPConnection)
		await second.close()
	})

	test("a failed transport close can be retried", async () => {
		class FlakyCloseTransport extends InMemoryTransport {
			private failures = 1

			override close(): void {
				if (this.failures > 0) {
					this.failures -= 1
					throw new Error("close failed")
				}
				super.close()
			}
		}

		const transport = new FlakyCloseTransport()
		const conn = new CDPConnection(transport)
		await expect(conn.close()).rejects.toThrow("close failed")
		expect(() => new CDPConnection(transport)).toThrow(
			HandstageTransportAlreadyOwnedError,
		)

		await conn.close()
		const replacement = new CDPConnection(transport)
		await replacement.close()
	})

	test("a rejected abandoned close releases ownership after settling", async () => {
		const transport = new InMemoryTransport()
		let rejectClose!: (error: Error) => void
		transport.close = () =>
			new Promise<void>((_resolve, reject) => {
				rejectClose = reject
			})
		const conn = new CDPConnection(transport)
		const closing = conn.close()
		await waitFor(() => typeof rejectClose === "function")
		conn.abandonOwnership()
		rejectClose(new Error("abandoned close failed"))
		await expect(closing).rejects.toThrow("abandoned close failed")

		transport.close = () => {
			transport.closeCalls += 1
		}
		const replacement = new CDPConnection(transport)
		await replacement.close()
	})

	test("a rejected abandoned external close can be retried by a replacement", async () => {
		class FlakyExternalSession extends BlackholedExternalSession {
			closeCalls = 0
			rejectFirstClose: ((error: Error) => void) | null = null

			async close(): Promise<void> {
				this.closeCalls += 1
				if (this.closeCalls > 1) {
					return
				}
				await new Promise<void>((_resolve, reject) => {
					this.rejectFirstClose = reject
				})
			}
		}
		const external = new FlakyExternalSession()
		const adapter = new ExternalConnectionAdapter(external)
		const closing = adapter.close()
		await waitFor(() => external.rejectFirstClose !== null)
		adapter.abandonOwnership()
		external.rejectFirstClose?.(new Error("external close failed"))
		await expect(closing).rejects.toThrow("external close failed")

		const replacement = new ExternalConnectionAdapter(external)
		await replacement.close()
		expect(external.closeCalls).toBe(2)
	})

	test("close is terminal before asynchronous transport cleanup", async () => {
		const transport = new InMemoryTransport()
		let finishClose!: () => void
		transport.close = () =>
			new Promise<void>((resolve) => {
				finishClose = resolve
			})
		const conn = new CDPConnection(transport)

		const closing = conn.close()
		await expect(conn.send("Page.enable")).rejects.toThrow("closed")
		finishClose()
		await closing
	})

	test("transport-originated close does not close the transport twice", async () => {
		const transport = new InMemoryTransport()
		new CDPConnection(transport)
		transport.onclose?.("remote close")

		expect(transport.closeCalls).toBe(0)
		const replacement = new CDPConnection(transport)
		await replacement.close()
		expect(transport.closeCalls).toBe(1)
	})

	test("auto-attach retry waits for an aborted startup rollback", async () => {
		const transport = new InMemoryTransport()
		let enableCalls = 0
		let discoverCalls = 0
		let rollbackRequest: { id: number } | null = null
		transport.send = (message) => {
			const request = JSON.parse(message) as {
				id: number
				method: string
				params?: { autoAttach?: boolean }
			}
			transport.sent.push(message)
			if (request.method === "Target.setAutoAttach") {
				if (request.params?.autoAttach === false) {
					rollbackRequest = request
					return
				}
				enableCalls += 1
				queueMicrotask(() =>
					transport.onmessage?.(JSON.stringify({ id: request.id, result: {} })),
				)
				return
			}
			if (request.method === "Target.setDiscoverTargets") {
				discoverCalls += 1
				if (discoverCalls > 1) {
					queueMicrotask(() =>
						transport.onmessage?.(
							JSON.stringify({ id: request.id, result: {} }),
						),
					)
				}
			}
		}
		const conn = new CDPConnection(transport)
		const controller = new AbortController()
		const first = conn.enableAutoAttach(controller.signal)
		await waitFor(() => discoverCalls === 1)
		controller.abort(new Error("first startup cancelled"))
		await waitFor(() => rollbackRequest !== null)
		const second = conn.enableAutoAttach()
		await new Promise((resolve) => setTimeout(resolve, 5))
		expect(enableCalls).toBe(1)

		const rollback = rollbackRequest
		if (!rollback) {
			throw new Error("expected rollback request")
		}
		transport.onmessage?.(JSON.stringify({ id: rollback.id, result: {} }))
		await expect(first).rejects.toThrow("first startup cancelled")
		await second
		expect(enableCalls).toBe(2)
		expect(discoverCalls).toBe(2)
		await conn.close()
	})

	test("transport errors detach handlers before notification and defer close", async () => {
		const transport = new InMemoryTransport()
		let handlingOriginError = true
		let closeWasReentrant = false
		transport.close = () => {
			transport.closeCalls += 1
			if (handlingOriginError) {
				closeWasReentrant = true
			}
		}
		const conn = new CDPConnection(transport)
		let notified = false
		let handlersWereDetached = false
		conn.onTransportClosed(() => {
			notified = true
			handlersWereDetached =
				transport.onmessage === undefined &&
				transport.onclose === undefined &&
				transport.onerror === undefined
			void conn.close().catch(() => {})
		})

		const onerror = transport.onerror
		onerror?.(new Error("transport failed"))
		handlingOriginError = false

		expect(notified).toBe(true)
		expect(handlersWereDetached).toBe(true)
		expect(closeWasReentrant).toBe(false)
		await conn.close()
		expect(transport.closeCalls).toBe(1)
	})

	test("transport error cleanup retains ownership until close settles", async () => {
		const transport = new InMemoryTransport()
		let finishClose!: () => void
		transport.close = () => {
			transport.closeCalls += 1
			return new Promise<void>((resolve) => {
				finishClose = resolve
			})
		}
		const conn = new CDPConnection(transport)
		transport.onerror?.(new Error("transport failed"))

		expect(() => new CDPConnection(transport)).toThrow(
			HandstageTransportAlreadyOwnedError,
		)
		await waitFor(() => typeof finishClose === "function")
		finishClose()
		await conn.close()
		const replacement = new CDPConnection(transport)
		replacement.abandonOwnership()
	})
})

describe("target command cancellation", () => {
	test("concrete connections honor getTargets and attach signals", async () => {
		const transport = new InMemoryTransport()
		const send = transport.send.bind(transport)
		transport.send = (message) => {
			const request = JSON.parse(message) as { method?: string }
			if (
				request.method === "Target.getTargets" ||
				request.method === "Target.attachToTarget"
			) {
				transport.sent.push(message)
				return
			}
			send(message)
		}
		const conn = new CDPConnection(transport)
		const getTargetsController = new AbortController()
		const targets = conn.getTargets(getTargetsController.signal)
		getTargetsController.abort(new Error("getTargets cancelled"))
		await expect(targets).rejects.toThrow("getTargets cancelled")

		const attachController = new AbortController()
		const attaching = conn.attachToTarget(
			"blackholed-target",
			attachController.signal,
		)
		attachController.abort(new Error("attach cancelled"))
		await expect(attaching).rejects.toThrow("attach cancelled")
		const internals = conn as unknown as {
			inflight: Map<number, unknown>
			lateResponses: Map<number, unknown>
			pendingAttaches: Set<unknown>
		}
		expect(internals.inflight.size).toBe(0)
		expect(internals.lateResponses.size).toBe(1)
		expect(internals.pendingAttaches.size).toBe(1)
		await conn.close()
		expect(internals.lateResponses.size).toBe(0)
		expect(internals.pendingAttaches.size).toBe(0)

		const external = new BlackholedExternalSession()
		const adapter = new ExternalConnectionAdapter(external)
		const externalTargetsController = new AbortController()
		const externalTargets = adapter.getTargets(externalTargetsController.signal)
		externalTargetsController.abort(new Error("external targets cancelled"))
		await expect(externalTargets).rejects.toThrow("external targets cancelled")

		const externalAttachController = new AbortController()
		const externalAttach = adapter.attachToTarget(
			"external-target",
			externalAttachController.signal,
		)
		externalAttachController.abort(new Error("external attach cancelled"))
		await expect(externalAttach).rejects.toThrow("external attach cancelled")
		const adapterInternals = adapter as unknown as {
			lateResultHandlers: Set<unknown>
			pendingSends: Set<unknown>
			pendingAttaches: Set<unknown>
		}
		expect(adapterInternals.pendingSends.size).toBe(0)
		expect(adapterInternals.lateResultHandlers.size).toBe(1)
		expect(adapterInternals.pendingAttaches.size).toBe(1)
		await adapter.close()
		expect(adapterInternals.lateResultHandlers.size).toBe(0)
		expect(adapterInternals.pendingAttaches.size).toBe(0)
	})

	test("aborted attachment detaches a session delivered before the response", async () => {
		const transport = new InMemoryTransport()
		const send = transport.send.bind(transport)
		transport.send = (message) => {
			const request = JSON.parse(message) as { method?: string }
			if (request.method === "Target.attachToTarget") {
				transport.sent.push(message)
				return
			}
			send(message)
		}
		const conn = new CDPConnection(transport)
		const controller = new AbortController()
		const attaching = conn.attachToTarget("target-abort", controller.signal)
		await waitFor(() =>
			transport.sent.some(
				(message) =>
					(JSON.parse(message) as { method?: string }).method ===
					"Target.attachToTarget",
			),
		)
		transport.onmessage?.(
			JSON.stringify({
				method: "Target.attachedToTarget",
				params: {
					sessionId: "session-abort",
					targetInfo: pageTarget("target-abort"),
					waitingForDebugger: true,
				},
			}),
		)
		expect(conn.getSession("session-abort")).toBeDefined()
		controller.abort(new Error("attachment cancelled"))

		await expect(attaching).rejects.toThrow("attachment cancelled")
		expect(conn.getSession("session-abort")).toBeDefined()
		const attachRequest = transport.sent
			.map((message) => JSON.parse(message) as { id: number; method?: string })
			.find((request) => request.method === "Target.attachToTarget")
		if (!attachRequest) {
			throw new Error("missing attach request")
		}
		transport.onmessage?.(
			JSON.stringify({
				id: attachRequest.id,
				result: { sessionId: "session-abort" },
			}),
		)
		expect(conn.getSession("session-abort")).toBeUndefined()
		await waitFor(() =>
			transport.sent.some((message) => {
				const request = JSON.parse(message) as {
					method?: string
					params?: { sessionId?: string }
				}
				return (
					request.method === "Target.detachFromTarget" &&
					request.params?.sessionId === "session-abort"
				)
			}),
		)
		await conn.close()
	})

	test("same-target CDP attaches remain independently cancelable", async () => {
		const transport = new InMemoryTransport()
		const send = transport.send.bind(transport)
		transport.send = (message) => {
			const request = JSON.parse(message) as { method?: string }
			if (request.method === "Target.attachToTarget") {
				transport.sent.push(message)
				return
			}
			send(message)
		}
		const conn = new CDPConnection(transport)
		const firstController = new AbortController()
		const secondController = new AbortController()
		const first = conn.attachToTarget("shared-target", firstController.signal)
		const second = conn.attachToTarget("shared-target", secondController.signal)
		const attachRequests = transport.sent
			.map((message) => JSON.parse(message) as { id: number; method?: string })
			.filter((request) => request.method === "Target.attachToTarget")
		expect(attachRequests).toHaveLength(2)
		const firstRequest = attachRequests[0]
		const secondRequest = attachRequests[1]
		if (!firstRequest || !secondRequest) {
			throw new Error("missing attach requests")
		}

		transport.onmessage?.(
			JSON.stringify({
				method: "Target.attachedToTarget",
				params: {
					sessionId: "session-second",
					targetInfo: pageTarget("shared-target"),
					waitingForDebugger: true,
				},
			}),
		)
		firstController.abort(new Error("first attach cancelled"))
		await expect(first).rejects.toThrow("first attach cancelled")

		transport.onmessage?.(
			JSON.stringify({
				id: secondRequest.id,
				result: { sessionId: "session-second" },
			}),
		)
		const secondSession = await second
		expect(secondSession.id).toBe("session-second")
		expect(conn.getSession("session-second")).toBe(secondSession)

		transport.onmessage?.(
			JSON.stringify({
				id: firstRequest.id,
				result: { sessionId: "session-first" },
			}),
		)
		transport.onmessage?.(
			JSON.stringify({
				method: "Target.attachedToTarget",
				params: {
					sessionId: "session-first",
					targetInfo: pageTarget("shared-target"),
					waitingForDebugger: true,
				},
			}),
		)
		const detachedSessionIds = transport.sent
			.map(
				(message) =>
					JSON.parse(message) as {
						method?: string
						params?: { sessionId?: string }
					},
			)
			.filter((request) => request.method === "Target.detachFromTarget")
			.map((request) => request.params?.sessionId)
		expect(detachedSessionIds).toEqual(["session-first"])
		expect(conn.getSession("session-first")).toBeUndefined()
		expect(conn.getSession("session-second")).toBe(secondSession)

		transport.onmessage?.(
			JSON.stringify({
				method: "Target.detachedFromTarget",
				params: {
					sessionId: "session-first",
					targetId: "shared-target",
				},
			}),
		)
		await conn.close()
	})

	test("same-target external attaches remain independently cancelable", async () => {
		const external = new DeferredAttachExternalSession()
		const adapter = new ExternalConnectionAdapter(external)
		const firstController = new AbortController()
		const secondController = new AbortController()
		const first = adapter.attachToTarget(
			"shared-external-target",
			firstController.signal,
		)
		const second = adapter.attachToTarget(
			"shared-external-target",
			secondController.signal,
		)

		external.emit("Target.attachedToTarget", {
			sessionId: "external-session-second",
			targetInfo: pageTarget("shared-external-target"),
			waitingForDebugger: true,
		})
		firstController.abort(new Error("first external attach cancelled"))
		await expect(first).rejects.toThrow("first external attach cancelled")

		external.resolveAttach(1, "external-session-second")
		const secondSession = await second
		expect(secondSession.id).toBe("external-session-second")
		expect(adapter.getSession("external-session-second")).toBe(secondSession)

		external.resolveAttach(0, "external-session-first")
		await waitFor(() =>
			external.sent.some(
				(entry) =>
					entry.method === "Target.detachFromTarget" &&
					(entry.params as { sessionId?: string } | undefined)?.sessionId ===
						"external-session-first",
			),
		)
		external.emit("Target.attachedToTarget", {
			sessionId: "external-session-first",
			targetInfo: pageTarget("shared-external-target"),
			waitingForDebugger: true,
		})
		const detachedSessionIds = external.sent
			.filter((entry) => entry.method === "Target.detachFromTarget")
			.map(
				(entry) =>
					(entry.params as { sessionId?: string } | undefined)?.sessionId,
			)
		expect(detachedSessionIds).toEqual(["external-session-first"])
		expect(adapter.getSession("external-session-first")).toBeUndefined()
		expect(adapter.getSession("external-session-second")).toBe(secondSession)

		external.emit("Target.detachedFromTarget", {
			sessionId: "external-session-first",
			targetId: "shared-external-target",
		})
		await adapter.close()
	})

	test("late cleanup handlers do not expire", async () => {
		jest.useFakeTimers()
		const transport = new InMemoryTransport()
		const send = transport.send.bind(transport)
		transport.send = (message) => {
			const request = JSON.parse(message) as { method?: string }
			if (request.method === "Target.createBrowserContext") {
				transport.sent.push(message)
				return
			}
			send(message)
		}
		const conn = new CDPConnection(transport)
		try {
			const controller = new AbortController()
			const cleanedContextIds: string[] = []
			const creating = conn.sendWithSignalAndLateResult(
				"Target.createBrowserContext",
				controller.signal,
				(result) => {
					cleanedContextIds.push(result.browserContextId)
				},
				{},
			)
			const request = transport.sent
				.map(
					(message) => JSON.parse(message) as { id: number; method?: string },
				)
				.find((entry) => entry.method === "Target.createBrowserContext")
			if (!request) {
				throw new Error("missing context creation request")
			}

			controller.abort(new Error("context creation cancelled"))
			await expect(creating).rejects.toThrow("context creation cancelled")
			const internals = conn as unknown as {
				inflight: Map<number, unknown>
				lateResponses: Map<number, unknown>
			}
			expect(internals.inflight.size).toBe(0)
			expect(internals.lateResponses.size).toBe(1)

			jest.advanceTimersByTime(31_000)
			expect(internals.lateResponses.size).toBe(1)
			transport.onmessage?.(
				JSON.stringify({
					id: request.id,
					result: { browserContextId: "late-context" },
				}),
			)
			expect(cleanedContextIds).toEqual(["late-context"])
			expect(internals.lateResponses.size).toBe(0)
		} finally {
			jest.useRealTimers()
			await conn.close()
		}
	})

	test("session teardown releases unreachable late cleanup handlers", async () => {
		const transport = new InMemoryTransport()
		const conn = new CDPConnection(transport)
		transport.onmessage?.(
			JSON.stringify({
				method: "Target.attachedToTarget",
				params: {
					sessionId: "runtime-session",
					targetInfo: pageTarget("runtime-target"),
					waitingForDebugger: true,
				},
			}),
		)
		const session = conn.getSession("runtime-session")
		if (!session) {
			throw new Error("missing runtime session")
		}
		const controller = new AbortController()
		const evaluating = session.sendWithSignalAndLateResult(
			"Runtime.evaluate",
			controller.signal,
			() => {},
			{ expression: "window.pending" },
		)
		controller.abort(new Error("runtime evaluation cancelled"))
		await expect(evaluating).rejects.toThrow("runtime evaluation cancelled")
		const internals = conn as unknown as {
			inflight: Map<number, unknown>
			lateResponses: Map<number, unknown>
		}
		expect(internals.inflight.size).toBe(0)
		expect(internals.lateResponses.size).toBe(1)

		transport.onmessage?.(
			JSON.stringify({
				method: "Target.detachedFromTarget",
				params: {
					sessionId: "runtime-session",
					targetId: "runtime-target",
				},
			}),
		)
		expect(internals.lateResponses.size).toBe(0)
		await conn.close()
	})
})

describe("Handstage connection lifecycle", () => {
	test("connectTransport twice with the same transport is rejected", async () => {
		const transport = new InMemoryTransport()
		const first = await connectTransport(transport)
		await expect(connectTransport(transport)).rejects.toBeInstanceOf(
			HandstageTransportAlreadyOwnedError,
		)
		await first.close()
	})

	test("owned initialization times out and releases transport ownership", async () => {
		const transport = new InMemoryTransport()
		const send = transport.send.bind(transport)
		transport.send = (message) => {
			const request = JSON.parse(message) as { method?: string }
			if (request.method === "Target.setAutoAttach") {
				return
			}
			send(message)
		}
		const conn = new CDPConnection(transport)

		await expect(
			createOwnedHandstage({
				conn,
				lbo: {},
				sharedOpts: {},
				logSink: () => {},
				initializationTimeoutMs: 10,
			}),
		).rejects.toThrow("initialization timed out")
		expect(transport.closeCalls).toBe(1)

		const replacement = new CDPConnection(transport)
		await replacement.close()
	})

	test("bootstrap deadlines cancel blackholed target discovery and attachment", async () => {
		for (const blackholedMethod of [
			"Target.getTargets",
			"Target.attachToTarget",
		]) {
			const transport = new InMemoryTransport()
			const send = transport.send.bind(transport)
			transport.send = (message) => {
				const request = JSON.parse(message) as {
					id: number
					method?: string
				}
				if (request.method === blackholedMethod) {
					transport.sent.push(message)
					return
				}
				if (
					blackholedMethod === "Target.attachToTarget" &&
					request.method === "Target.getTargets"
				) {
					transport.sent.push(message)
					queueMicrotask(() => {
						transport.onmessage?.(
							JSON.stringify({
								id: request.id,
								result: {
									targetInfos: [pageTarget("existing-target")],
								},
							}),
						)
					})
					return
				}
				send(message)
			}
			const conn = new CDPConnection(transport)

			await expect(
				withTimeout(
					createOwnedHandstage({
						conn,
						lbo: {},
						sharedOpts: {},
						logSink: () => {},
						initializationTimeoutMs: 10,
						cleanupTimeoutMs: 50,
					}),
					250,
					`${blackholedMethod} bootstrap`,
				),
			).rejects.toThrow("initialization timed out")
			expect(transport.closeCalls).toBe(1)

			const replacement = new CDPConnection(transport)
			await replacement.close()
		}
	})

	test("startup cleanup is bounded when transport close never settles", async () => {
		const transport = new InMemoryTransport()
		const send = transport.send.bind(transport)
		transport.send = (message) => {
			const request = JSON.parse(message) as { method?: string }
			if (request.method === "Target.setAutoAttach") {
				transport.sent.push(message)
				return
			}
			send(message)
		}
		transport.close = () => {
			transport.closeCalls += 1
			return new Promise<void>(() => {})
		}
		const conn = new CDPConnection(transport)

		const error = await withTimeout(
			createOwnedHandstage({
				conn,
				lbo: {},
				sharedOpts: {},
				logSink: () => {},
				initializationTimeoutMs: 10,
				cleanupTimeoutMs: 10,
			}).then(
				() => null,
				(error: unknown) => error,
			),
			250,
			"bounded startup cleanup",
		)
		expect(error).toBeInstanceOf(AggregateError)
		expect(
			(error as AggregateError).errors.some((entry) =>
				String(entry).includes("initialization cleanup timed out"),
			),
		).toBe(true)
		expect(transport.closeCalls).toBe(1)

		expect(() => new CDPConnection(transport)).toThrow(
			HandstageTransportAlreadyOwnedError,
		)
	})

	test("initialization deadline covers download configuration", async () => {
		const transport = new InMemoryTransport()
		const send = transport.send.bind(transport)
		transport.send = (message) => {
			const request = JSON.parse(message) as { method?: string }
			if (request.method === "Browser.setDownloadBehavior") {
				transport.sent.push(message)
				return
			}
			send(message)
		}
		const conn = new CDPConnection(transport)

		await expect(
			withTimeout(
				createOwnedHandstage({
					conn,
					lbo: { acceptDownloads: true },
					sharedOpts: {},
					logSink: () => {},
					initializationTimeoutMs: 10,
					cleanupTimeoutMs: 50,
				}),
				250,
				"download setup",
			),
		).rejects.toThrow("initialization timed out")
		expect(
			transport.sent.some(
				(message) =>
					(JSON.parse(message) as { method?: string }).method ===
					"Browser.setDownloadBehavior",
			),
		).toBe(true)
		expect(transport.closeCalls).toBe(1)

		const replacement = new CDPConnection(transport)
		await replacement.close()
	})

	test("Handstage.close calls transport.close exactly once when Handstage owns it", async () => {
		const transport = new InMemoryTransport()
		const handstage = await connectTransport(transport)
		expect(transport.closeCalls).toBe(0)
		await handstage.close()
		expect(transport.closeCalls).toBe(1)
	})

	test("connectLocal parses split and coalesced pipe messages", async () => {
		const chrome = new SplitResponsePipeChrome()
		const handstage = await connectLocal(chrome, {
			localBrowserLaunchOptions: { acceptDownloads: true },
		})

		expect(chrome.sentMethods).toContain("Target.setAutoAttach")
		expect(chrome.sentMethods).toContain("Target.getTargets")
		expect(chrome.sentMethods).toContain("Browser.setDownloadBehavior")

		await handstage.close()
		expect(chrome.closeCalls).toBe(1)
	})

	test("connectLocal releases Chrome when the pipe closes first", async () => {
		const chrome = new SplitResponsePipeChrome()
		const handstage = await connectLocal(chrome)

		chrome.closePipe()
		await waitFor(() => chrome.closeCalls === 1)
		await handstage.close()

		expect(chrome.closeCalls).toBe(1)
	})

	test("connectLocal retries Chrome cleanup after a pipe-originated close", async () => {
		const chrome = new SplitResponsePipeChrome(1)
		const handstage = await connectLocal(chrome)

		chrome.closePipe()
		await waitFor(() => chrome.closeCalls >= 1)
		await handstage.close()

		expect(chrome.closeCalls).toBe(2)
	})

	test("connectLocal closes Chrome when initialization fails before ownership", async () => {
		const loggerFailure = new ClosablePipeChrome()
		await expect(
			connectLocal(loggerFailure, {
				logger: () => {
					throw new Error("logger failed")
				},
			}),
		).rejects.toThrow("logger failed")
		expect(loggerFailure.closeCalls).toBe(1)

		const lockedPipe = new ClosablePipeChrome()
		const lock = lockedPipe.stdin.getWriter()
		await expect(connectLocal(lockedPipe)).rejects.toThrow()
		expect(lockedPipe.closeCalls).toBe(1)
		lock.releaseLock()
	})

	test("asynchronous pipe write failures reject setup and close Chrome", async () => {
		const chrome = new ClosablePipeChrome(() =>
			Promise.reject(new Error("pipe write failed")),
		)

		await expect(connectLocal(chrome)).rejects.toThrow("pipe write failed")
		expect(chrome.closeCalls).toBe(1)
	})

	test("connectConnection does not close the shared connection", async () => {
		const conn = new FakeConnection()
		const handstage = await connectConnection(conn)
		const before = conn.closeCalls
		await handstage.close()
		expect(conn.closeCalls).toBe(before)
		expect(conn.closed).toBe(false)
	})

	test("a shared default-context page is routed to its creating client", async () => {
		class SharedDefaultConnection extends FakeConnection {
			override send<M extends CDPCommand>(
				method: M,
				...params: CDPCommandParams<M>
			): Promise<CDPCommandResult<M>> {
				if (method !== "Target.createTarget") {
					return super.send(method, ...params)
				}
				this.sent.push({ method, params: params[0] })
				const targetId = "target-created-by-second"
				const session = new FakeSession("session-created-by-second")
				session.responses.set("Page.getFrameTree", {
					frameTree: { frame: { id: "F0", url: "about:blank" } },
				})
				this.sessions.set(session.id, session)
				queueMicrotask(() =>
					this.emit("Target.attachedToTarget", {
						sessionId: session.id,
						targetInfo: pageTarget(targetId),
						waitingForDebugger: true,
					}),
				)
				return Promise.resolve({ targetId } as CDPCommandResult<M>)
			}
		}

		const conn = new SharedDefaultConnection()
		const first = await connectConnection(conn)
		const second = await connectConnection(conn)
		const page = await withTimeout(
			second.newPage(),
			250,
			"second shared client newPage",
		)

		expect(page.targetId()).toBe("target-created-by-second")
		expect(first.pages()).toHaveLength(0)
		expect(second.pages()).toEqual([page])
		await first.close()
		await second.close()
	})

	test("two Handstage instances on a shared connection each receive their own router-level logs", async () => {
		const conn = new FakeConnection()
		// Make sure it doesn't try to look up browser contexts
		conn.nonDefaultContextIds = []
		const aLines: string[] = []
		const bLines: string[] = []
		// Verbose=Debug so the router-level Debug line actually reaches the
		// user logger (the default Info filter would swallow it).
		const a = await connectConnection(conn, {
			logger: (line) => aLines.push(line.message),
			verbose: LogLevel.Debug,
		})
		const b = await connectConnection(conn, {
			logger: (line) => bLines.push(line.message),
			verbose: LogLevel.Debug,
		})

		// Register a throwing third delegate to force the router into its
		// "Target ownership predicate failed" log path; the router broadcasts
		// that line to every registered delegate's logger.
		const router = getTargetRouter(conn)
		const throwingDelegate: TargetRouterDelegate = {
			canClaimTarget: () => {
				throw new Error("boom-shared")
			},
			onRouterAttachedToTarget: () => {},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
		}
		const routerInternals = router as unknown as {
			delegates: TargetRouterDelegate[]
			loggers?: Map<TargetRouterDelegate, () => void>
		}
		// Insert at the front so it definitely gets called before a/b return true
		routerInternals.delegates.unshift(throwingDelegate)
		if (routerInternals.loggers) {
			routerInternals.loggers.set(throwingDelegate, () => {})
		}

		// Make sure a default context target triggers a claim check on the throwing delegate.
		const sessionId = "s-shared-log"
		conn.sessions.set(sessionId, new FakeSession(sessionId))
		conn.emit("Target.attachedToTarget", {
			sessionId,
			targetInfo: {
				targetId: "shared-log-target",
				type: "page",
				title: "",
				url: "about:blank",
				attached: false,
				canAccessOpener: false,
			},
			waitingForDebugger: true,
		})

		const sawA = () =>
			aLines.some((m) => m.includes("Target ownership predicate failed"))
		const sawB = () =>
			bLines.some((m) => m.includes("Target ownership predicate failed"))

		await waitFor(() => sawA() && sawB())
		expect(sawA()).toBe(true)
		expect(sawB()).toBe(true)

		router.unregister(throwingDelegate)
		await a.close()
		await b.close()
	})
})

describe("TargetRouter cancellation", () => {
	test("a new registration does not join a canceled startup", async () => {
		class RetryableAutoAttachConnection extends FakeConnection {
			override async enableAutoAttach(signal?: AbortSignal): Promise<void> {
				this.autoAttachCalls += 1
				if (this.autoAttachCalls > 1) {
					return
				}
				await new Promise<void>((_resolve, reject) => {
					const onAbort = () => {
						signal?.removeEventListener("abort", onAbort)
						reject(signal?.reason ?? new Error("startup aborted"))
					}
					signal?.addEventListener("abort", onAbort, { once: true })
				})
			}
		}
		const conn = new RetryableAutoAttachConnection()
		const router = getTargetRouter(conn)
		const delegate = (): TargetRouterDelegate => ({
			canClaimTarget: () => false,
			onRouterAttachedToTarget: () => {},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
		})
		const firstController = new AbortController()
		const first = router.register(delegate(), undefined, firstController.signal)
		await waitFor(() => conn.autoAttachCalls === 1)
		firstController.abort(new Error("first startup cancelled"))
		await expect(first).rejects.toThrow("first startup cancelled")

		const unregister = await withTimeout(
			router.register(delegate()),
			100,
			"router startup retry",
		)
		expect(conn.autoAttachCalls).toBe(2)
		unregister()
	})

	test("concurrent registrations abort independently", async () => {
		class DeferredAutoAttachConnection extends FakeConnection {
			public startupSignal: AbortSignal | undefined
			public finishAutoAttach: () => void = () => {}

			override async enableAutoAttach(signal?: AbortSignal): Promise<void> {
				this.autoAttachCalls += 1
				this.startupSignal = signal
				await new Promise<void>((resolve, reject) => {
					const cleanup = () => signal?.removeEventListener("abort", onAbort)
					const onAbort = () => {
						cleanup()
						reject(
							signal?.reason instanceof Error
								? signal.reason
								: new Error("auto-attach aborted"),
						)
					}
					this.finishAutoAttach = () => {
						cleanup()
						resolve()
					}
					signal?.addEventListener("abort", onAbort, { once: true })
					if (signal?.aborted) {
						onAbort()
					}
				})
			}
		}

		const conn = new DeferredAutoAttachConnection()
		const router = getTargetRouter(conn)
		const firstDelegate: TargetRouterDelegate = {
			canClaimTarget: () => false,
			onRouterAttachedToTarget: () => {},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
		}
		const secondDelegate: TargetRouterDelegate = {
			canClaimTarget: () => false,
			onRouterAttachedToTarget: () => {},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
		}
		const firstController = new AbortController()
		const secondController = new AbortController()
		const firstRegistration = router
			.register(firstDelegate, undefined, firstController.signal)
			.then(
				() => null,
				(error: unknown) => error,
			)
		const secondRegistration = router.register(
			secondDelegate,
			undefined,
			secondController.signal,
		)

		firstController.abort(new Error("first registration cancelled"))
		const firstError = await firstRegistration
		expect(firstError).toBeInstanceOf(Error)
		expect((firstError as Error).message).toBe("first registration cancelled")
		const internals = router as unknown as {
			delegates: TargetRouterDelegate[]
		}
		expect(internals.delegates).not.toContain(firstDelegate)
		expect(internals.delegates).toContain(secondDelegate)
		expect(conn.startupSignal?.aborted).toBe(false)

		conn.finishAutoAttach()
		const unregisterSecond = await withTimeout(
			secondRegistration,
			100,
			"second router registration",
		)
		expect(conn.autoAttachCalls).toBe(1)
		unregisterSecond()
	})

	test("removed future delegates cannot stall ownership routing", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-membership")
		conn.sessions.set(session.id, session)
		const router = getTargetRouter(conn)
		let finishFirstClaim!: (claimed: boolean) => void
		const firstClaim = new Promise<boolean>((resolve) => {
			finishFirstClaim = resolve
		})
		let firstClaimStarted = false
		let removedClaimCalls = 0
		let attachedToCurrent = false
		const first: TargetRouterDelegate = {
			canClaimTarget: () => {
				firstClaimStarted = true
				return firstClaim
			},
			onRouterAttachedToTarget: () => {},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
		}
		const removed: TargetRouterDelegate = {
			canClaimTarget: () => {
				removedClaimCalls += 1
				return new Promise<boolean>(() => {})
			},
			onRouterAttachedToTarget: () => {},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
		}
		const current: TargetRouterDelegate = {
			canClaimTarget: () => true,
			onRouterAttachedToTarget: () => {
				attachedToCurrent = true
			},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
		}
		const unregisterFirst = await router.register(first)
		const unregisterRemoved = await router.register(removed)
		const unregisterCurrent = await router.register(current)

		conn.emit(
			"Target.attachedToTarget",
			attachedEvent(session.id, pageTarget("t-membership")),
		)
		await waitFor(() => firstClaimStarted)
		unregisterRemoved()
		finishFirstClaim(false)

		await waitFor(() => attachedToCurrent)
		expect(removedClaimCalls).toBe(0)
		unregisterFirst()
		unregisterCurrent()
	})
})

describe("ExecutionContextRegistry generations", () => {
	test("reattaching the same session clears caches and cancels prior waits", async () => {
		const registry = new ExecutionContextRegistry()
		const session = new FakeSession("s-reattach")
		const disposeFirst = registry.attachSession(session)
		session.emit("Runtime.executionContextCreated", {
			context: {
				id: 11,
				origin: "",
				name: "",
				uniqueId: "context-11",
				auxData: { frameId: "F0", isDefault: true },
			},
		})
		expect(registry.getMainWorld(session, "F0")).toBe(11)

		const priorWait = registry.waitForMainWorld(session, "F1", 10_000).then(
			() => null,
			(error: unknown) => error,
		)
		await waitFor(
			() => session.handlerCount("Runtime.executionContextCreated") === 2,
		)
		const staleHandlers = session.handlersFor("Runtime.executionContextCreated")
		const disposeSecond = registry.attachSession(session)

		expect(registry.getMainWorld(session, "F0")).toBeNull()
		const priorWaitError = await priorWait
		expect(priorWaitError).toBeInstanceOf(Error)
		expect((priorWaitError as Error).message).toContain("reattached")
		for (const handler of staleHandlers) {
			handler({
				context: {
					id: 99,
					origin: "",
					name: "",
					uniqueId: "stale-context",
					auxData: { frameId: "F1", isDefault: true },
				},
			})
		}
		expect(registry.getMainWorld(session, "F1")).toBeNull()

		session.emit("Runtime.executionContextCreated", {
			context: {
				id: 22,
				origin: "",
				name: "",
				uniqueId: "context-22",
				auxData: { frameId: "F0", isDefault: true },
			},
		})
		expect(registry.getMainWorld(session, "F0")).toBe(22)
		disposeFirst()
		expect(registry.getMainWorld(session, "F0")).toBe(22)
		disposeSecond()
		expect(registry.getMainWorld(session, "F0")).toBeNull()
	})
})
