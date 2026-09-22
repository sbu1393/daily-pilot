import { readFileSync } from "node:fs"
import { join } from "node:path"
import vm from "node:vm"
import { describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* ADR-07 / Phase 3-A — Service Worker tests.                          */
/*                                                                     */
/* public/sw.js is NOT a module and cannot be imported by vitest, so   */
/* the REAL file is executed inside a `node:vm` sandbox with a stubbed */
/* `self` (addEventListener / registration / clients / location).      */
/* The actual handlers are then invoked with synthetic events. This is */
/* not a fake of the SW logic — it is the shipped file being run.      */
/* ------------------------------------------------------------------ */

type Listener = (event: Record<string, unknown>) => void

type Loaded = {
    listeners: Map<string, Listener>
    showNotification: ReturnType<typeof vi.fn>
    matchAll: ReturnType<typeof vi.fn>
    openWindow: ReturnType<typeof vi.fn>
}

function loadServiceWorker(): Loaded {
    const listeners = new Map<string, Listener>()
    const showNotification = vi.fn().mockResolvedValue(undefined)
    const matchAll = vi.fn().mockResolvedValue([])
    const openWindow = vi.fn().mockResolvedValue(undefined)

    const self = {
        addEventListener: (type: string, cb: Listener) => listeners.set(type, cb),
        registration: { showNotification },
        clients: { matchAll, openWindow },
        location: { origin: "https://example.com" },
        skipWaiting: vi.fn(),
    }

    const context = { self, URL, console, caches: { open: vi.fn() }, fetch: vi.fn() }
    vm.createContext(context)
    const code = readFileSync(join(process.cwd(), "public", "sw.js"), "utf8")
    new vm.Script(code, { filename: "sw.js" }).runInContext(context)

    return { listeners, showNotification, matchAll, openWindow }
}

async function dispatch(listener: Listener, event: Record<string, unknown>) {
    let waited: Promise<unknown> | undefined
    listener({ ...event, waitUntil: (p: Promise<unknown>) => { waited = p } })
    if (waited) await waited
}

describe("service worker — push", () => {
    it("shows a notification for a valid task-reminder payload", async () => {
        const sw = loadServiceWorker()
        const listener = sw.listeners.get("push")
        expect(listener).toBeTypeOf("function")

        await dispatch(listener!, {
            data: { json: () => ({ type: "task-reminder", taskId: 42, title: "تماس با مشتری", body: "وقتشه", url: "/dashboard?taskId=42" }) },
        })

        expect(sw.showNotification).toHaveBeenCalledTimes(1)
        const [title, options] = sw.showNotification.mock.calls[0]
        expect(title).toBe("تماس با مشتری")
        expect(options).toMatchObject({
            body: "وقتشه",
            icon: expect.any(String),
            badge: expect.any(String),
            data: { taskId: 42, url: "/dashboard?taskId=42" },
        })
    })

    it("falls back to /dashboard for an external url", async () => {
        const sw = loadServiceWorker()

        await dispatch(sw.listeners.get("push")!, {
            data: { json: () => ({ type: "task-reminder", taskId: 1, title: "کار", body: "", url: "https://evil.example.com" }) },
        })

        expect(sw.showNotification.mock.calls[0][1].data.url).toBe("/dashboard")
    })

    it.each([
        ["no data", { data: null }],
        ["json throws", { data: { json: () => { throw new Error("bad json") } } }],
        ["wrong type", { data: { json: () => ({ type: "other", title: "x" }) } }],
        ["empty title", { data: { json: () => ({ type: "task-reminder", title: "" }) } }],
        ["non-object", { data: { json: () => "just a string" } }],
    ])("does not crash and shows nothing for %s", async (_label, event) => {
        const sw = loadServiceWorker()

        await dispatch(sw.listeners.get("push")!, event)

        expect(sw.showNotification).not.toHaveBeenCalled()
    })
})

describe("service worker — notificationclick", () => {
    const event = (data: Record<string, unknown>) => ({
        notification: { close: vi.fn(), data },
    })

    it("focuses an existing same-origin window and navigates it to the task url", async () => {
        const sw = loadServiceWorker()
        const focus = vi.fn().mockResolvedValue(undefined)
        const navigate = vi.fn().mockResolvedValue(undefined)
        sw.matchAll.mockResolvedValue([{ url: "https://example.com/dashboard", focus, navigate }])

        const ev = event({ url: "/dashboard?taskId=7" })
        await dispatch(sw.listeners.get("notificationclick")!, ev)

        expect((ev.notification.close as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
        expect(focus).toHaveBeenCalledTimes(1)
        expect(navigate).toHaveBeenCalledWith("https://example.com/dashboard?taskId=7")
        expect(sw.openWindow).not.toHaveBeenCalled()
    })

    it("opens a new window when no app window is open", async () => {
        const sw = loadServiceWorker()
        sw.matchAll.mockResolvedValue([])

        await dispatch(sw.listeners.get("notificationclick")!, event({ url: "/dashboard?taskId=7" }))

        expect(sw.openWindow).toHaveBeenCalledTimes(1)
        expect(sw.openWindow).toHaveBeenCalledWith("https://example.com/dashboard?taskId=7")
    })

    it("defaults malformed data to /dashboard", async () => {
        const sw = loadServiceWorker()
        sw.matchAll.mockResolvedValue([])

        await dispatch(sw.listeners.get("notificationclick")!, event({ url: "javascript:alert(1)" }))

        expect(sw.openWindow).toHaveBeenCalledWith("https://example.com/dashboard")
    })

    it("ignores windows from other origins and opens the app window", async () => {
        const sw = loadServiceWorker()
        const focus = vi.fn().mockResolvedValue(undefined)
        sw.matchAll.mockResolvedValue([{ url: "https://other.example.com/", focus, navigate: vi.fn() }])

        await dispatch(sw.listeners.get("notificationclick")!, event({ url: "/dashboard" }))

        expect(focus).not.toHaveBeenCalled()
        expect(sw.openWindow).toHaveBeenCalledWith("https://example.com/dashboard")
    })

    it("does not create extra windows when the window is already on the target", async () => {
        const sw = loadServiceWorker()
        const focus = vi.fn().mockResolvedValue(undefined)
        const navigate = vi.fn().mockResolvedValue(undefined)
        sw.matchAll.mockResolvedValue([{ url: "https://example.com/dashboard", focus, navigate }])

        await dispatch(sw.listeners.get("notificationclick")!, event({ url: "/dashboard" }))

        expect(focus).toHaveBeenCalledTimes(1)
        expect(navigate).not.toHaveBeenCalled()
        expect(sw.openWindow).not.toHaveBeenCalled()
    })
})
