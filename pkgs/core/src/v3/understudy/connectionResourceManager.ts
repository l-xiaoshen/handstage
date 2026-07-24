import {
	CDPConnectionClosedError,
	TimeoutError,
} from "../types/public/sdkErrors"
import { raceAgainstSignal } from "./abortUtils"
import { type CDPConnectionLike, sendCDPWithSignal } from "./cdp"
import { isMissingBrowserContextError } from "./protocolError"
import { closeTargetAndConfirm } from "./targetLifecycle"

const RESOURCE_CLEANUP_TIMEOUT_MS = 2000

class RetryableCleanupRegistry<Id extends string> {
	private readonly ids = new Set<Id>()
	private readonly operations = new Map<Id, Promise<void>>()

	public get size(): number {
		return this.ids.size
	}

	public values(): Id[] {
		return [...this.ids]
	}

	public remember(id: Id): void {
		this.ids.delete(id)
		this.ids.add(id)
	}

	public forget(id: Id): void {
		this.ids.delete(id)
	}

	public run(id: Id, cleanup: () => Promise<void>): Promise<void> {
		this.remember(id)
		const existing = this.operations.get(id)
		if (existing) {
			return existing
		}

		const operation = Promise.resolve()
			.then(cleanup)
			.then(
				() => {
					this.ids.delete(id)
					this.operations.delete(id)
				},
				(error: unknown) => {
					this.remember(id)
					this.operations.delete(id)
					throw error
				},
			)
		this.operations.set(id, operation)
		return operation
	}
}

export type DefaultTargetOwner = symbol

export class ConnectionResourceManager {
	private readonly browserContexts = new RetryableCleanupRegistry<string>()
	private readonly targets = new RetryableCleanupRegistry<string>()
	private readonly defaultTargetOwners = new Map<string, DefaultTargetOwner>()
	private readonly pendingDefaultTargetCreations = new Set<Promise<void>>()

	constructor(private readonly connection: CDPConnectionLike) {}

	public get lateBrowserContextCount(): number {
		return this.browserContexts.size
	}

	public get lateTargetCount(): number {
		return this.targets.size
	}

	public lateBrowserContextIds(): string[] {
		return this.browserContexts.values()
	}

	public lateTargetIds(): string[] {
		return this.targets.values()
	}

	public rememberBrowserContext(browserContextId: string): void {
		this.browserContexts.remember(browserContextId)
	}

	public rememberTarget(targetId: string): void {
		this.targets.remember(targetId)
	}

	public forgetTarget(targetId: string): void {
		this.targets.forget(targetId)
	}

	public cleanupBrowserContext(browserContextId: string): Promise<void> {
		return this.browserContexts.run(browserContextId, () =>
			this.disposeBrowserContext(browserContextId),
		)
	}

	public cleanupTarget(targetId: string): Promise<void> {
		return this.targets.run(targetId, () =>
			closeTargetAndConfirm(this.connection, targetId, {
				timeoutMs: RESOURCE_CLEANUP_TIMEOUT_MS,
			}),
		)
	}

	public beginDefaultTargetCreation(): () => void {
		let finish!: () => void
		const pending = new Promise<void>((resolve) => {
			finish = resolve
		})
		let finished = false
		this.pendingDefaultTargetCreations.add(pending)

		return () => {
			if (finished) {
				return
			}
			finished = true
			this.pendingDefaultTargetCreations.delete(pending)
			finish()
		}
	}

	public claimDefaultTarget(targetId: string, owner: DefaultTargetOwner): void {
		this.defaultTargetOwners.set(targetId, owner)
	}

	public releaseDefaultTarget(
		targetId: string,
		owner: DefaultTargetOwner,
	): void {
		if (this.defaultTargetOwners.get(targetId) === owner) {
			this.defaultTargetOwners.delete(targetId)
		}
	}

	public releaseDefaultTargets(owner: DefaultTargetOwner): void {
		for (const [targetId, currentOwner] of this.defaultTargetOwners) {
			if (currentOwner === owner) {
				this.defaultTargetOwners.delete(targetId)
			}
		}
	}

	public async waitForDefaultTargetOwner(
		targetId: string,
		signal: AbortSignal,
	): Promise<DefaultTargetOwner | undefined> {
		let owner = this.defaultTargetOwners.get(targetId)
		while (!owner && this.pendingDefaultTargetCreations.size > 0) {
			await raceAgainstSignal(
				Promise.race([...this.pendingDefaultTargetCreations]),
				signal,
				"Default target ownership wait aborted",
			)
			owner = this.defaultTargetOwners.get(targetId)
		}
		return owner
	}

	private async disposeBrowserContext(browserContextId: string): Promise<void> {
		const controller = new AbortController()
		const timer = setTimeout(
			() =>
				controller.abort(
					new TimeoutError(
						"Target.disposeBrowserContext",
						RESOURCE_CLEANUP_TIMEOUT_MS,
					),
				),
			RESOURCE_CLEANUP_TIMEOUT_MS,
		)
		try {
			await sendCDPWithSignal(
				this.connection,
				"Target.disposeBrowserContext",
				controller.signal,
				{ browserContextId },
			)
		} catch (error) {
			if (
				error instanceof CDPConnectionClosedError ||
				isMissingBrowserContextError(error)
			) {
				return
			}
			throw error
		} finally {
			clearTimeout(timer)
		}
	}
}

const managers = new WeakMap<CDPConnectionLike, ConnectionResourceManager>()

export function getConnectionResourceManager(
	connection: CDPConnectionLike,
): ConnectionResourceManager {
	let manager = managers.get(connection)
	if (!manager) {
		manager = new ConnectionResourceManager(connection)
		managers.set(connection, manager)
	}
	return manager
}
