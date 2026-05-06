import type { Page } from "../../understudy/page"

export type { Page }

export type { ConsoleListener } from "../../understudy/consoleMessage"
export { ConsoleMessage } from "../../understudy/consoleMessage"

export type LoadState = "load" | "domcontentloaded" | "networkidle"
export { Response } from "../../understudy/response"

export type SnapshotResult = {
	formattedTree: string
	xpathMap: Record<string, string>
	urlMap: Record<string, string>
}

export type PageSnapshotOptions = {
	includeIframes?: boolean
}
