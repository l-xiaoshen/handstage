/**
 * Regression tests for Context close and cancellation lifecycle behavior.
 */
import { describe, expect, test } from "bun:test"
import type { Protocol } from "devtools-protocol"
import { withTimeout } from "../src/v3/timeoutConfig"
import { CDPConnectionClosedError } from "../src/v3/types/public/sdkErrors"
import {
	type CDPCommand,
	type CDPCommandParams,
	type CDPCommandResult,
	CDPConnection,
} from "../src/v3/understudy/cdp"
import { Context } from "../src/v3/understudy/context"
import type { Page as PageType } from "../src/v3/understudy/page"
import {
	FakeConnection,
	FakeSession,
	InMemoryTransport,
	pageTarget,
	waitFor,
} from "./_fakes"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("Context close races", () => {
	test("isolated-context deadline remains active through bootstrap", async () => {
		class BlockedBootstrapConnection extends FakeConnection {
			private markTargetsStarted!: () => void
			public readonly targetsStarted = new Promise<void>((resolve) => {
				this.markTargetsStarted = resolve
			})

			override getTargets(
				signal?: AbortSignal,
			): Promise<Protocol.Target.TargetInfo[]> {
				this.markTargetsStarted()
				return new Promise((_resolve, reject) => {
					const onAbort = () => {
						signal?.removeEventListener("abort", onAbort)
						reject(signal?.reason ?? new Error("bootstrap aborted"))
					}
					signal?.addEventListener("abort", onAbort, { once: true })
					if (signal?.aborted) {
						onAbort()
					}
				})
			}
		}

		const conn = new BlockedBootstrapConnection()
		const controller = new AbortController()
		const creating = Context.createIsolatedFromConnection(conn, {
			signal: controller.signal,
		})
		await conn.targetsStarted
		controller.abort(new Error("isolated bootstrap cancelled"))

		await expect(creating).rejects.toThrow("isolated bootstrap cancelled")
		expect(
			conn.sent.some(
				(entry) => entry.method === "Target.disposeBrowserContext",
			),
		).toBe(true)
	})

	test("newPage cancellation removes inflight work and closes a late target", async () => {
		class DelayedTargetTransport extends InMemoryTransport {
			override send(message: string): void {
				const request = JSON.parse(message) as {
					id: number
					method?: string
				}
				if (request.method === "Target.createTarget") {
					this.sent.push(message)
					return
				}
				if (request.method === "Target.closeTarget") {
					this.sent.push(message)
					queueMicrotask(() =>
						this.onmessage?.(
							JSON.stringify({ id: request.id, result: { success: true } }),
						),
					)
					return
				}
				super.send(message)
			}
		}

		const transport = new DelayedTargetTransport()
		const conn = new CDPConnection(transport)
		const ctx = await Context.createDefaultFromConnection(conn)
		const creating = ctx.newPage()
		await waitFor(() =>
			transport.sent.some(
				(message) =>
					(JSON.parse(message) as { method?: string }).method ===
					"Target.createTarget",
			),
		)
		const createRequest = transport.sent
			.map((message) => JSON.parse(message) as { id: number; method?: string })
			.find((request) => request.method === "Target.createTarget")
		if (!createRequest) {
			throw new Error("expected target creation request")
		}

		await ctx.close()
		await expect(
			withTimeout(creating, 100, "cancelled newPage"),
		).rejects.toThrow("closed")
		const internals = conn as unknown as { inflight: Map<number, unknown> }
		expect(internals.inflight.size).toBe(0)

		transport.onmessage?.(
			JSON.stringify({
				id: createRequest.id,
				result: { targetId: "late-target" },
			}),
		)
		await waitFor(() =>
			transport.sent.some((message) => {
				const request = JSON.parse(message) as {
					method?: string
					params?: { targetId?: string }
				}
				return (
					request.method === "Target.closeTarget" &&
					request.params?.targetId === "late-target"
				)
			}),
		)
		await conn.close()
	})

	test("target destruction before createTarget response cannot be reintroduced", async () => {
		class DelayedTargetConnection extends FakeConnection {
			public finishCreate!: () => void
			public readonly createStarted: Promise<void>
			private markCreateStarted!: () => void

			constructor() {
				super()
				this.createStarted = new Promise((resolve) => {
					this.markCreateStarted = resolve
				})
			}

			override send<M extends CDPCommand>(
				method: M,
				...params: CDPCommandParams<M>
			): Promise<CDPCommandResult<M>> {
				if (method === "Target.createTarget") {
					this.markCreateStarted()
					return new Promise((resolve) => {
						this.finishCreate = () =>
							resolve({ targetId: "destroyed-before-response" } as never)
					})
				}
				return super.send(method, ...params)
			}
		}

		const conn = new DelayedTargetConnection()
		const ctx = await Context.createDefaultFromConnection(conn)
		const creating = ctx.newPage()
		await conn.createStarted
		ctx.onRouterTargetDestroyed("destroyed-before-response")
		conn.finishCreate()

		await expect(
			withTimeout(creating, 100, "destroyed target creation"),
		).rejects.toThrow("destroyed during creation")
		const internals = ctx as unknown as { ownedTargetIds: Set<string> }
		expect(internals.ownedTargetIds.has("destroyed-before-response")).toBe(
			false,
		)
		await ctx.close()
	})

	test("existing-target bootstrap rethrows lifetime cancellation", async () => {
		class AbortableExistingTargetConnection extends FakeConnection {
			private markAttachStarted!: () => void
			public readonly attachStarted = new Promise<void>((resolve) => {
				this.markAttachStarted = resolve
			})

			override attachToTarget(
				_targetId: string,
				signal?: AbortSignal,
			): Promise<FakeSession> {
				this.markAttachStarted()
				return new Promise<FakeSession>((_resolve, reject) => {
					const onAbort = () => {
						signal?.removeEventListener("abort", onAbort)
						reject(
							signal?.reason instanceof Error
								? signal.reason
								: new Error("attach aborted"),
						)
					}
					signal?.addEventListener("abort", onAbort, { once: true })
					if (signal?.aborted) {
						onAbort()
					}
				})
			}
		}

		const conn = new AbortableExistingTargetConnection()
		conn.targets = [pageTarget("t-existing-bootstrap")]
		const controller = new AbortController()
		const cancellation = new CDPConnectionClosedError("bootstrap cancelled")
		const creating = Context.createDefaultFromConnection(conn, {
			signal: controller.signal,
		})
		const outcome = creating.then(
			() => null,
			(error: unknown) => error,
		)
		await conn.attachStarted

		controller.abort(cancellation)

		expect(await outcome).toBe(cancellation)
		await conn.close()
	})

	test("target destruction before Page registration clears target bookkeeping", async () => {
		const conn = new FakeConnection()
		const context = await Context.createDefaultFromConnection(conn)
		const targetId = "t-destroyed-before-registration"
		const internals = context as unknown as {
			ownedTargetIds: Set<string>
			pagesByTarget: Map<string, PageType>
			mainFrameToTarget: Map<string, string>
			createdAtByTarget: Map<string, number>
			typeByTarget: Map<string, string>
			pendingCreatedTargetUrl: Map<string, string>
		}
		internals.ownedTargetIds.add(targetId)
		internals.mainFrameToTarget.set("F-pending", targetId)
		internals.createdAtByTarget.set(targetId, Date.now())
		internals.typeByTarget.set(targetId, "page")
		internals.pendingCreatedTargetUrl.set(targetId, "about:blank")

		context.onRouterTargetDestroyed(targetId)

		expect(internals.ownedTargetIds.has(targetId)).toBe(false)
		expect(internals.pagesByTarget.has(targetId)).toBe(false)
		expect(internals.mainFrameToTarget.has("F-pending")).toBe(false)
		expect(internals.createdAtByTarget.has(targetId)).toBe(false)
		expect(internals.typeByTarget.has(targetId)).toBe(false)
		expect(internals.pendingCreatedTargetUrl.has(targetId)).toBe(false)
		await context.close()
	})

	test("owned targets already absent are successful closes", async () => {
		class AlreadyGoneTargetConnection extends FakeConnection {
			override send<M extends CDPCommand>(
				method: M,
				...params: CDPCommandParams<M>
			): Promise<CDPCommandResult<M>> {
				if (method === "Target.closeTarget") {
					const { targetId } = params[0] as { targetId: string }
					this.sent.push({ method, params: params[0] })
					if (targetId === "t-missing-error") {
						return Promise.reject(new Error("No target with given id found"))
					}
					return Promise.resolve({ success: false } as CDPCommandResult<M>)
				}
				return super.send(method, ...params)
			}
		}

		const conn = new AlreadyGoneTargetConnection()
		const context = await Context.createDefaultFromConnection(conn)
		const internals = context as unknown as { ownedTargetIds: Set<string> }
		internals.ownedTargetIds.add("t-missing-error")
		internals.ownedTargetIds.add("t-false-but-absent")

		await context.close()

		expect(internals.ownedTargetIds.size).toBe(0)
		expect(
			conn.sent.filter((entry) => entry.method === "Target.closeTarget"),
		).toHaveLength(2)
	})

	test("close awaits detach and bounds a blackholed detach response", async () => {
		class BlackholedDetachConnection extends FakeConnection {
			private markDetachStarted!: () => void
			public readonly detachStarted = new Promise<void>((resolve) => {
				this.markDetachStarted = resolve
			})

			override send<M extends CDPCommand>(
				method: M,
				...params: CDPCommandParams<M>
			): Promise<CDPCommandResult<M>> {
				if (method === "Target.detachFromTarget") {
					this.sent.push({ method, params: params[0] })
					this.markDetachStarted()
					return new Promise<CDPCommandResult<M>>(() => {})
				}
				return super.send(method, ...params)
			}
		}

		const conn = new BlackholedDetachConnection()
		const session = new FakeSession("s-bounded-detach")
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		conn.sessions.set(session.id, session)
		const context = await Context.createDefaultFromConnection(conn)
		await context.onRouterAttachedToTarget(
			pageTarget("t-bounded-detach"),
			session.id,
		)
		let closeSettled = false
		const closing = context.close().then(() => {
			closeSettled = true
		})
		await conn.detachStarted
		await sleep(10)
		expect(closeSettled).toBe(false)

		await withTimeout(closing, 2_750, "bounded Target.detachFromTarget")
		expect(closeSettled).toBe(true)
	})

	test("browser-context disposal failures can be retried", async () => {
		class FlakyDisposeConnection extends FakeConnection {
			public disposeCalls = 0
			override send<M extends CDPCommand>(
				method: M,
				...params: CDPCommandParams<M>
			): Promise<CDPCommandResult<M>> {
				if (method === "Target.disposeBrowserContext") {
					this.disposeCalls += 1
					if (this.disposeCalls === 1) {
						return Promise.reject(new Error("dispose failed"))
					}
				}
				return super.send(method, ...params)
			}
		}

		const conn = new FlakyDisposeConnection()
		const ctx = await Context.createIsolatedFromConnection(conn)

		await expect(ctx.close()).rejects.toThrow("dispose failed")
		await ctx.close()
		expect(conn.disposeCalls).toBe(2)
	})

	test("a lost disposal acknowledgement is idempotent on retry", async () => {
		class LostAcknowledgementConnection extends FakeConnection {
			public disposeCalls = 0
			override send<M extends CDPCommand>(
				method: M,
				...params: CDPCommandParams<M>
			): Promise<CDPCommandResult<M>> {
				if (method === "Target.disposeBrowserContext") {
					this.disposeCalls += 1
					return Promise.reject(
						this.disposeCalls === 1
							? new Error("disposal acknowledgement timed out")
							: new Error("Failed to find browser context"),
					)
				}
				return super.send(method, ...params)
			}
		}

		const conn = new LostAcknowledgementConnection()
		const ctx = await Context.createIsolatedFromConnection(conn)
		await expect(ctx.close()).rejects.toThrow("acknowledgement timed out")
		await ctx.close()
		expect(conn.disposeCalls).toBe(2)
		expect(ctx.browserContextId).toBeNull()
	})

	test("closed contexts reject operations before allocating resources", async () => {
		const conn = new FakeConnection()
		const ctx = await Context.createDefaultFromConnection(conn)
		await ctx.close()
		const createCalls = conn.sent.filter(
			(entry) => entry.method === "Target.createTarget",
		).length

		await expect(ctx.newPage()).rejects.toBeInstanceOf(CDPConnectionClosedError)
		expect(
			conn.sent.filter((entry) => entry.method === "Target.createTarget"),
		).toHaveLength(createCalls)
	})

	test("an in-flight target attach cannot recreate page state after close", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-late-attach")
		let finishFrameTree!: (value: unknown) => void
		const frameTreeResponse = new Promise((resolve) => {
			finishFrameTree = resolve
		})
		session.responses.set("Page.getFrameTree", frameTreeResponse)
		conn.sessions.set(session.id, session)
		const ctx = await Context.createDefaultFromConnection(conn)

		const attaching = ctx.onRouterAttachedToTarget(
			pageTarget("t-late-attach"),
			session.id,
		)
		await waitFor(() =>
			session.sent.some((entry) => entry.method === "Page.getFrameTree"),
		)

		const closing = ctx.close()
		finishFrameTree({
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		await Promise.all([attaching, closing])

		expect(ctx.pages()).toHaveLength(0)
		expect(session.handlerCount("Runtime.executionContextCreated")).toBe(0)
		expect(session.handlerCount("Page.frameAttached")).toBe(0)
		expect(session.handlerCount("Network.requestWillBeSent")).toBe(0)
		expect(
			conn.sent.some(
				(entry) =>
					entry.method === "Target.detachFromTarget" &&
					(entry.params as { sessionId: string }).sessionId === session.id,
			),
		).toBe(true)
	})

	test("close cancels blackholed target setup and drains early Runtime objects", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-blackholed-attach")
		session.responses.set("Page.getFrameTree", new Promise<never>(() => {}))
		conn.sessions.set(session.id, session)
		const ctx = await Context.createDefaultFromConnection(conn)

		const attaching = ctx.onRouterAttachedToTarget(
			pageTarget("t-blackholed-attach"),
			session.id,
		)
		await waitFor(() =>
			session.sent.some((entry) => entry.method === "Page.getFrameTree"),
		)
		session.emit("Runtime.consoleAPICalled", {
			type: "log",
			args: [{ type: "object", objectId: "early-console-object" }],
			executionContextId: 1,
			timestamp: 1,
		})

		await ctx.close()
		await withTimeout(attaching, 100, "cancelled target setup")
		await waitFor(() =>
			session.sent.some(
				(entry) =>
					entry.method === "Runtime.releaseObject" &&
					(entry.params as { objectId: string }).objectId ===
						"early-console-object",
			),
		)
		expect(session.handlerCount("Runtime.consoleAPICalled")).toBe(0)
		expect(ctx.pages()).toHaveLength(0)
	})

	test("captured frame callbacks cannot recreate state after context close", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-late-frame-event")
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		conn.sessions.set(session.id, session)
		const ctx = await Context.createDefaultFromConnection(conn)
		await ctx.onRouterAttachedToTarget(
			pageTarget("t-late-frame-event"),
			session.id,
		)
		const page = ctx.pages()[0]
		if (!page) {
			throw new Error("expected attached page")
		}
		const queuedHandlers = session.handlersFor("Page.frameAttached")

		await ctx.close()
		for (const handler of queuedHandlers) {
			handler({ frameId: "F-late", parentFrameId: "F0" })
		}

		expect(ctx.pages()).toHaveLength(0)
		expect(page.listAllFrameIds()).toHaveLength(0)
		const internals = ctx as unknown as {
			frameOwnerPage: Map<string, PageType>
			mainFrameToTarget: Map<string, string>
		}
		expect(internals.frameOwnerPage.size).toBe(0)
		expect(internals.mainFrameToTarget.size).toBe(0)
	})
})
