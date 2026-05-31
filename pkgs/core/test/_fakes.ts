import type { Protocol } from "devtools-protocol"
import type {
	CDPCommand,
	CDPCommandParams,
	CDPCommandResult,
	CDPConnectionLike,
	CDPEvent,
	CDPEventParams,
	CDPSessionLike,
	CDPTransport,
} from "../src/v3/understudy/cdp"

type Handler = (params: unknown) => void

/** Minimal in-memory `CDPSessionLike` for unit tests. */
export class FakeSession implements CDPSessionLike {
	public sent: Array<{ method: string; params?: unknown }> = []
	private handlers = new Map<string, Set<Handler>>()

	constructor(public readonly id: string) {}

	send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		this.sent.push({ method, params: params[0] })
		return Promise.resolve({} as CDPCommandResult<M>)
	}

	on<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		const set = this.handlers.get(event) ?? new Set<Handler>()
		set.add(handler as Handler)
		this.handlers.set(event, set)
	}

	off<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		this.handlers.get(event)?.delete(handler as Handler)
	}

	async close(): Promise<void> {}
}

/**
 * Minimal in-memory `CDPConnectionLike` for unit tests.
 *
 * Each test should construct a fresh instance; the connection is **not**
 * keyed by transport identity (no shared global registry).  Use
 * {@link FakeConnection.emit} to inject events; inspect {@link FakeConnection.sent}
 * to verify outgoing CDP calls.
 */
export class FakeConnection implements CDPConnectionLike {
	public readonly id: string | null = null
	public sent: Array<{ method: string; params?: unknown }> = []
	public autoAttachCalls = 0
	public closed = false
	public closeCalls = 0
	public sessions = new Map<string, FakeSession>()
	public nonDefaultContextIds: string[] = []
	public targets: Protocol.Target.TargetInfo[] = []
	private handlers = new Map<string, Set<Handler>>()

	send<M extends CDPCommand>(
		method: M,
		...params: CDPCommandParams<M>
	): Promise<CDPCommandResult<M>> {
		const requestParams = params[0]
		this.sent.push({ method, params: requestParams })
		if (method === "Target.getBrowserContexts") {
			return Promise.resolve({
				browserContextIds: this.nonDefaultContextIds,
			} as CDPCommandResult<M>)
		}
		if (method === "Target.getTargets") {
			return Promise.resolve({
				targetInfos: this.targets,
			} as CDPCommandResult<M>)
		}
		if (method === "Target.createBrowserContext") {
			const browserContextId = `ctx-${this.sent.length}`
			return Promise.resolve({ browserContextId } as CDPCommandResult<M>)
		}
		if (method === "Target.createTarget") {
			const targetId = `tgt-${this.sent.length}`
			return Promise.resolve({ targetId } as CDPCommandResult<M>)
		}
		return Promise.resolve({} as CDPCommandResult<M>)
	}

	on<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		const set = this.handlers.get(event) ?? new Set<Handler>()
		set.add(handler as Handler)
		this.handlers.set(event, set)
	}

	off<E extends CDPEvent>(
		event: E,
		handler: (params: CDPEventParams<E>) => void,
	): void {
		this.handlers.get(event)?.delete(handler as Handler)
	}

	async close(): Promise<void> {
		this.closeCalls += 1
		this.closed = true
	}

	getSession(sessionId: string): CDPSessionLike | undefined {
		return this.sessions.get(sessionId)
	}

	async enableAutoAttach(): Promise<void> {
		this.autoAttachCalls += 1
	}

	async attachToTarget(targetId: string): Promise<CDPSessionLike> {
		const sessionId = `session-${targetId}`
		const session = new FakeSession(sessionId)
		this.sessions.set(sessionId, session)
		return session
	}

	async getTargets(): Promise<Protocol.Target.TargetInfo[]> {
		return this.targets
	}

	onTransportClosed(): void {}
	offTransportClosed(): void {}

	waitForSessionDispatch<M extends CDPCommand>(
		_sessionId: string,
		_method: M,
		..._params: CDPCommandParams<M>
	): Promise<void> {
		return Promise.resolve()
	}

	emit(event: string, params: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) {
			handler(params)
		}
	}
}

export function pageTarget(
	targetId: string,
	browserContextId?: string,
): Protocol.Target.TargetInfo {
	return {
		targetId,
		type: "page",
		title: "",
		url: "about:blank",
		attached: false,
		canAccessOpener: false,
		browserContextId,
	}
}

export function attachedEvent(
	sessionId: string,
	targetInfo: Protocol.Target.TargetInfo,
): Protocol.Target.AttachedToTargetEvent {
	return {
		sessionId,
		targetInfo,
		waitingForDebugger: true,
	}
}

/**
 * Minimal {@link CDPTransport} stub used to verify ownership / close
 * semantics in `cdp.ts`.  Records `close()` invocations on
 * {@link InMemoryTransport.closeCalls}.
 *
 * The transport understands a small set of CDP methods that the Handstage init
 * paths invoke synchronously so tests that go through `connectTransport`
 * don't deadlock waiting for browser responses:
 *
 * - `Target.createBrowserContext` → synthesises an incrementing context id
 * - `Target.getTargets` → empty list
 * - `Target.setAutoAttach`, `Target.setDiscoverTargets`, `Target.getBrowserContexts`,
 *   `Browser.setDownloadBehavior` → returns `{}`
 * - anything else is ignored (no response queued; if a test relies on it,
 *   add a handler here)
 */
export class InMemoryTransport implements CDPTransport {
	public closeCalls = 0
	public sent: string[] = []
	public onmessage?: (msg: string) => void
	public onclose?: (reason: string) => void
	public onerror?: (err: Error) => void
	private contextIdSeq = 0

	send(message: string): void {
		this.sent.push(message)
		let parsed: { id?: number; method?: string; params?: object } | null = null
		try {
			parsed = JSON.parse(message)
		} catch {
			return
		}
		if (!parsed || typeof parsed.id !== "number") return
		const reply = this.synthesize(parsed.method ?? "")
		if (reply === undefined) return
		const payload = JSON.stringify({ id: parsed.id, result: reply })
		queueMicrotask(() => this.onmessage?.(payload))
	}

	private synthesize(method: string): object | undefined {
		switch (method) {
			case "Target.createBrowserContext":
				this.contextIdSeq += 1
				return { browserContextId: `ctx-fake-${this.contextIdSeq}` }
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
				return undefined
		}
	}

	close(): void {
		this.closeCalls += 1
		this.onclose?.("closed")
	}
}

export async function waitFor(assertion: () => boolean): Promise<void> {
	const deadline = Date.now() + 500
	while (Date.now() < deadline) {
		if (assertion()) return
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
	if (!assertion()) {
		throw new Error("waitFor assertion never became true")
	}
}
