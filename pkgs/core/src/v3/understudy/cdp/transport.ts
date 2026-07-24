import { HandstageTransportAlreadyOwnedError } from "../../types/public/sdkErrors"

export interface CDPTransport {
	send(message: string): void
	close(): void | Promise<void>
	onmessage?: (message: string) => void
	onclose?: (reason: string) => void
	onerror?: (error: Error) => void
}

const webSocketOwners = new WeakMap<WebSocket, CDPTransport>()

export function createWebSocketTransport(ws: WebSocket): CDPTransport {
	if (webSocketOwners.has(ws)) {
		throw new HandstageTransportAlreadyOwnedError("websocket")
	}

	let cleaned = false
	let socketCloseRequested = false
	const cleanup = () => {
		if (cleaned) {
			return
		}
		cleaned = true
		ws.removeEventListener("message", onMessage)
		ws.removeEventListener("close", onClose)
		ws.removeEventListener("error", onError)
		if (webSocketOwners.get(ws) === transport) {
			webSocketOwners.delete(ws)
		}
	}
	const closeSocket = () => {
		if (socketCloseRequested) {
			return
		}
		socketCloseRequested = true
		ws.close()
	}
	const onMessage = (event: MessageEvent) => {
		transport.onmessage?.(event.data.toString())
	}
	const onClose = (event: CloseEvent) => {
		socketCloseRequested = true
		cleanup()
		transport.onclose?.(`code=${event.code} reason=${event.reason}`)
	}
	const onError = () => {
		cleanup()
		try {
			transport.onerror?.(new Error("WebSocket error"))
		} finally {
			try {
				closeSocket()
			} catch {}
		}
	}
	const transport: CDPTransport = {
		send: (message) => ws.send(message),
		close: () => {
			cleanup()
			closeSocket()
		},
	}

	webSocketOwners.set(ws, transport)
	ws.addEventListener("message", onMessage)
	ws.addEventListener("close", onClose)
	ws.addEventListener("error", onError)
	return transport
}
