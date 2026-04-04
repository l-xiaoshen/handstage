import { maybeRunShutdownSupervisorFromArgv } from "./shutdown/supervisor"
import * as PublicApi from "./types/public/index"
import { V3 } from "./v3"

export { maybeRunShutdownSupervisorFromArgv as __internalMaybeRunShutdownSupervisorFromArgv } from "./shutdown/supervisor"
export * from "./types/public/index"
export { V3, V3 as Handstages } from "./v3"

const HandstagesDefault = {
	...PublicApi,
	V3,
	Handstages: V3,
	__internalMaybeRunShutdownSupervisorFromArgv:
		maybeRunShutdownSupervisorFromArgv,
}

export default HandstagesDefault
