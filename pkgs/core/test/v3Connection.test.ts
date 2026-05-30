import { describe, expect, test } from "bun:test"
import { connectConnection } from "../src/v3/connect/connection"
import { connectTransport } from "../src/v3/connect/transport"
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
