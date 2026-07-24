import { describe, expect, test } from "bun:test"
import { createHandstageForConnection } from "../src/v3/handstage"
import type {
	CDPCommand,
	CDPCommandParams,
	CDPCommandResult,
} from "../src/v3/understudy/cdp"
import { getConnectionResourceManager } from "../src/v3/understudy/connectionResourceManager"
import { Context } from "../src/v3/understudy/context"
import { FakeConnection, FakeSession, pageTarget, waitFor } from "./_fakes"

describe("late Context resource finalization", () => {
	test("a failed late browser-context disposal is retried by close", async () => {
		class LateContextConnection extends FakeConnection {
			private markCreateStarted!: () => void
			private finishCreate: (() => void) | null = null
			readonly createStarted = new Promise<void>((resolve) => {
				this.markCreateStarted = resolve
			})
			disposeCalls = 0

			override send<M extends CDPCommand>(
				method: M,
				...params: CDPCommandParams<M>
			): Promise<CDPCommandResult<M>> {
				if (method === "Target.createBrowserContext") {
					this.sent.push({ method, params: params[0] })
					this.markCreateStarted()
					return new Promise((resolve) => {
						this.finishCreate = () =>
							resolve({ browserContextId: "ctx-late-retry" } as never)
					})
				}
				if (method === "Target.disposeBrowserContext") {
					this.sent.push({ method, params: params[0] })
					this.disposeCalls += 1
					if (this.disposeCalls === 1) {
						return Promise.reject(new Error("late context disposal failed"))
					}
					return Promise.resolve({} as CDPCommandResult<M>)
				}
				return super.send(method, ...params)
			}

			releaseCreate(): void {
				this.finishCreate?.()
			}
		}

		const conn = new LateContextConnection()
		const cleanupContext = await Context.createDefaultFromConnection(conn)
		const controller = new AbortController()
		const cancellation = new Error("cancel late context creation")
		const creating = Context.createIsolatedFromConnection(conn, {
			signal: controller.signal,
		})
		const creationOutcome = creating.then(
			() => null,
			(error: unknown) => error,
		)
		await conn.createStarted

		controller.abort(cancellation)
		expect(await creationOutcome).toBe(cancellation)
		await cleanupContext.close()

		conn.releaseCreate()
		await waitFor(() => conn.disposeCalls === 1)

		const retryContext = await Context.createDefaultFromConnection(conn)
		await retryContext.close()

		expect(conn.disposeCalls).toBe(2)
	})

	test("a failed late target close retains ownership and is retried", async () => {
		class LateTargetConnection extends FakeConnection {
			private markCreateStarted!: () => void
			private finishCreate: (() => void) | null = null
			readonly createStarted = new Promise<void>((resolve) => {
				this.markCreateStarted = resolve
			})
			closeTargetCalls = 0

			override send<M extends CDPCommand>(
				method: M,
				...params: CDPCommandParams<M>
			): Promise<CDPCommandResult<M>> {
				if (method === "Target.createTarget") {
					this.sent.push({ method, params: params[0] })
					this.markCreateStarted()
					return new Promise((resolve) => {
						this.finishCreate = () => {
							this.targets = [pageTarget("target-late-retry")]
							resolve({ targetId: "target-late-retry" } as never)
						}
					})
				}
				if (method === "Target.closeTarget") {
					this.sent.push({ method, params: params[0] })
					this.closeTargetCalls += 1
					if (this.closeTargetCalls === 1) {
						return Promise.reject(new Error("late target close failed"))
					}
					this.targets = []
					return Promise.resolve({ success: true } as CDPCommandResult<M>)
				}
				return super.send(method, ...params)
			}

			releaseCreate(): void {
				this.finishCreate?.()
			}
		}

		const conn = new LateTargetConnection()
		const context = await Context.createDefaultFromConnection(conn)
		const creating = context.newPage()
		const creationOutcome = creating.then(
			() => null,
			(error: unknown) => error,
		)
		await conn.createStarted

		await context.close()
		expect(await creationOutcome).toBeInstanceOf(Error)
		conn.releaseCreate()

		await waitFor(() => conn.closeTargetCalls === 1)

		const retryContext = await Context.createDefaultFromConnection(conn)
		const reattachedSession = new FakeSession("session-late-target-retry")
		reattachedSession.responses.set("Page.getFrameTree", {
			frameTree: { frame: { id: "F0", url: "about:blank" } },
		})
		conn.sessions.set(reattachedSession.id, reattachedSession)
		await retryContext.onRouterAttachedToTarget(
			pageTarget("target-late-retry"),
			reattachedSession.id,
		)
		await retryContext.close()

		expect(conn.closeTargetCalls).toBe(2)
	})
})

describe("Handstage close escalation", () => {
	test("forcing one shared client preserves sibling late-target retries", async () => {
		class SharedRetryConnection extends FakeConnection {
			closeTargetCalls = 0

			override send<M extends CDPCommand>(
				method: M,
				...params: CDPCommandParams<M>
			): Promise<CDPCommandResult<M>> {
				if (method === "Target.closeTarget") {
					this.closeTargetCalls += 1
					this.targets = []
					return Promise.resolve({ success: true } as CDPCommandResult<M>)
				}
				return super.send(method, ...params)
			}
		}

		const conn = new SharedRetryConnection()
		conn.targets = [pageTarget("target-shared-retry")]
		const firstContext = await Context.createDefaultFromConnection(conn)
		const secondContext = await Context.createDefaultFromConnection(conn)
		getConnectionResourceManager(conn).rememberTarget("target-shared-retry")
		firstContext.close = async () => {
			throw new Error("first context close failed")
		}
		const first = createHandstageForConnection({
			connection: conn,
			defaultContext: firstContext,
			opts: {},
			logSink: () => {},
		})

		await expect(first.close({ force: true })).rejects.toThrow(
			"first context close failed",
		)
		await secondContext.close()
		expect(conn.closeTargetCalls).toBe(1)
	})

	test("a concurrent force caller escalates the active close wave", async () => {
		const conn = new FakeConnection()
		const context = await Context.createDefaultFromConnection(conn)
		const contextCloseError = new Error("context cleanup failed")
		let markContextCloseStarted!: () => void
		const contextCloseStarted = new Promise<void>((resolve) => {
			markContextCloseStarted = resolve
		})
		let releaseContextClose!: () => void
		const contextCloseGate = new Promise<void>((resolve) => {
			releaseContextClose = resolve
		})
		context.close = async () => {
			markContextCloseStarted()
			await contextCloseGate
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

		const firstOutcome = handstage.close().then(
			() => null,
			(error: unknown) => error,
		)
		await contextCloseStarted
		const forcedOutcome = handstage.close({ force: true }).then(
			() => null,
			(error: unknown) => error,
		)
		releaseContextClose()

		const [firstError, forcedError] = await Promise.all([
			firstOutcome,
			forcedOutcome,
		])
		expect(firstError).toBe(contextCloseError)
		expect(forcedError).toBe(contextCloseError)
		expect(cleanupCalls).toBe(1)
		expect(conn.closeCalls).toBe(1)
		expect(handstage.browserContexts()).toHaveLength(0)
	})
})
