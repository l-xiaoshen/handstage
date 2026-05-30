import { describe, expect, test } from "bun:test"
import { connectConnection } from "../src/v3/connect/connection"
import { connectLocal } from "../src/v3/connect/local"
import { connectTransport } from "../src/v3/connect/transport"
import type { LaunchedChrome } from "../src/v3/types/public/launchedChrome"
import { LogLevel } from "../src/v3/types/public/logs"
import { HandstageTransportAlreadyOwnedError } from "../src/v3/types/public/sdkErrors"
import { CDPConnection } from "../src/v3/understudy/cdp"
import { getTargetRouter } from "../src/v3/understudy/targetRouter"
import { V3 } from "../src/v3/v3"
import {
	FakeConnection,
	FakeSession,
	InMemoryTransport,
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

	constructor() {
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
		try {
			this.stdoutController.close()
		} catch {}
	}

	private flushRequests(): void {
		let frameStart = 0

		while (true) {
			const frameEnd = this.requestBuffer.indexOf("\0", frameStart)
			if (frameEnd === -1) break

			const raw = this.requestBuffer.slice(frameStart, frameEnd)
			frameStart = frameEnd + 1
			if (raw) this.replyTo(raw)
		}

		if (frameStart > 0) {
			this.requestBuffer = this.requestBuffer.slice(frameStart)
		}
	}

	private replyTo(raw: string): void {
		const request = JSON.parse(raw) as { id?: number; method?: string }
		if (typeof request.id !== "number") return

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

		this.stdoutController.enqueue(this.encoder.encode(payload.slice(0, splitAt)))
		queueMicrotask(() => {
			try {
				this.stdoutController.enqueue(this.encoder.encode(payload.slice(splitAt)))
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
})

describe("V3 connection lifecycle", () => {
	test("connection factories live outside the V3 class", () => {
		expect((V3 as unknown as Record<string, unknown>).connectTransport).toBe(
			undefined,
		)
	})

	test("connectTransport twice with the same transport is rejected", async () => {
		const transport = new InMemoryTransport()
		const first = await connectTransport(transport)
		await expect(connectTransport(transport)).rejects.toBeInstanceOf(
			HandstageTransportAlreadyOwnedError,
		)
		await first.close()
	})

	test("V3.close calls transport.close exactly once when V3 owns it", async () => {
		const transport = new InMemoryTransport()
		const v3 = await connectTransport(transport)
		expect(transport.closeCalls).toBe(0)
		await v3.close()
		expect(transport.closeCalls).toBe(1)
	})

	test("connectLocal parses split and coalesced pipe messages", async () => {
		const chrome = new SplitResponsePipeChrome()
		const v3 = await connectLocal(chrome, {
			localBrowserLaunchOptions: { acceptDownloads: true },
		})

		expect(chrome.sentMethods).toContain("Target.setAutoAttach")
		expect(chrome.sentMethods).toContain("Target.getTargets")
		expect(chrome.sentMethods).toContain("Browser.setDownloadBehavior")

		await v3.close()
		expect(chrome.closeCalls).toBe(1)
	})

	test("connectConnection does not close the shared connection", async () => {
		const conn = new FakeConnection()
		const v3 = await connectConnection(conn)
		const before = conn.closeCalls
		await v3.close()
		expect(conn.closeCalls).toBe(before)
		expect(conn.closed).toBe(false)
	})

	test("two V3s on a shared connection each receive their own router-level logs", async () => {
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
		const throwingDelegate = {
			canClaimTarget: () => {
				throw new Error("boom-shared")
			},
			onRouterAttachedToTarget: () => {},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
		}
		// Insert at the front so it definitely gets called before a/b return true
		;(router as any).delegates.unshift(throwingDelegate)
		if ((router as any).loggers) {
			;(router as any).loggers.set(throwingDelegate, () => {})
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
