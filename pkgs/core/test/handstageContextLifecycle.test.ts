/**
 * Regression tests for Handstage context registry resource lifecycle behavior.
 */
import { describe, expect, test } from "bun:test"
import { connectConnection } from "../src/v3/connect/connection"
import { connectTransport } from "../src/v3/connect/transport"
import { createHandstageForConnection } from "../src/v3/handstage"
import { withTimeout } from "../src/v3/timeoutConfig"
import { CDPConnectionClosedError } from "../src/v3/types/public/sdkErrors"
import {
	type CDPCommand,
	type CDPCommandParams,
	type CDPCommandResult,
	CDPConnection,
} from "../src/v3/understudy/cdp"
import { Context } from "../src/v3/understudy/context"
import {
	FakeConnection,
	FakeSession,
	InMemoryTransport,
	pageTarget,
	waitFor,
} from "./_fakes"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("Handstage context registry", () => {
	test("closed contexts are dropped from browserContexts()", async () => {
		const transport = new InMemoryTransport()
		const handstage = await connectTransport(transport)

		expect(handstage.browserContexts()).toHaveLength(1)

		const ctx = await handstage.createBrowserContext()
		expect(handstage.browserContexts()).toHaveLength(2)

		await ctx.close()
		expect(handstage.browserContexts()).toHaveLength(1)
		expect(handstage.browserContexts()).not.toContain(ctx)

		await handstage.close()
	})

	class DelayedContextConnection extends FakeConnection {
		private startCreate!: () => void
		private finishCreate: (() => void) | null = null
		public readonly createStarted = new Promise<void>((resolve) => {
			this.startCreate = resolve
		})

		override send<M extends CDPCommand>(
			method: M,
			...params: CDPCommandParams<M>
		): Promise<CDPCommandResult<M>> {
			if (method === "Target.createBrowserContext") {
				this.startCreate()
				return new Promise<CDPCommandResult<M>>((resolve) => {
					this.finishCreate = () =>
						resolve({
							browserContextId: "ctx-race",
						} as CDPCommandResult<M>)
				})
			}
			return super.send(method, ...params)
		}

		releaseCreate(): void {
			this.finishCreate?.()
		}
	}

	test("createBrowserContext cannot race with close()", async () => {
		const conn = new DelayedContextConnection()
		const handstage = await connectConnection(conn)

		const creating = handstage.createBrowserContext()
		const outcome = creating.then(
			() => null,
			(error: unknown) => error,
		)
		await conn.createStarted

		const closing = handstage.close()
		conn.releaseCreate()

		const error = await outcome
		expect(error).toBeInstanceOf(Error)
		expect((error as Error).message).toContain("closed")
		await closing
		expect(handstage.browserContexts()).toHaveLength(0)
		expect(
			conn.sent.some(
				(entry) => entry.method === "Target.disposeBrowserContext",
			),
		).toBe(true)
	})

	test("close aborts a blackholed browser-context creation", async () => {
		const conn = new DelayedContextConnection()
		const handstage = await connectConnection(conn)
		const creating = handstage.createBrowserContext()
		const outcome = creating.then(
			() => null,
			(error: unknown) => error,
		)
		await conn.createStarted

		await withTimeout(handstage.close(), 100, "Handstage close")
		const error = await outcome
		expect(error).toBeInstanceOf(CDPConnectionClosedError)

		conn.releaseCreate()
		await waitFor(() =>
			conn.sent.some(
				(entry) => entry.method === "Target.disposeBrowserContext",
			),
		)
	})

	test("creation cancellation removes the signal-aware CDP inflight entry", async () => {
		class BlackholedCreationTransport extends InMemoryTransport {
			override send(message: string): void {
				const request = JSON.parse(message) as { method?: string }
				if (request.method === "Target.createBrowserContext") {
					this.sent.push(message)
					return
				}
				super.send(message)
			}
		}

		const transport = new BlackholedCreationTransport()
		const conn = new CDPConnection(transport)
		const controller = new AbortController()
		const cancellation = new Error("cancel isolated context creation")
		const creating = Context.createIsolatedFromConnection(conn, {
			signal: controller.signal,
		})
		const outcome = creating.then(
			() => null,
			(error: unknown) => error,
		)
		await waitFor(() =>
			transport.sent.some(
				(message) =>
					(JSON.parse(message) as { method?: string }).method ===
					"Target.createBrowserContext",
			),
		)
		const internals = conn as unknown as { inflight: Map<number, unknown> }
		expect(internals.inflight.size).toBe(1)

		controller.abort(cancellation)

		expect(await outcome).toBe(cancellation)
		expect(internals.inflight.size).toBe(0)
		const createRequest = transport.sent
			.map((message) => JSON.parse(message) as { id: number; method?: string })
			.find((request) => request.method === "Target.createBrowserContext")
		if (!createRequest) {
			throw new Error("expected context creation request")
		}
		transport.onmessage?.(
			JSON.stringify({
				id: createRequest.id,
				result: { browserContextId: "late-context" },
			}),
		)
		await waitFor(() =>
			transport.sent.some((message) => {
				const request = JSON.parse(message) as {
					method?: string
					params?: { browserContextId?: string }
				}
				return (
					request.method === "Target.disposeBrowserContext" &&
					request.params?.browserContextId === "late-context"
				)
			}),
		)
		await conn.close()
	})

	test("owned connection cleanup runs after a context close failure", async () => {
		const transport = new InMemoryTransport()
		const handstage = await connectTransport(transport)
		const context = handstage.defaultBrowserContext()
		context.close = async () => {
			throw new Error("context cleanup failed")
		}

		await expect(handstage.close()).rejects.toThrow("context cleanup failed")
		expect(transport.closeCalls).toBe(0)
		await expect(handstage.close({ force: true })).rejects.toThrow(
			"context cleanup failed",
		)
		expect(transport.closeCalls).toBe(1)
		await handstage.close()
	})

	test("successful owned cleanup locally finalizes failed contexts", async () => {
		const conn = new FakeConnection()
		const context = await Context.createDefaultFromConnection(conn)
		const session = new FakeSession("s-force-local-finalize")
		session.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		conn.sessions.set(session.id, session)
		await context.onRouterAttachedToTarget(
			pageTarget("t-force-local-finalize"),
			session.id,
		)
		const page = context.pages()[0]
		if (!page) {
			throw new Error("expected attached page")
		}
		const waitOutcome = page.waitForTimeout(60_000).then(
			() => null,
			(error: unknown) => error,
		)
		const contextCloseError = new Error("context cleanup failed")
		context.close = async () => {
			throw contextCloseError
		}
		let cleanupCalls = 0
		const handstage = createHandstageForConnection({
			connection: conn,
			cleanup: async () => {
				cleanupCalls += 1
				await conn.close()
			},
			defaultContext: context,
			opts: {},
			logSink: () => {},
		})

		const closeError = await handstage.close({ force: true }).then(
			() => null,
			(error: unknown) => error,
		)

		expect(closeError).toBe(contextCloseError)
		expect(cleanupCalls).toBe(1)
		expect(page.isDisposed()).toBe(true)
		expect(context.pages()).toHaveLength(0)
		expect(context.isClosed).toBe(true)
		expect(handstage.browserContexts()).toHaveLength(0)
		expect(
			await withTimeout(waitOutcome, 100, "force-local-finalized page wait"),
		).toBeInstanceOf(CDPConnectionClosedError)
		await handstage.close()
	})

	test("concurrent close callers share the same cleanup", async () => {
		const transport = new InMemoryTransport()
		let finishClose!: () => void
		const closeGate = new Promise<void>((resolve) => {
			finishClose = resolve
		})
		transport.close = async () => {
			transport.closeCalls += 1
			await closeGate
		}
		const handstage = await connectTransport(transport)

		const first = handstage.close()
		let secondFinished = false
		const second = handstage.close().then(() => {
			secondFinished = true
		})
		await sleep(5)
		expect(secondFinished).toBe(false)

		finishClose()
		await Promise.all([first, second])
		expect(transport.closeCalls).toBe(1)
	})
})
