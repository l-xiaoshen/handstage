// Export api.ts under namespace to avoid name collisions

export type {
	CDPSessionLike,
	CDPTransport,
	ExternalCDPSession,
} from "../../understudy/cdp"
export * as Api from "./api"
export * from "./consoleLogger"
export * from "./context"
export * from "./logs"
export * from "./options"
export * from "./page"
export * from "./sdkErrors"
