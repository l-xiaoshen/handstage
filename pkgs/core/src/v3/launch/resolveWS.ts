export async function resolveWebSocketDebuggerUrl(
	endpoint: string | Request | URL,
	init?: RequestInit,
): Promise<string> {
	let urlStr = ""
	if (typeof endpoint === "string") {
		urlStr = endpoint
	} else if (endpoint instanceof URL) {
		urlStr = endpoint.toString()
	} else if (endpoint instanceof Request) {
		urlStr = endpoint.url
	}

	// If the url doesn't end with /json/version, append it
	if (!urlStr.endsWith("/json/version")) {
		if (urlStr.endsWith("/")) {
			urlStr += "json/version"
		} else {
			urlStr += "/json/version"
		}
	}

	// We pass down either the endpoint (if it was a Request) or the built URL string
	const target = endpoint instanceof Request ? endpoint : urlStr
	const response = await fetch(target, init)
	
	if (!response.ok) {
		throw new Error(
			`Failed to fetch WebSocket debugger URL: ${response.status} ${response.statusText}`,
		)
	}

	const json = (await response.json()) as { webSocketDebuggerUrl?: string }
	if (!json.webSocketDebuggerUrl) {
		throw new Error("Response did not contain webSocketDebuggerUrl")
	}

	return json.webSocketDebuggerUrl
}
