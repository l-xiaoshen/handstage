import type { LogSink } from "../logger"
import { LogLevel } from "../types/public/logs"
import { resolveXpathForLocation } from "./a11y/snapshot/index"
import type { CDPSessionLike } from "./cdp"
import type { Page } from "./page"
import { releaseDiscardedEvaluationHandles } from "./runtimeObjectUtils"

type MouseButton = "left" | "right" | "middle"
type Delay = (delayMs: number) => Promise<void>

const BUTTON_MASK: Record<MouseButton, number> = {
	left: 1,
	right: 2,
	middle: 4,
}

const CURSOR_OVERLAY_SCRIPT = `(() => {
  const ID = '__v3_cursor_overlay__';
  const state = { el: null, last: null };
  try {
    if (!window.__v3Cursor || !window.__v3Cursor.__installed) {
      window.__v3Cursor = {
        __installed: false,
        move(x, y) {
          if (state.el) {
            state.el.style.left = Math.max(0, x) + 'px';
            state.el.style.top = Math.max(0, y) + 'px';
          } else {
            state.last = [x, y];
          }
        },
        show() { if (state.el) state.el.style.display = 'block'; },
        hide() { if (state.el) state.el.style.display = 'none'; },
      };
    }
  } catch {}

  function install() {
    try {
      if (state.el) return;
      let el = document.getElementById(ID);
      if (!el) {
        const root = document.documentElement || document.body || document.head;
        if (!root) { setTimeout(install, 50); return; }
        el = document.createElement('div');
        el.id = ID;
        el.style.position = 'fixed';
        el.style.left = '0px';
        el.style.top = '0px';
        el.style.width = '16px';
        el.style.height = '24px';
        el.style.zIndex = '2147483647';
        el.style.pointerEvents = 'none';
        el.style.userSelect = 'none';
        el.style.mixBlendMode = 'normal';
        el.style.contain = 'layout style paint';
        el.style.willChange = 'transform,left,top';
        el.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="24" viewBox="0 0 16 24"><path d="M1 0 L1 22 L6 14 L15 14 Z" fill="black" stroke="white" stroke-width="0.7"/></svg>';
        root.appendChild(el);
      }
      state.el = el;
      try { window.__v3Cursor.__installed = true; } catch {}
      if (state.last) {
        window.__v3Cursor.move(state.last[0], state.last[1]);
        state.last = null;
      }
    } catch {}
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    install();
  } else {
    document.addEventListener('DOMContentLoaded', install, { once: true });
    setTimeout(install, 100);
  }
})();`

export class Mouse {
	private cursorEnabled = false

	constructor(
		private readonly page: Page,
		private readonly session: CDPSessionLike,
		private readonly logger: LogSink,
		private readonly delay: Delay,
	) {}

	public reset(): void {
		this.cursorEnabled = false
	}

	public async enableCursorOverlay(): Promise<void> {
		if (this.cursorEnabled) {
			return
		}
		await this.session
			.send("Page.addScriptToEvaluateOnNewDocument", {
				source: CURSOR_OVERLAY_SCRIPT,
			})
			.catch(() => {})
		await this.session
			.send("Runtime.evaluate", {
				expression: CURSOR_OVERLAY_SCRIPT,
				includeCommandLineAPI: false,
			})
			.then((response) =>
				releaseDiscardedEvaluationHandles(this.session, response),
			)
			.catch(() => {})
		this.cursorEnabled = true
	}

	public async click(
		x: number,
		y: number,
		options?: {
			button?: MouseButton
			clickCount?: number
			returnXpath?: boolean
		},
	): Promise<string> {
		const button = options?.button ?? "left"
		const clickCount = options?.clickCount ?? 1
		const xpath = options?.returnXpath
			? await this.resolveXPath("click", x, y)
			: ""

		await this.updateCursor(x, y)
		const dispatches: Array<Promise<unknown>> = [
			this.session.send("Input.dispatchMouseEvent", {
				type: "mouseMoved",
				x,
				y,
				button: "none",
			}),
		]
		for (let index = 1; index <= clickCount; index++) {
			dispatches.push(
				this.session.send("Input.dispatchMouseEvent", {
					type: "mousePressed",
					x,
					y,
					button,
					clickCount: index,
				}),
				this.session.send("Input.dispatchMouseEvent", {
					type: "mouseReleased",
					x,
					y,
					button,
					clickCount: index,
				}),
			)
		}
		await Promise.all(dispatches)
		return xpath
	}

	public async hover(
		x: number,
		y: number,
		options?: { returnXpath?: boolean },
	): Promise<string> {
		const xpath = options?.returnXpath
			? await this.resolveXPath("hover", x, y)
			: ""
		await this.updateCursor(x, y)
		await this.session.send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x,
			y,
			button: "none",
		})
		return xpath
	}

	public async scroll(
		x: number,
		y: number,
		deltaX: number,
		deltaY: number,
		options?: { returnXpath?: boolean },
	): Promise<string> {
		const xpath = options?.returnXpath
			? await this.resolveXPath("scroll", x, y)
			: ""
		await this.updateCursor(x, y)
		await this.session.send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x,
			y,
			button: "none",
		})
		await this.session.send("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x,
			y,
			button: "none",
			deltaX,
			deltaY,
		})
		return xpath
	}

	public async dragAndDrop(
		fromX: number,
		fromY: number,
		toX: number,
		toY: number,
		options?: {
			button?: MouseButton
			steps?: number
			delay?: number
			returnXpath?: boolean
		},
	): Promise<[string, string]> {
		const button = options?.button ?? "left"
		const steps = Math.max(1, Math.floor(options?.steps ?? 1))
		const delayMs = Math.max(0, options?.delay ?? 0)
		let fromXpath = ""
		let toXpath = ""
		if (options?.returnXpath) {
			fromXpath = await this.resolveXPath("drag", fromX, fromY)
			toXpath = await this.resolveXPath("drop", toX, toY)
		}

		await this.updateCursor(fromX, fromY)
		await this.session.send("Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: fromX,
			y: fromY,
			button: "none",
		})
		await this.session.send("Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: fromX,
			y: fromY,
			button,
			buttons: BUTTON_MASK[button],
			clickCount: 1,
		})

		for (let index = 1; index <= steps; index++) {
			const progress = index / steps
			const x = fromX + (toX - fromX) * progress
			const y = fromY + (toY - fromY) * progress
			await this.updateCursor(x, y)
			await this.session.send("Input.dispatchMouseEvent", {
				type: "mouseMoved",
				x,
				y,
				button,
				buttons: BUTTON_MASK[button],
			})
			if (delayMs > 0) {
				await this.delay(delayMs)
			}
		}

		await this.updateCursor(toX, toY)
		await this.session.send("Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x: toX,
			y: toY,
			button,
			buttons: BUTTON_MASK[button],
			clickCount: 1,
		})
		return [fromXpath, toXpath]
	}

	private async resolveXPath(
		operation: string,
		x: number,
		y: number,
	): Promise<string> {
		try {
			const hit = await resolveXpathForLocation(this.page, x, y)
			if (!hit) {
				return ""
			}
			this.logger({
				category: "page",
				message: `${operation} resolved hit`,
				level: LogLevel.Debug,
				attributes: {
					frameId: hit.frameId,
					backendNodeId: hit.backendNodeId,
					x,
					y,
					xpath: hit.absoluteXPath,
				},
			})
			return hit.absoluteXPath
		} catch {
			return ""
		}
	}

	private async updateCursor(x: number, y: number): Promise<void> {
		if (!this.cursorEnabled) {
			return
		}
		try {
			const response = await this.session.send("Runtime.evaluate", {
				expression: `typeof window.__v3Cursor!=="undefined"&&window.__v3Cursor.move(${Math.round(x)}, ${Math.round(y)})`,
			})
			await releaseDiscardedEvaluationHandles(this.session, response)
		} catch {}
	}
}
