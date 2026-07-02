import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
	registerBrowserForCleanup,
	supervisedCount,
	supervisorInstalled,
} from "../src/launch/exitSupervisor"
import {
	performBrowserProcessCleanup,
	waitForProcessExit,
} from "../src/launch/utils"
import { connectWS } from "../src/v3/connect/ws"
import { CDPConnectionClosedError } from "../src/v3/types/public/sdkErrors"
import type {
	CDPCommand,
	CDPCommandParams,
	CDPCommandResult,
	CDPEvent,
	CDPEventParams,
	CDPSessionLike,
	CDPTransport,
} from "../src/v3/understudy/cdp"
import { CDPConnection } from "../src/v3/understudy/cdp"
import { executionContexts } from "../src/v3/understudy/executionContextRegistry"
import { Frame } from "../src/v3/understudy/frame"
import { Page } from "../src/v3/understudy/page"
import type { Response } from "../src/v3/understudy/response"
import { FrameSelectorResolver } from "../src/v3/understudy/selectorResolver"
import { FakeConnection } from "./_fakes"

/**
 * A CDPSessionLike that records outgoing calls, lets tests script responses,
 * and can synchronously dispatch events to registered handlers.
 */
class RecordingSession implements CDPSessionLike {
	public sent: Array<{ method: string; params?: unknown }> = []
	public released: string[] = []
	public responder?: (method: string, params: unknown) => unknown
	private readonly handlers = new Map<string, Set<(p: unknown) => void>>()

	constructor(public readonly id: string) {}

	send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		const p = params[0]
		this.sent.push({ method, params: p })
		if (method === "Runtime.releaseObject") {
			this.released.push((p as { objectId: string }).objectId)
		}
		const custom = this.responder?.(method, p)
		if (custom !== undefined) {
			return Promise.resolve(custom as CDPCommandResult<M>)
		}
		return Promise.resolve({} as CDPCommandResult<M>)
	}

	on<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		let set = this.handlers.get(event)
		if (!set) {
			set = new Set()
			this.handlers.set(event, set)
		}
		set.add(handler as (p: unknown) => void)
	}

	off<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		this.handlers.get(event)?.delete(handler as (p: unknown) => void)
	}

	async close(): Promise<void> {}

	emit(event: string, params: unknown): void {
		for (const h of [...(this.handlers.get(event) ?? [])]) h(params)
	}

	listenerCount(event: string): number {
		return this.handlers.get(event)?.size ?? 0
	}
}

/**
 * Transport whose `close()` deliberately does NOT invoke `onclose` — mirroring
 * the real local Chrome pipe on a graceful close. `send()` never replies, so
 * requests stay in-flight until the connection settles them itself.
 */
class SilentTransport implements CDPTransport {
	public closeCalls = 0
	public onmessage?: (message: string) => void
	public onclose?: (reason: string) => void
	public onerror?: (error: Error) => void

	send(_message: string): void {}

	close(): void {
		this.closeCalls += 1
		// Intentionally silent: no onclose(). This is the exact scenario that
		// previously left inflight promises hanging forever.
	}
}

async function makePage(session: RecordingSession): Promise<Page> {
	session.responder = (method) => {
		if (method === "Page.getFrameTree") {
			return { frameTree: { frame: { id: "main-frame" } } }
		}
		return undefined
	}
	const conn = new FakeConnection()
	return Page.create(
		conn as unknown as never,
		session,
		"target-1",
		null,
		undefined,
	)
}

describe("resource cleanup: CDPConnection.close (Task 1/2)", () => {
	test("close settles in-flight requests even when transport.onclose never fires", async () => {
		const transport = new SilentTransport()
		const conn = new CDPConnection(transport)

		const pending = conn.send("Runtime.evaluate", { expression: "1+1" })
		conn.on("Target.attachedToTarget", () => {})
		conn._onSessionEvent("sess-a", "Network.responseReceived", () => {})

		const internals = conn as unknown as {
			inflight: Map<number, unknown>
			eventHandlers: Map<string, unknown>
			sessions: Map<string, unknown>
			sessionToTarget: Map<string, unknown>
			transportCloseHandlers: Set<unknown>
		}
		expect(internals.inflight.size).toBe(1)
		expect(internals.eventHandlers.size).toBe(2)

		await conn.close()

		await expect(pending).rejects.toBeInstanceOf(CDPConnectionClosedError)
		expect(internals.inflight.size).toBe(0)
		expect(internals.eventHandlers.size).toBe(0)
		expect(internals.sessions.size).toBe(0)
		expect(internals.sessionToTarget.size).toBe(0)
		expect(internals.transportCloseHandlers.size).toBe(0)
		expect(transport.closeCalls).toBe(1)
	})

	test("close is idempotent and a later onclose does not throw", async () => {
		const transport = new SilentTransport()
		const conn = new CDPConnection(transport)
		const pending = conn.send("Runtime.evaluate", { expression: "1" })
		await conn.close()
		await expect(pending).rejects.toBeInstanceOf(CDPConnectionClosedError)
		// Simulate a racing/late transport close notification.
		expect(() => transport.onclose?.("late")).not.toThrow()
		await conn.close()
	})
})

describe("resource cleanup: session handler pruning on detach (Task 5)", () => {
	test("Target.detachedFromTarget drops session-scoped handler buckets", () => {
		const transport = new SilentTransport()
		const conn = new CDPConnection(transport)
		const sid = "sess-detach"

		conn._onSessionEvent(sid, "Network.responseReceived", () => {})
		conn._onSessionEvent(sid, "Page.loadEventFired", () => {})
		conn.on("Target.attachedToTarget", () => {}) // root handler, must survive

		const internals = conn as unknown as {
			eventHandlers: Map<string, unknown>
		}
		expect(internals.eventHandlers.has(`${sid}:Network.responseReceived`)).toBe(
			true,
		)

		transport.onmessage?.(
			JSON.stringify({
				method: "Target.detachedFromTarget",
				params: { sessionId: sid, targetId: "t-detach" },
			}),
		)

		expect(internals.eventHandlers.has(`${sid}:Network.responseReceived`)).toBe(
			false,
		)
		expect(internals.eventHandlers.has(`${sid}:Page.loadEventFired`)).toBe(
			false,
		)
		// Root handler untouched.
		expect(internals.eventHandlers.has("Target.attachedToTarget")).toBe(true)
	})
})

describe("resource cleanup: isolated world caching (Task 3)", () => {
	test("createIsolatedWorld runs once and is recreated after contexts clear", async () => {
		const session = new RecordingSession("s-iso")
		let seq = 0
		session.responder = (method) =>
			method === "Page.createIsolatedWorld"
				? { executionContextId: ++seq }
				: undefined
		executionContexts.attachSession(session)

		const a = await executionContexts.getIsolatedWorld(
			session,
			"f1",
			"v3-world",
		)
		const b = await executionContexts.getIsolatedWorld(
			session,
			"f1",
			"v3-world",
		)
		expect(a).toBe(b)
		const createdOnce = session.sent.filter(
			(s) => s.method === "Page.createIsolatedWorld",
		).length
		expect(createdOnce).toBe(1)

		// Navigation clears contexts → next call must recreate.
		session.emit("Runtime.executionContextsCleared", {})
		const c = await executionContexts.getIsolatedWorld(
			session,
			"f1",
			"v3-world",
		)
		expect(c).not.toBe(a)
		const createdTwice = session.sent.filter(
			(s) => s.method === "Page.createIsolatedWorld",
		).length
		expect(createdTwice).toBe(2)
	})

	test("executionContextDestroyed evicts the matching isolated world", async () => {
		const session = new RecordingSession("s-iso-2")
		let seq = 10
		session.responder = (method) =>
			method === "Page.createIsolatedWorld"
				? { executionContextId: ++seq }
				: undefined
		executionContexts.attachSession(session)

		const a = await executionContexts.getIsolatedWorld(
			session,
			"f2",
			"v3-world",
		)
		session.emit("Runtime.executionContextDestroyed", {
			executionContextId: a,
		})
		const b = await executionContexts.getIsolatedWorld(
			session,
			"f2",
			"v3-world",
		)
		expect(b).not.toBe(a)
	})
})

describe("resource cleanup: locator nth() releases handles (Task 4)", () => {
	test("resolveAtIndex releases the intermediate remote objects", async () => {
		const session = new RecordingSession("s-nth")
		let objSeq = 0
		session.responder = (method) => {
			if (method === "Runtime.evaluate") {
				return { result: { objectId: `obj-${objSeq++}` } }
			}
			return undefined
		}
		// Seed the main world so waitForMainWorld resolves immediately.
		executionContexts.attachSession(session)
		session.emit("Runtime.executionContextCreated", {
			context: { id: 77, auxData: { isDefault: true, frameId: "frame-nth" } },
		})

		const frame = new Frame(session, "frame-nth", "page-nth", false)
		const resolver = new FrameSelectorResolver(frame)
		const query = FrameSelectorResolver.parseSelector("text=hello")

		const resolved = await resolver.resolveAtIndex(query, 2)
		expect(resolved?.objectId).toBe("obj-2")
		// obj-0 and obj-1 were resolved but not returned → must be released.
		expect(session.released).toContain("obj-0")
		expect(session.released).toContain("obj-1")
		expect(session.released).not.toContain("obj-2")
	})
})

describe("resource cleanup: Page.frameOrdinals pruning (Task 7)", () => {
	test("ordinals are dropped on detach and cleared on dispose", async () => {
		const session = new RecordingSession("s-page")
		const page = await makePage(session)

		page.getOrdinal("frame-a")
		page.getOrdinal("frame-b")
		const internals = page as unknown as {
			frameOrdinals: Map<string, number>
		}
		expect(internals.frameOrdinals.has("frame-a")).toBe(true)

		page.onFrameDetached("frame-a", "remove")
		expect(internals.frameOrdinals.has("frame-a")).toBe(false)
		// swap keeps identity continuity
		page.onFrameDetached("frame-b", "swap")
		expect(internals.frameOrdinals.has("frame-b")).toBe(true)

		page.disposeResources()
		expect(internals.frameOrdinals.size).toBe(0)
	})
})

describe("resource cleanup: Response.finished watcher (Task 8)", () => {
	function fakeResponse() {
		const calls: Array<Error | null> = []
		const resp = {
			calls,
			markFinished(err: Error | null) {
				calls.push(err)
			},
		}
		return resp as unknown as Response & { calls: Array<Error | null> }
	}

	test("finished resolves on loadingFinished and removes its listener", async () => {
		const session = new RecordingSession("s-fin")
		const page = await makePage(session)
		const resp = fakeResponse()

		// NetworkManager also listens on the session, so assert the delta added
		// (and removed) by the response-finish watcher rather than an absolute.
		const baseFinished = session.listenerCount("Network.loadingFinished")
		const baseFailed = session.listenerCount("Network.loadingFailed")

		page.watchResponseFinish(session, "req-1", resp)
		expect(session.listenerCount("Network.loadingFinished")).toBe(
			baseFinished + 1,
		)

		session.emit("Network.loadingFinished", { requestId: "req-1" })
		expect(resp.calls).toEqual([null])
		expect(session.listenerCount("Network.loadingFinished")).toBe(baseFinished)
		expect(session.listenerCount("Network.loadingFailed")).toBe(baseFailed)
	})

	test("loadingFailed resolves finished with an error", async () => {
		const session = new RecordingSession("s-fin-2")
		const page = await makePage(session)
		const resp = fakeResponse()

		page.watchResponseFinish(session, "req-2", resp)
		session.emit("Network.loadingFailed", {
			requestId: "req-2",
			errorText: "net::ERR_ABORTED",
		})
		expect(resp.calls.length).toBe(1)
		expect(resp.calls[0]).toBeInstanceOf(Error)
	})

	test("disposeResources finalizes pending watchers (no hang, no leak)", async () => {
		const session = new RecordingSession("s-fin-3")
		const page = await makePage(session)
		const resp = fakeResponse()

		const baseFinished = session.listenerCount("Network.loadingFinished")
		page.watchResponseFinish(session, "req-3", resp)
		expect(session.listenerCount("Network.loadingFinished")).toBe(
			baseFinished + 1,
		)

		page.disposeResources()
		// finished() is resolved (with null) so awaiters never hang…
		expect(resp.calls).toEqual([null])
		// …and every CDP listener is removed (both the watcher's and the
		// NetworkManager's, which disposeResources also tears down).
		expect(session.listenerCount("Network.loadingFinished")).toBe(0)
		expect(session.listenerCount("Network.loadingFailed")).toBe(0)
	})
})

/** Minimal WebSocket stand-in that records listeners and auto-answers CDP calls. */
class FakeWebSocket {
	public closed = false
	public readonly listeners = new Map<string, Set<(ev: unknown) => void>>()

	addEventListener(type: string, cb: (ev: unknown) => void): void {
		let set = this.listeners.get(type)
		if (!set) {
			set = new Set()
			this.listeners.set(type, set)
		}
		set.add(cb)
	}

	removeEventListener(type: string, cb: (ev: unknown) => void): void {
		this.listeners.get(type)?.delete(cb)
	}

	send(message: string): void {
		let parsed: { id?: number; method?: string } | null = null
		try {
			parsed = JSON.parse(message)
		} catch {
			return
		}
		if (!parsed || typeof parsed.id !== "number") return
		const result =
			parsed.method === "Target.getTargets" ? { targetInfos: [] } : {}
		const payload = JSON.stringify({ id: parsed.id, result })
		queueMicrotask(() => this.dispatch("message", { data: payload }))
	}

	close(): void {
		this.closed = true
	}

	private dispatch(type: string, ev: unknown): void {
		for (const cb of [...(this.listeners.get(type) ?? [])]) cb(ev)
	}

	count(type: string): number {
		return this.listeners.get(type)?.size ?? 0
	}
}

describe("resource cleanup: WebSocket listeners removed on close (Task 6)", () => {
	test("connectWS transport.close removes message/close/error listeners", async () => {
		const ws = new FakeWebSocket()
		const handstage = await connectWS(ws as unknown as WebSocket)
		expect(ws.count("message")).toBe(1)
		expect(ws.count("close")).toBe(1)
		expect(ws.count("error")).toBe(1)

		await handstage.close()

		expect(ws.closed).toBe(true)
		expect(ws.count("message")).toBe(0)
		expect(ws.count("close")).toBe(0)
		expect(ws.count("error")).toBe(0)
	})
})

describe("resource cleanup: process exit wait + cleanup (Task 12)", () => {
	test("waitForProcessExit resolves true immediately when process exited", async () => {
		const start = Date.now()
		const result = await waitForProcessExit(Promise.resolve(), 5000)
		expect(result).toBe(true)
		// Must not block on the timeout; a cleared timer keeps the loop free.
		expect(Date.now() - start).toBeLessThan(500)
	})

	test("waitForProcessExit returns false on timeout", async () => {
		const never = new Promise(() => {})
		const result = await waitForProcessExit(never, 20)
		expect(result).toBe(false)
	})

	test("performBrowserProcessCleanup removes temp dir even when kill throws", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handstage-test-kill-"))
		expect(fs.existsSync(dir)).toBe(true)

		await performBrowserProcessCleanup(
			() => {
				throw new Error("kill boom")
			},
			Promise.resolve(),
			dir,
			true,
		)

		expect(fs.existsSync(dir)).toBe(false)
	})
})

describe("resource cleanup: crash-supervisor lifecycle (Task 9)", () => {
	test("register/deregister installs and removes global listeners", () => {
		const baseExit = process.listenerCount("exit")
		expect(supervisorInstalled()).toBe(false)

		const d1 = registerBrowserForCleanup({ createdTemp: false })
		expect(supervisedCount()).toBe(1)
		expect(supervisorInstalled()).toBe(true)
		expect(process.listenerCount("exit")).toBe(baseExit + 1)

		const d2 = registerBrowserForCleanup({ createdTemp: false })
		expect(supervisedCount()).toBe(2)

		d1()
		expect(supervisorInstalled()).toBe(true) // still one registered
		d2()
		expect(supervisedCount()).toBe(0)
		expect(supervisorInstalled()).toBe(false)
		// No leaked global listeners across the cycle.
		expect(process.listenerCount("exit")).toBe(baseExit)

		// Disposer is idempotent.
		expect(() => d1()).not.toThrow()
	})

	test("exit handler kills the pid and removes the temp dir", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handstage-test-sup-"))
		const killed: Array<[number, string | number | undefined]> = []
		const originalKill = process.kill.bind(process)
		// biome-ignore lint/suspicious/noExplicitAny: test monkeypatch
		;(process as any).kill = (pid: number, sig?: string | number) => {
			killed.push([pid, sig])
			return true
		}

		const before = new Set(process.listeners("exit"))
		const dispose = registerBrowserForCleanup({
			pid: 999999,
			userDataDir: dir,
			createdTemp: true,
		})
		try {
			const added = process
				.listeners("exit")
				.filter((l) => !before.has(l)) as Array<() => void>
			expect(added.length).toBe(1)

			// Invoke our exit handler as Node would on process exit.
			added[0]?.()

			expect(killed).toContainEqual([999999, "SIGKILL"])
			expect(fs.existsSync(dir)).toBe(false)
		} finally {
			// biome-ignore lint/suspicious/noExplicitAny: restore
			;(process as any).kill = originalKill
			dispose()
			if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
		}
	})
})
