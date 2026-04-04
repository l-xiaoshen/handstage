export interface V3ShadowPatchOptions {
	debug?: boolean
	tagExisting?: boolean
}

export interface HandstagesV3Backdoor {
	/** Closed shadow-root accessors */
	getClosedRoot(host: Element): ShadowRoot | undefined
	/** Stats + quick health check */
	stats(): {
		installed: true
		url: string
		isTop: boolean
		open: number
		closed: number
	}
}

type V3InternalState = {
	hostToRoot: WeakMap<Element, ShadowRoot>
	openCount: number
	closedCount: number
	debug: boolean
}

declare global {
	interface Window {
		__handstagesV3Injected?: boolean
		__handstagesV3__?: HandstagesV3Backdoor
	}
}

export function installV3ShadowPiercer(opts: V3ShadowPatchOptions = {}): void {
	const DEBUG = true

	type PatchedFn = Element["attachShadow"] & {
		__v3Patched?: boolean
		__v3State?: V3InternalState
	}

	const bindBackdoor = (state: V3InternalState): void => {
		const { hostToRoot } = state

		window.__handstagesV3__ = {
			getClosedRoot: (host: Element) => hostToRoot.get(host),
			stats: () => ({
				installed: true,
				url: location.href,
				isTop: window.top === window,
				open: state.openCount,
				closed: state.closedCount,
			}),
		} satisfies HandstagesV3Backdoor
	}

	const currentFn = Element.prototype.attachShadow as PatchedFn
	if (currentFn.__v3Patched && currentFn.__v3State) {
		currentFn.__v3State.debug = DEBUG
		bindBackdoor(currentFn.__v3State)
		return
	}

	const state: V3InternalState = {
		hostToRoot: new WeakMap<Element, ShadowRoot>(),
		openCount: 0,
		closedCount: 0,
		debug: DEBUG,
	}

	const original = currentFn
	const patched: PatchedFn = function (
		this: Element,
		init: ShadowRootInit,
	): ShadowRoot {
		const mode = init?.mode ?? "open"
		const root = original.call(this, init)
		try {
			state.hostToRoot.set(this, root)
			if (mode === "closed") state.closedCount++
			else state.openCount++
			if (state.debug) {
				console.info("[v3-piercer] attachShadow", {
					tag: (this as Element).tagName?.toLowerCase() ?? "",
					mode,
					url: location.href,
				})
			}
		} catch {}
		return root
	} as PatchedFn

	patched.__v3Patched = true
	patched.__v3State = state

	Object.defineProperty(Element.prototype, "attachShadow", {
		configurable: true,
		writable: true,
		value: patched,
	})

	if (opts.tagExisting) {
		try {
			const walker = document.createTreeWalker(
				document,
				NodeFilter.SHOW_ELEMENT,
			)
			while (walker.nextNode()) {
				const el = walker.currentNode as Element
				if (el.shadowRoot) {
					state.hostToRoot.set(el, el.shadowRoot)
					state.openCount++
				}
			}
		} catch {}
	}

	window.__handstagesV3Injected = true
	bindBackdoor(state)

	if (state.debug) {
		console.info("[v3-piercer] installed", {
			url: location.href,
			isTop: window.top === window,
			readyState: document.readyState,
		})
	}
}
