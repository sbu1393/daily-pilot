import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* public/sw.js — رویدادهای یادآور (`push` و `notificationclick`)       */
/*                                                                     */
/* sw.js با یک `self` ساختگی اجرا می‌شود تا هندلرها گرفته شوند؛ این     */
/* تنها راه تست منطق سرویس‌کاربر بدون مرورگر/jsdom است.                */
/*                                                                     */
/* قفل‌شده در این فایل:                                                 */
/*  ۱. هر دو رویداد ثبت شده‌اند.                                        */
/*  ۲. payload یادآور همان قرارداد adapter است و مقصد کلیک را می‌سازد.  */
/*  ۳. payload خراب/ناقص/غیر-JSON → مقدار امن پیش‌فرض (بدون خطا).        */
/*  ۴. کلیک: فوکوس پنجره‌ی باز (و انتقال در صورت نیاز)، وگرنه            */
/*     openWindow؛ Safari بدون navigate هم فقط focus می‌کند.            */
/*  ۵. deep link خارج از origin نادیده گرفته می‌شود (بدون open-redirect).*/
/* ------------------------------------------------------------------ */

const ORIGIN = "https://roozchin.test"

type NotificationClickEvent = {
    notification: { close: () => void; data?: { url?: string } }
    waitUntil: (promise: Promise<unknown>) => void
}

type PushEvent = {
    data: { json: () => unknown } | null
    waitUntil: (promise: Promise<unknown>) => void
}

type Handler = (event: never) => void

type ClientStub = {
    url: string
    focus: ReturnType<typeof vi.fn>
    navigate: ReturnType<typeof vi.fn>
}

const clientStub = (url: string, navigate?: ReturnType<typeof vi.fn>): ClientStub => ({
    url,
    focus: vi.fn(async () => undefined),
    navigate: navigate ?? vi.fn(async () => undefined),
})

function loadServiceWorker() {
    const source = readFileSync(join(process.cwd(), "public", "sw.js"), "utf8")
    const handlers = new Map<string, Handler>()
    const openWindow = vi.fn(async () => null)
    const matchAll = vi.fn(async () => [] as ClientStub[])
    const showNotification = vi.fn(async () => undefined)

    const selfStub = {
        addEventListener: (type: string, handler: unknown) => {
            handlers.set(type, handler as Handler)
        },
        location: { origin: ORIGIN },
        clients: { claim: vi.fn(async () => undefined), matchAll, openWindow },
        registration: { showNotification },
        skipWaiting: vi.fn(async () => undefined),
    }
    const cachesStub = {
        open: vi.fn(async () => ({ add: vi.fn(), put: vi.fn(), match: vi.fn() })),
        keys: vi.fn(async () => []),
        delete: vi.fn(async () => true),
    }

    // eslint-disable-next-line no-new-func
    const loader = new Function("self", "caches", source) as unknown as (
        selfArg: unknown,
        cachesArg: unknown,
    ) => void
    loader(selfStub, cachesStub)

    return { handlers, matchAll, openWindow, showNotification }
}

function clickEvent(url?: string) {
    let waited: Promise<unknown> = Promise.resolve()
    const close = vi.fn()

    const event: NotificationClickEvent = {
        notification: url === undefined ? { close } : { close, data: { url } },
        waitUntil: (promise) => {
            waited = promise
        },
    }

    return {
        close,
        event,
        settle: async () => {
            await waited
        },
    }
}

function pushEvent(payload: unknown | "invalid-json") {
    let waited: Promise<unknown> = Promise.resolve()

    const event: PushEvent = {
        data:
            payload === "invalid-json"
                ? {
                      json: () => {
                          throw new Error("not json")
                      },
                  }
                : { json: () => payload },
        waitUntil: (promise) => {
            waited = promise
        },
    }

    return {
        event,
        settle: async () => {
            await waited
        },
    }
}

let sw: ReturnType<typeof loadServiceWorker>

beforeEach(() => {
    sw = loadServiceWorker()
})

describe("public/sw.js — رویداد push", () => {
    it("هندلر push را ثبت کرده است", () => {
        expect(sw.handlers.has("push")).toBe(true)
    })

    it("payload قراردادی را با همان deep link کلیک نمایش می‌دهد", async () => {
        const { event, settle } = pushEvent({
            title: "یادآور روزساز",
            body: "وقت برنامه‌ریزی روزت رسیده است ✨",
            url: "/dashboard/today",
            tag: "dp-reminder-2026-09-22|09:00",
            icon: "/icons/icon-192.png",
        })

        sw.handlers.get("push")?.(event as never)
        await settle()

        expect(sw.showNotification).toHaveBeenCalledTimes(1)
        const [title, options] = sw.showNotification.mock.calls[0] as unknown as [
            string,
            Record<string, unknown>,
        ]
        expect(title).toBe("یادآور روزساز")
        expect(options).toMatchObject({
            body: "وقت برنامه‌ریزی روزت رسیده است ✨",
            tag: "dp-reminder-2026-09-22|09:00",
            icon: "/icons/icon-192.png",
            lang: "fa",
            dir: "rtl",
            data: { url: "/dashboard/today" },
        })
    })

    it("payload غیر-JSON → پیام پیش‌فرض (بدون خطا)", async () => {
        const { event, settle } = pushEvent("invalid-json")

        sw.handlers.get("push")?.(event as never)
        await settle()

        const [title, options] = sw.showNotification.mock.calls[0] as unknown as [
            string,
            Record<string, unknown>,
        ]
        expect(title).toBe("یادآور روزساز")
        expect(options.data).toEqual({ url: "/dashboard" })
        expect(typeof options.body).toBe("string")
    })

    it("فیلدهای ناقص/خالی/نامعتبر → مقدار پیش‌فرض امن", async () => {
        const { event, settle } = pushEvent({ title: "   ", body: 42, url: "", tag: null, icon: {} })

        sw.handlers.get("push")?.(event as never)
        await settle()

        const [title, options] = sw.showNotification.mock.calls[0] as unknown as [
            string,
            Record<string, unknown>,
        ]
        expect(title).toBe("یادآور روزساز")
        expect(options.data).toEqual({ url: "/dashboard" })
        expect(options.tag).toBe("dp-reminder")
        expect(options.icon).toBe("/icons/icon-192.png")
    })

    it("متن خیلی بلند بریده می‌شود (سقف عنوان/متن)", async () => {
        const { event, settle } = pushEvent({ title: "ط".repeat(500), body: "ب".repeat(500) })

        sw.handlers.get("push")?.(event as never)
        await settle()

        const [title, options] = sw.showNotification.mock.calls[0] as unknown as [
            string,
            Record<string, unknown>,
        ]
        expect((title as string).length).toBe(120)
        expect((options.body as string).length).toBe(300)
    })

    it("خطای showNotification بی‌صدا رد می‌شود (بدون unhandled rejection)", async () => {
        sw.showNotification.mockRejectedValueOnce(new Error("permission revoked"))
        const { event, settle } = pushEvent({ title: "یادآور", body: "بدنه", url: "/dashboard" })

        sw.handlers.get("push")?.(event as never)

        await expect(settle()).resolves.toBeUndefined()
    })
})

describe("public/sw.js — notificationclick", () => {
    it("هندلر notificationclick را ثبت کرده است", () => {
        expect(sw.handlers.has("notificationclick")).toBe(true)
        expect(sw.handlers.has("fetch")).toBe(true)
    })

    it("روی پنجره‌ی باز فوکوس می‌کند و آن را به مقصد می‌برد (بدون پنجره‌ی تکراری)", async () => {
        const existing = clientStub(`${ORIGIN}/dashboard/settings`)
        sw.matchAll.mockResolvedValue([existing])

        const { close, event, settle } = clickEvent("/dashboard")
        sw.handlers.get("notificationclick")?.(event as never)
        await settle()

        expect(close).toHaveBeenCalledTimes(1)
        expect(existing.navigate).toHaveBeenCalledWith(`${ORIGIN}/dashboard`)
        expect(existing.focus).toHaveBeenCalledTimes(1)
        expect(sw.openWindow).not.toHaveBeenCalled()
        expect(sw.matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true })
    })

    it("اگر پنجره همین حالا روی مقصد است، فقط فوکوس می‌کند", async () => {
        const existing = clientStub(`${ORIGIN}/dashboard`)
        sw.matchAll.mockResolvedValue([existing])

        const { event, settle } = clickEvent("/dashboard")
        sw.handlers.get("notificationclick")?.(event as never)
        await settle()

        expect(existing.navigate).not.toHaveBeenCalled()
        expect(existing.focus).toHaveBeenCalledTimes(1)
        expect(sw.openWindow).not.toHaveBeenCalled()
    })

    it("وقتی هیچ پنجره‌ای باز نیست، openWindow را صدا می‌زند", async () => {
        sw.matchAll.mockResolvedValue([])

        const { event, settle } = clickEvent("/dashboard")
        sw.handlers.get("notificationclick")?.(event as never)
        await settle()

        expect(sw.openWindow).toHaveBeenCalledWith(`${ORIGIN}/dashboard`)
    })

    it("Safari که client.navigate را ندارد: فقط focus، بدون پنجره‌ی تکراری", async () => {
        const safari = clientStub(
            `${ORIGIN}/dashboard/history`,
            vi.fn(async () => Promise.reject(new Error("navigate is not a function"))),
        )
        sw.matchAll.mockResolvedValue([safari])

        const { event, settle } = clickEvent("/dashboard")
        sw.handlers.get("notificationclick")?.(event as never)
        await settle()

        expect(safari.navigate).toHaveBeenCalledTimes(1)
        expect(safari.focus).toHaveBeenCalledTimes(1)
        expect(sw.openWindow).not.toHaveBeenCalled()
    })

    it("deep link خارج از origin نادیده گرفته می‌شود (بدون open-redirect)", async () => {
        sw.matchAll.mockResolvedValue([])

        const { event, settle } = clickEvent("https://evil.test/phish")
        sw.handlers.get("notificationclick")?.(event as never)
        await settle()

        expect(sw.openWindow).toHaveBeenCalledWith(`${ORIGIN}/dashboard`)
        expect(sw.openWindow).not.toHaveBeenCalledWith("https://evil.test/phish")
    })

    it("بدون data.url به داشبورد برمی‌گردد و پنجره‌های غیر same-origin را نادیده می‌گیرد", async () => {
        const foreign = clientStub("https://evil.test/")
        sw.matchAll.mockResolvedValue([foreign])

        const { event, settle } = clickEvent()
        sw.handlers.get("notificationclick")?.(event as never)
        await settle()

        expect(foreign.focus).not.toHaveBeenCalled()
        expect(foreign.navigate).not.toHaveBeenCalled()
        expect(sw.openWindow).toHaveBeenCalledWith(`${ORIGIN}/dashboard`)
    })

    it("اگر هیچ راهی برای هدایت کاربر نباشد، خطا را بی‌صدا رد می‌کند", async () => {
        sw.matchAll.mockRejectedValue(new Error("clients unavailable"))

        const { close, event, settle } = clickEvent("/dashboard")
        sw.handlers.get("notificationclick")?.(event as never)

        await expect(settle()).resolves.toBeUndefined()
        expect(close).toHaveBeenCalledTimes(1)
        expect(sw.openWindow).not.toHaveBeenCalled()
    })
})
