import type {
	ClearCookieOptions,
	Cookie,
	CookieParam,
} from "../types/public/context"
import { CookieSetError } from "../types/public/sdkErrors"
import type { CDPConnectionLike } from "./cdp"
import {
	cookieMatchesFilter,
	filterCookies,
	normalizeCookieParams,
	toCDPCookieParam,
} from "./cookies"
import { errorMessage } from "./protocolError"

export class ContextCookies {
	constructor(
		private readonly connection: CDPConnectionLike,
		private readonly contextScope: () => string | null,
	) {}

	public async get(urls?: string | string[]): Promise<Cookie[]> {
		const { cookies } = await this.connection.send(
			"Storage.getCookies",
			this.scopedParams(),
		)
		const mapped: Cookie[] = cookies.map((cookie) => ({
			name: cookie.name,
			value: cookie.value,
			domain: cookie.domain,
			path: cookie.path,
			expires: cookie.expires,
			httpOnly: cookie.httpOnly,
			secure: cookie.secure,
			sameSite: cookie.sameSite ?? "Lax",
		}))
		return filterCookies(mapped, this.normalizeUrls(urls))
	}

	public async add(cookies: CookieParam[]): Promise<void> {
		const normalized = normalizeCookieParams(cookies)
		if (normalized.length === 0) {
			return
		}

		try {
			await this.connection.send(
				"Storage.setCookies",
				this.scopedParams({ cookies: normalized.map(toCDPCookieParam) }),
			)
		} catch (error) {
			const names = normalized.map((cookie) => `"${cookie.name}"`).join(", ")
			const detail = errorMessage(error)
			throw new CookieSetError(
				`Failed to set cookies [${names}] — ` +
					`the browser rejected the batch. Check that the domain, path, and secure/sameSite values are valid.` +
					(detail ? ` (CDP error: ${detail})` : ""),
			)
		}
	}

	public async clear(options?: ClearCookieOptions): Promise<void> {
		if (!options || !this.hasFilter(options)) {
			await this.connection.send("Storage.clearCookies", this.scopedParams())
			return
		}

		const current = await this.get()
		const toKeep = current.filter(
			(cookie) => !cookieMatchesFilter(cookie, options),
		)
		if (toKeep.length === current.length) {
			return
		}

		await this.connection.send("Storage.clearCookies", this.scopedParams())
		if (toKeep.length === 0) {
			return
		}
		try {
			await this.connection.send(
				"Storage.setCookies",
				this.scopedParams({ cookies: toKeep.map(toCDPCookieParam) }),
			)
		} catch (error) {
			const names = toKeep.map((cookie) => `"${cookie.name}"`).join(", ")
			const detail = errorMessage(error)
			throw new CookieSetError(
				`clearCookies: cookies were cleared but failed to re-add the ${toKeep.length} ` +
					`non-matching cookie(s) [${names}]. The browser cookie jar is now empty. ` +
					(detail ? `(CDP error: ${detail})` : ""),
			)
		}
	}

	private hasFilter(options: ClearCookieOptions): boolean {
		return (
			options.name !== undefined ||
			options.domain !== undefined ||
			options.path !== undefined
		)
	}

	private normalizeUrls(urls?: string | string[]): string[] {
		if (!urls) {
			return []
		}
		return typeof urls === "string" ? [urls] : urls
	}

	private scopedParams(): { browserContextId?: string }
	private scopedParams<T extends object>(
		extra: T,
	): T & { browserContextId?: string }
	private scopedParams<T extends object>(extra?: T) {
		return { ...extra, browserContextId: this.contextScope() ?? undefined }
	}
}
