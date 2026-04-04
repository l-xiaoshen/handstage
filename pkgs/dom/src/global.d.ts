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

declare global {
	interface Window {
		__handstagesV3Injected?: boolean
		__handstagesV3__?: HandstagesV3Backdoor
	}
}
