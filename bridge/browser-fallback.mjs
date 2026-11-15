/**
 * Browsing without the Claude extension.
 *
 * The chrome_* tools (bridge/chrome.mjs) drive the user's own Chrome through
 * the Claude for Chrome extension. When that is not running they used to fail,
 * and JARVIS could only say "the browser extension isn't running". Now the
 * same actions run in JARVIS's own Chrome window instead (the one he uses for
 * Gemini, Flow and ChatGPT, bridge/geminiweb.mjs): open a page, read it, take a
 * picture, scroll, click, type, fill a form, manage tabs.
 *
 * Replies have the extension's shape ({result: {content}} or {error}), so the
 * tools treat both the same. Tab ids here are small numbers of our own.
 *
 * One difference the model is told about: that window is not signed in to the
 * user's everyday sites (their own Chrome is), so a page behind a login may ask
 * to sign in.
 */

import { ownBrowser, showPage } from './geminiweb.mjs'

const NOTE =
  "(In JARVIS's own Chrome window — the user's Chrome extension isn't running. " +
  "This window isn't signed in to the user's everyday sites, so a login page may appear; if it does, say so.)"

let browser = null
let current = null
let nextId = 1
const pages = new Map()
const idOf = new WeakMap()

async function context() {
  if (!browser || !browser.isConnected()) {
    browser = await ownBrowser()
    browser.on('disconnected', () => {
      browser = null
      current = null
      pages.clear()
    })
  }
  return browser.contexts()[0]
}

function register(page) {
  if (!idOf.has(page)) {
    const id = nextId++
    idOf.set(page, id)
    pages.set(id, page)
    page.on('close', () => {
      pages.delete(id)
      if (current === page) current = null
    })
  }
  return idOf.get(page)
}

/** The page to act on: the one named, the one in use, or a new one. */
async function pageFor(tabId, { create = true } = {}) {
  const ctx = await context()
  const named = tabId != null && `${tabId}`.trim() !== '' ? pages.get(Number(tabId)) : null
  if (named && !named.isClosed()) return (current = named)
  if (current && !current.isClosed()) return current
  if (!create) return null
  current = await ctx.newPage()
  register(current)
  return current
}

const text = (t) => ({ result: { content: [{ type: 'text', text: t }] } })
const error = (message) => ({ error: { message } })
const origin = (url) => {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/** The extension's key names ("Return", "cmd+a") in Playwright's form. */
function keyName(k) {
  return String(k)
    .split('+')
    .map((part) => {
      const p = part.trim()
      const low = p.toLowerCase()
      if (low === 'return' || low === 'enter') return 'Enter'
      if (low === 'cmd' || low === 'ctrl' || low === 'control' || low === 'meta') return 'Control'
      if (low === 'esc') return 'Escape'
      if (low === 'space') return 'Space'
      if (p.length === 1) return p
      return p[0].toUpperCase() + p.slice(1)
    })
    .join('+')
}

/** Interactive elements, tagged with refs the click / form tools take. */
async function readPage(page, { filter = 'interactive', max = 20_000 } = {}) {
  const lines = await page.evaluate((all) => {
    const sel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="menuitem"], [contenteditable="true"]'
    const els = [...document.querySelectorAll(all ? `${sel}, h1, h2, h3` : sel)]
    const out = []
    let n = 0
    for (const el of els) {
      const r = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      if (!r.width || !r.height || style.visibility === 'hidden' || style.display === 'none') continue
      const tag = el.tagName.toLowerCase()
      const role = el.getAttribute('role') || (tag === 'a' ? 'link' : /^h\d$/.test(tag) ? 'heading' : tag === 'input' ? `input ${el.type || 'text'}` : tag)
      const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
      if (role === 'heading') {
        out.push(`# ${name}`)
        continue
      }
      const ref = `ref_${++n}`
      el.setAttribute('data-jarvis-ref', ref)
      out.push(`[${ref}] ${role} "${name}"`)
    }
    return out
  }, filter === 'all')
  let body = `URL: ${page.url()}\nTitle: ${await page.title()}\n\n${lines.join('\n')}`
  if (body.length > max) body = body.slice(0, max) + '\n…(cut)'
  return body
}

const byRef = (page, ref) => page.locator(`[data-jarvis-ref="${String(ref).replace(/[^\w-]/g, '')}"]`).first()

/** One browser action, as the extension would have answered it. */
export async function fallbackCall(name, args = {}) {
  try {
    switch (name) {
      case 'tabs_context_mcp': {
        await context()
        if (args.createIfEmpty && ![...pages.values()].some((p) => !p.isClosed())) await pageFor(null)
        const list = [...pages.entries()].filter(([, p]) => !p.isClosed()).map(([tabId, p]) => ({ tabId, origin: origin(p.url()) }))
        return text(JSON.stringify({ availableTabs: list, note: NOTE }))
      }
      case 'tabs_create_mcp': {
        const ctx = await context()
        current = await ctx.newPage()
        const id = register(current)
        await showPage(current)
        return text(`Opened tab ${id}. ${NOTE}`)
      }
      case 'tabs_close_mcp': {
        const p = pages.get(Number(args.tabId))
        if (!p) return error(`No tab ${args.tabId}.`)
        await p.close()
        return text(`Closed tab ${args.tabId}.`)
      }
      case 'navigate': {
        const page = await pageFor(args.tabId)
        const url = String(args.url ?? '')
        if (url === 'back') await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {})
        else if (url === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {})
        else await page.goto(/^[a-z]+:/i.test(url) ? url : `https://${url}`, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {})
        await showPage(page)
        return text(`Opened ${page.url()} in tab ${register(page)}. ${NOTE}`)
      }
      case 'get_page_text': {
        const page = await pageFor(args.tabId, { create: false })
        if (!page) return error('No page is open yet — open one with chrome_navigate first.')
        const max = Number(args.max_chars) || 30_000
        const body = await page.evaluate(() => document.body?.innerText ?? '')
        return text(`URL: ${page.url()}\nTitle: ${await page.title()}\n\n${body.slice(0, max)}`)
      }
      case 'read_page': {
        const page = await pageFor(args.tabId, { create: false })
        if (!page) return error('No page is open yet — open one with chrome_navigate first.')
        return text(await readPage(page, { filter: args.filter, max: Number(args.max_chars) || 20_000 }))
      }
      case 'find':
        return error('Not available in JARVIS\'s own window — use chrome_read_page, which lists the same refs.')
      case 'form_input': {
        const page = await pageFor(args.tabId, { create: false })
        if (!page) return error('No page is open.')
        const el = byRef(page, args.ref)
        const tag = await el.evaluate((e) => `${e.tagName.toLowerCase()}:${e.type || ''}`)
        if (tag.startsWith('select')) await el.selectOption(String(args.value))
        else if (/checkbox|radio/.test(tag)) await el.setChecked(Boolean(args.value) && args.value !== 'false')
        else await el.fill(String(args.value))
        return text(`Set ${args.ref}.`)
      }
      case 'computer': {
        const page = await pageFor(args.tabId, { create: args.action === 'screenshot' ? false : true })
        if (!page) return error('No page is open yet — open one with chrome_navigate first.')
        switch (args.action) {
          case 'screenshot': {
            const data = (await page.screenshot({ type: 'jpeg', quality: 60 })).toString('base64')
            return { result: { content: [{ type: 'image', data, mimeType: 'image/jpeg' }] } }
          }
          case 'scroll': {
            const n = Number(args.scroll_amount) || 3
            const d = args.scroll_direction
            await page.mouse.wheel(d === 'left' ? -120 * n : d === 'right' ? 120 * n : 0, d === 'up' ? -120 * n : d === 'down' ? 120 * n : 0)
            return text(`Scrolled ${d}.`)
          }
          case 'left_click': {
            if (args.ref) await byRef(page, args.ref).click({ timeout: 10_000 })
            else if (Array.isArray(args.coordinate)) await page.mouse.click(Number(args.coordinate[0]), Number(args.coordinate[1]))
            else return error('Say what to click: a ref from chrome_read_page.')
            await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})
            return text(`Clicked. Now on ${page.url()}.`)
          }
          case 'type':
            await page.keyboard.type(String(args.text ?? ''), { delay: 15 })
            return text('Typed.')
          case 'key':
            await page.keyboard.press(keyName(args.text))
            return text(`Pressed ${args.text}.`)
          default:
            return error(`"${args.action}" isn't available in JARVIS's own window.`)
        }
      }
      case 'read_console_messages':
      case 'read_network_requests':
        return error("Console and network reading need the user's own Chrome with the Claude extension.")
      default:
        return error(`"${name}" isn't available in JARVIS's own window.`)
    }
  } catch (err) {
    return error(String(err?.message ?? err).split('\n')[0])
  }
}
