import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
    cacheDay,
    getOfflineUserId,
    readAllCachedDays,
    readQueue,
    setOfflineUserId,
} from "./offline"
import type { TaskItem } from "@/app/components/task/taskTypes"

/* ------------------------------------------------------------------ */
/* ADR-07 فاز ۴-A — readAllCachedDays (فقط خواندن، user-scoped).        */
/* محیط node بدون DOM: یک localStorage ساختگی روی globalThis نصب می‌شود. */
/* ------------------------------------------------------------------ */

function makeStorage() {
    const storage: Record<string, unknown> = {}

    Object.defineProperty(storage, "getItem", {
        value: (key: string) => (key in storage ? String(storage[key]) : null),
        enumerable: false,
    })
    Object.defineProperty(storage, "setItem", {
        value: (key: string, value: string) => {
            storage[key] = String(value)
        },
        enumerable: false,
    })
    Object.defineProperty(storage, "removeItem", {
        value: (key: string) => {
            delete storage[key]
        },
        enumerable: false,
    })

    return storage as unknown as Storage
}

function installWindow(storage: Storage) {
    ;(globalThis as unknown as { window: unknown }).window = { localStorage: storage }
}

const CACHE_PREFIX = "dp:offline:v3:day"

const taskItem = (id: number, overrides: Partial<TaskItem> = {}): TaskItem => ({
    id,
    title: `کار ${id}`,
    category: null,
    priority: null,
    score: null,
    reason: null,
    status: "TODO",
    dayKey: "2026-09-22",
    estimatedTime: null,
    allocatedMinutes: null,
    spentMinutes: null,
    completedOn: null,
    reminderAt: null,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
})

let storage: Storage

beforeEach(() => {
    storage = makeStorage()
    installWindow(storage)
    setOfflineUserId(null)
})

afterEach(() => {
    setOfflineUserId(null)
    delete (globalThis as unknown as { window?: unknown }).window
})

describe("readAllCachedDays", () => {
    it("returns nothing when the session scope is unknown", () => {
        storage.setItem(`${CACHE_PREFIX}:7:2026-09-22`, JSON.stringify({ tasks: [taskItem(1)], summary: null, savedAt: "x" }))

        expect(readAllCachedDays()).toEqual([])
    })

    it("reads every cached day of the current user", () => {
        setOfflineUserId(7)
        cacheDay("2026-09-22", [taskItem(1)], null)
        cacheDay("2026-09-23", [taskItem(2)], null)

        const days = readAllCachedDays()

        expect(days).toHaveLength(2)
        expect(days.flatMap((day) => day.tasks.map((task) => task.id)).sort()).toEqual([1, 2])
        expect(getOfflineUserId()).toBe(7)
    })

    it("never reads another user's cached days", () => {
        setOfflineUserId(9)
        cacheDay("2026-09-22", [taskItem(99)], null)
        setOfflineUserId(7)
        cacheDay("2026-09-22", [taskItem(1)], null)

        const ids = readAllCachedDays().flatMap((day) => day.tasks.map((task) => task.id))

        expect(ids).toEqual([1])
    })

    it("ignores corrupt cache entries instead of throwing", () => {
        setOfflineUserId(7)
        storage.setItem(`${CACHE_PREFIX}:7:2026-09-22`, "{broken json")
        cacheDay("2026-09-23", [taskItem(2)], null)

        expect(readAllCachedDays().flatMap((day) => day.tasks.map((task) => task.id))).toEqual([2])
    })

    it("does not touch the offline create queue", () => {
        setOfflineUserId(7)
        cacheDay("2026-09-22", [taskItem(1)], null)
        storage.setItem(
            "dp:offline:v3:queue:7",
            JSON.stringify([{ id: "local-1", title: "صفی", dayKey: "2026-09-22", scheduledDate: "2026-09-21T20:30:00.000Z", createdAt: "x" }]),
        )

        expect(readAllCachedDays()).toHaveLength(1)
        expect(readQueue()).toHaveLength(1)
        expect(storage.getItem("dp:offline:v3:queue:7")).not.toBeNull()
    })
})
