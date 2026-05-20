export interface HandstageV3Backdoor {
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

declare global {
	interface Window {
		__handstageV3Injected?: boolean
		__handstageV3__?: HandstageV3Backdoor
	}
}
