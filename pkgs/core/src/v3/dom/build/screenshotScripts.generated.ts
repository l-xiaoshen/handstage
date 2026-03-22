/*
 * AUTO-GENERATED FILE. DO NOT EDIT.
 * Update sources in lib/v3/dom/screenshotScripts and run genScreenshotScripts.ts.
 */
export const screenshotScriptSources = {
	resolveMaskRect:
		'function h(r) {\n  function u(t, e) {\n    try {\n      return t && typeof t.closest == "function" ? t.closest(e) : null;\n    } catch {\n      return null;\n    }\n  }\n  function s(t, e) {\n    try {\n      return !!t && typeof t.matches == "function" && t.matches(e);\n    } catch {\n      return !1;\n    }\n  }\n  function c(t) {\n    let e = u(t, "dialog[open]");\n    if (e)\n      return e;\n    let l = u(t, "[popover]");\n    return l && s(l, ":popover-open") ? l : null;\n  }\n  if (!this || typeof this.getBoundingClientRect != "function")\n    return null;\n  let n = this.getBoundingClientRect();\n  if (!n)\n    return null;\n  let i = window.getComputedStyle(this);\n  if (!i || i.visibility === "hidden" || i.display === "none" || n.width <= 0 || n.height <= 0)\n    return null;\n  let o = c(this);\n  if (o) {\n    let t = o.getBoundingClientRect();\n    if (!t)\n      return null;\n    let e = null;\n    if (r)\n      try {\n        let l = o.getAttribute("data-stagehand-mask-root");\n        l && l.startsWith(r) ? e = l : (e = r + "_root_" + Math.random().toString(36).slice(2), o.setAttribute("data-stagehand-mask-root", e));\n      } catch {\n        e = null;\n      }\n    return { x: n.left - t.left - (o.clientLeft || 0) + (o.scrollLeft || 0), y: n.top - t.top - (o.clientTop || 0) + (o.scrollTop || 0), width: n.width, height: n.height, rootToken: e };\n  }\n  return { x: n.left + window.scrollX, y: n.top + window.scrollY, width: n.width, height: n.height, rootToken: null };\n}',
} as const
export type ScreenshotScriptName = keyof typeof screenshotScriptSources
