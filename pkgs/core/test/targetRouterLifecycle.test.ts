/**
 * Regression tests for TargetRouter resource lifecycle behavior.
 */
import { describe, expect, test } from "bun:test"
import {
	getTargetRouter,
	type TargetRouterDelegate,
} from "../src/v3/understudy/targetRouter"
import {
	attachedEvent,
	FakeConnection,
	FakeSession,
	pageTarget,
	waitFor,
} from "./_fakes"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("TargetRouter.register rollback", () => {
	class FailingAutoAttachConnection extends FakeConnection {
		public failuresRemaining = 1
		override async enableAutoAttach(): Promise<void> {
			if (this.failuresRemaining > 0) {
				this.failuresRemaining -= 1
				throw new Error("autoattach-fail")
			}
			await super.enableAutoAttach()
		}
	}

	test("failed start unregisters the delegate", async () => {
		const conn = new FailingAutoAttachConnection()
		const router = getTargetRouter(conn)

		let claimAttempts = 0
		const delegate: TargetRouterDelegate = {
			canClaimTarget: () => {
				claimAttempts += 1
				return false
			},
			onRouterAttachedToTarget: () => {},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
		}

		await expect(router.register(delegate)).rejects.toThrow("autoattach-fail")

		// The delegate must not receive events after the failed registration.
		const session = new FakeSession("s-rollback")
		conn.sessions.set(session.id, session)
		conn.emit(
			"Target.attachedToTarget",
			attachedEvent(session.id, pageTarget("t-rollback")),
		)
		await sleep(20)
		expect(claimAttempts).toBe(0)
		expect(
			conn.sent.some(
				(entry) =>
					entry.method === "Target.detachFromTarget" &&
					(entry.params as { sessionId: string }).sessionId === session.id,
			),
		).toBe(true)

		// A later register succeeds and routing resumes.
		const unregister = await router.register(delegate)
		conn.emit(
			"Target.attachedToTarget",
			attachedEvent(session.id, pageTarget("t-rollback-2")),
		)
		await sleep(20)
		expect(claimAttempts).toBeGreaterThan(0)
		unregister()
	})

	test("connection close retires the router and releases delegates", async () => {
		const conn = new FakeConnection()
		const router = getTargetRouter(conn)
		const delegate: TargetRouterDelegate = {
			canClaimTarget: () => false,
			onRouterAttachedToTarget: () => {},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
		}
		await router.register(delegate)

		conn.emitTransportClosed()

		const internals = router as unknown as {
			delegates: TargetRouterDelegate[]
			loggers: Map<TargetRouterDelegate, unknown>
		}
		expect(internals.delegates).toHaveLength(0)
		expect(internals.loggers.size).toBe(0)
		await expect(router.register(delegate)).rejects.toThrow("closed")
	})

	test("unregister during ownership lookup resumes the target", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-router-race")
		conn.sessions.set(session.id, session)
		const router = getTargetRouter(conn)
		let finishClaim!: (claimed: boolean) => void
		const claim = new Promise<boolean>((resolve) => {
			finishClaim = resolve
		})
		let attached = false
		const delegate: TargetRouterDelegate = {
			canClaimTarget: () => claim,
			onRouterAttachedToTarget: () => {
				attached = true
			},
			onRouterDetachedFromTarget: () => {},
			onRouterTargetDestroyed: () => {},
		}
		const unregister = await router.register(delegate)

		conn.emit(
			"Target.attachedToTarget",
			attachedEvent(session.id, pageTarget("t-router-race")),
		)
		unregister()
		finishClaim(true)

		await waitFor(() =>
			conn.sent.some(
				(entry) =>
					entry.method === "Target.detachFromTarget" &&
					(entry.params as { sessionId: string }).sessionId === session.id,
			),
		)
		expect(attached).toBe(false)
	})

	test("detach events recover targetId from router ownership", async () => {
		const conn = new FakeConnection()
		const session = new FakeSession("s-router-detach-id")
		conn.sessions.set(session.id, session)
		const router = getTargetRouter(conn)
		let detachedTargetId: string | null = null
		let attached = false
		const delegate: TargetRouterDelegate = {
			canClaimTarget: () => true,
			onRouterAttachedToTarget: () => {
				attached = true
			},
			onRouterDetachedFromTarget: (_sessionId, targetId) => {
				detachedTargetId = targetId
			},
			onRouterTargetDestroyed: () => {},
		}
		const unregister = await router.register(delegate)
		conn.emit(
			"Target.attachedToTarget",
			attachedEvent(session.id, pageTarget("t-router-detach-id")),
		)
		await waitFor(() => attached)

		conn.emit("Target.detachedFromTarget", { sessionId: session.id })

		expect(detachedTargetId).toBe("t-router-detach-id")
		unregister()
	})
})
