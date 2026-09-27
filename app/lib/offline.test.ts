import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* H2/H3 (audit) — تست‌های لایه‌ی آفلاین محدود (app/lib/offline.ts)      */
/*                                                                     */
/* محیط vitest این پروژه «node» است و jsdom نصب نمی‌شود (قید صفر      */
/* وابستگی). بنابراین حداقل stub برای window.localStorage / navigator / */
/* fetch / Event ساخته می‌شود — نه یک محیط مرورگر کامل.                 */
/*                                                                     */
/* قراردادهای V1 آفلاین که این فایل قفل می‌کند: فقط Create، فقط        */
/* {title, scheduledDate}، شناسه‌ی موقت local-*، حذف پس از سینک موفق،   */
/* بدون conflict-resolution و بدون تضمین ترتیب/تحویل.                  */
/* ------------------------------------------------------------------ */

type Listener = () => void

const listeners = new Map<string, Set<Listener>>()

// localStorage ساختگی: کلیدها روی خودِ آبجکت می‌نشینند چون safeKeys() از
// Object.keys(window.localStorage) استفاده می‌کند.
const storage: Record<string, unknown> = {
    getItem: (key: string) => (key in storage ? (storage[key] as string) : null),
    setItem: (key: string, value: string) => {
        storage[key] = String(value)
    },
    removeItem: (key: string) => {
        delete storage[key]
    },
}

const windowStub = {
    localStorage: storage,
    addEventListener: (type: string, cb: Listener) => {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type)?.add(cb)
    },
    removeEventListener: (type: string, cb: Listener) => {
        listeners.get(type)?.delete(cb)
    },
    dispatchEvent: (event: { type: string }) => {
        listeners.get(event.type)?.forEach((cb) => cb())
        return true
    },
}

const network = { onLine: true }
const fetchMock = vi.fn()

vi.stubGlobal("window", windowStub)
vi.stubGlobal("navigator", network)
vi.stubGlobal("fetch", fetchMock)
vi.stubGlobal(
    "Event",
    class {
        type: string
        constructor(type: string) {
            this.type = type
        }
    },
)

import {
    cacheDay,
    clearOfflineForLogout,
    ensureOfflineScope,
    enqueueTask,
    getOfflineUserId,
    readCachedDay,
    readQueue,
    setOfflineUserId,
    syncQueue,
} from "./offline"
import type { TaskItem } from "@/app/components/task/taskTypes"

const DAY_KEY = "2026-03-05"
const SCHEDULED_DATE = "2026-03-04T20:30:00.000Z" // نیمه‌شب محلی تهران

const TASK: TaskItem = {
    id: 1,
    title: "گزارش",
    category: null,
    priority: null,
    score: null,
    reason: null,
    status: "TODO",
    dayKey: DAY_KEY,
    estimatedTime: null,
    allocatedMinutes: null,
    spentMinutes: null,
    completedOn: null,
    createdAt: "2026-03-05T06:00:00.000Z",
    updatedAt: "2026-03-05T06:00:00.000Z",
}

const queuedItem = (title: string) => ({ title, dayKey: DAY_KEY, scheduledDate: SCHEDULED_DATE })

const bodyOf = (call: unknown[]): { title: string; scheduledDate: string } =>
    JSON.parse((call[1] as { body: string }).body)

describe("offline layer (H2 — per-user scope)", () => {
    beforeEach(() => {
        fetchMock.mockReset()
        network.onLine = true
        for (const key of Object.keys(storage)) {
            if (key !== "getItem" && key !== "setItem" && key !== "removeItem") delete storage[key]
        }
        setOfflineUserId(null) // شروع هر تست: بدون نشست
    })

    it("keeps cache and queue scoped to the session user — another account sees nothing", () => {
        setOfflineUserId(1)
        cacheDay(DAY_KEY, [TASK], null)
        enqueueTask(queuedItem("خرید"))

        expect(readCachedDay(DAY_KEY)?.tasks).toHaveLength(1)
        expect(readQueue()).toHaveLength(1)

        // کاربر دیگر روی همان دستگاه: نه کش می‌بیند، نه صف (H2 — بدون نشت داده/صف)
        setOfflineUserId(2)
        expect(readCachedDay(DAY_KEY)).toBeNull()
        expect(readQueue()).toEqual([])

        // برگشت کاربر اول: داده‌ی خودش سر جایش است
        setOfflineUserId(1)
        expect(readCachedDay(DAY_KEY)?.tasks).toHaveLength(1)
        expect(readQueue()).toHaveLength(1)
    })

    it("reads and writes nothing while no session scope is resolved", () => {
        setOfflineUserId(null)

        expect(readCachedDay(DAY_KEY)).toBeNull()
        expect(readQueue()).toEqual([])

        cacheDay(DAY_KEY, [TASK], null)
        enqueueTask(queuedItem("بی‌صاحب"))

        expect(readCachedDay(DAY_KEY)).toBeNull() // هیچ داده‌ی بی‌صاحبی ذخیره نمی‌شود
        expect(storage["dp:offline:v3:queue:null"]).toBeUndefined()
    })

    it("ensureOfflineScope resolves the session user once and persists it for later offline use", async () => {
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: { id: 42 } }) })

        await expect(ensureOfflineScope()).resolves.toBe(42)
        await expect(ensureOfflineScope()).resolves.toBe(42)

        // فراخوانی‌های موازی/تکراری → فقط یک درخواست profile
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/profile")
        // scope روی دستگاه می‌ماند تا در آفلاین بعدی هم کش/صف درست خوانده شود
        expect(storage["dp:offline:v3:user"]).toBe("42")
        expect(getOfflineUserId()).toBe(42)
    })

    it("ensureOfflineScope caches no negative result and never fetches while offline", async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) })

        await expect(ensureOfflineScope()).resolves.toBeNull()
        expect(getOfflineUserId()).toBeNull()
        expect(storage["dp:offline:v3:user"]).toBeUndefined()

        network.onLine = false
        fetchMock.mockClear()
        await expect(ensureOfflineScope()).resolves.toBeNull()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("purges legacy unscoped keys as soon as a session scope is established", () => {
        storage["dp:offline:v2:day:2026-03-05"] = "{}"
        storage["dp:offline:queue"] = "[]"

        setOfflineUserId(7)

        expect(storage["dp:offline:v2:day:2026-03-05"]).toBeUndefined()
        expect(storage["dp:offline:queue"]).toBeUndefined()
    })

    it("logout flush syncs what it can, purges cached days, and never destroys unsynced work", async () => {
        setOfflineUserId(1)
        cacheDay(DAY_KEY, [TASK], null)
        enqueueTask(queuedItem("خرید"))
        fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })

        const result = await clearOfflineForLogout()

        expect(result).toEqual({ synced: 0, pending: 1 })
        expect(getOfflineUserId()).toBeNull()
        expect(readCachedDay(DAY_KEY)).toBeNull() // کش روز پاک شد
        expect(storage["dp:offline:v3:user"]).toBeUndefined()

        // ورود دوباره‌ی همان کاربر → کار آفلاینِ سینک‌نشده همچنان محفوظ است
        setOfflineUserId(1)
        expect(readQueue()).toHaveLength(1)
    })

    it("logout flush drains the queue when the server is reachable", async () => {
        setOfflineUserId(1)
        enqueueTask(queuedItem("خرید"))
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })

        const result = await clearOfflineForLogout()

        expect(result).toEqual({ synced: 1, pending: 0 })
        expect(storage["dp:offline:v3:queue:1"]).toBeUndefined()
        setOfflineUserId(1)
        expect(readQueue()).toEqual([])
    })
})

describe("offline layer (H3 — sync guard)", () => {
    beforeEach(() => {
        fetchMock.mockReset()
        network.onLine = true
        for (const key of Object.keys(storage)) {
            if (key !== "getItem" && key !== "setItem" && key !== "removeItem") delete storage[key]
        }
        setOfflineUserId(null)
        setOfflineUserId(1)
    })

    it("POSTs each queued task exactly once even when triggered concurrently (in-flight lock)", async () => {
        enqueueTask(queuedItem("خرید"))
        enqueueTask(queuedItem("ورزش"))
        fetchMock.mockResolvedValue({ ok: true })

        const results = await Promise.all([syncQueue(), syncQueue(), syncQueue()])

        expect(fetchMock).toHaveBeenCalledTimes(2) // mount + online + dp:synced → هنوز ۲ POST
        expect(results).toEqual([2, 2, 2]) // همه به همان اجرای در جریان پیوستند
        expect(readQueue()).toEqual([])
    })

    it("does not re-POST after a full drain (no duplicate delivery, no order guarantee claimed)", async () => {
        enqueueTask(queuedItem("خرید"))
        fetchMock.mockResolvedValue({ ok: true })

        await expect(syncQueue()).resolves.toBe(1)
        await expect(syncQueue()).resolves.toBe(0)

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(readQueue()).toEqual([])
    })

    it("keeps a failed item queued for a later retry (no silent data loss)", async () => {
        enqueueTask(queuedItem("خرید"))
        fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })

        await expect(syncQueue()).resolves.toBe(0)
        expect(readQueue()).toHaveLength(1)
    })

    it("does nothing while offline or without a session scope", async () => {
        network.onLine = false
        await expect(syncQueue()).resolves.toBe(0)

        network.onLine = true
        setOfflineUserId(null)
        await expect(syncQueue()).resolves.toBe(0)

        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("V1 contract: local-* ids and a Create-only { title, scheduledDate } payload (no dayKey)", async () => {
        const queued = enqueueTask(queuedItem("خرید"))
        expect(queued.id.startsWith("local-")).toBe(true)

        fetchMock.mockResolvedValue({ ok: true })
        await syncQueue()

        const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }]
        expect(url).toBe("/api/tasks")
        expect(init.method).toBe("POST")
        expect(bodyOf(fetchMock.mock.calls[0])).toEqual({
            title: "خرید",
            scheduledDate: SCHEDULED_DATE,
        })
        // dayKey هرگز از صف به سرور فرستاده نمی‌شود (§6.2.2.1 — سمت سرور ساخته می‌شود)
        expect(Object.keys(bodyOf(fetchMock.mock.calls[0]))).toEqual(["title", "scheduledDate"])
    })

    it("deduplicates an identical task instead of queueing it twice", () => {
        enqueueTask(queuedItem("خرید"))
        enqueueTask(queuedItem("خرید"))

        expect(readQueue()).toHaveLength(1)
    })

    it("backfills local storage per user only (queue key carries the user id)", () => {
        enqueueTask(queuedItem("خرید"))

        expect(storage["dp:offline:v3:queue:1"]).toBeDefined()
        expect(storage["dp:offline:v3:queue:2"]).toBeUndefined()
    })
})
