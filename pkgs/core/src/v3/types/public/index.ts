// Export api.ts under namespace to avoid name collisions

export {
	CDPConnection,
	type CDPConnectionLike,
	type CDPSessionLike,
	type CDPTransport,
	type ExternalCDPSession,
} from "../../understudy/cdp"
export type { V3Context } from "../../understudy/context"
export * as Api from "./api"
export * from "./consoleLogger"
export * from "./context"
export * from "./logs"
export * from "./options"
export * from "./page"
export * from "./sdkErrors"
