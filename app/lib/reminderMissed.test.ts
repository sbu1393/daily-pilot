import { describe, expect, it } from "vitest"
import {
    findMissedReminders,
    MAX_MISSED_TOASTS,
    MISSED_REMINDER_WINDOW_MS,
    type ReminderSourceTask,
} from "./reminderMissed"
import { reminderFiredKey } from "./reminderFired"

/* ------------------------------------------------------------------ */
/* ADR-07 فاز ۴-A — Missed-Reminder Reconciler (منطق خالص).             */
/* ------------------------------------------------------------------ */

const NOW = new Date("2026-09-22T10:00:00.000Z")

const task = (
    id: number,
    reminderAt: string | null,
    overrides: Partial<ReminderSourceTask> = {},
): ReminderSourceTask => ({
    id,
    title: `کار ${id}`,
    status: "TODO",
    reminderAt,
    ...overrides,
})

const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString()

describe("findMissedReminders — زمان‌ها", () => {
    it("ignores future reminders", () => {
        const future = new Date(NOW.getTime() + 60_000).toISOString()

        expect(findMissedReminders([task(1, future)], NOW)).toEqual([])
    })

    it("reports a reminder inside the missed window", () => {
        const found = findMissedReminders([task(1, at(60 * 60 * 1000))], NOW)

        expect(found).toHaveLength(1)
        expect(found[0]).toMatchObject({ taskId: 1, title: "کار 1" })
        expect(found[0].key).toBe(reminderFiredKey(1, at(60 * 60 * 1000)))
    })

    it("treats the exact window boundary as inside (inclusive, same as the server)", () => {
        expect(findMissedReminders([task(1, at(MISSED_REMINDER_WINDOW_MS))], NOW)).toHaveLength(1)
    })

    it("ignores a reminder just outside the window", () => {
        expect(findMissedReminders([task(1, at(MISSED_REMINDER_WINDOW_MS + 1))], NOW)).toEqual([])
    })

    it("honours a custom window", () => {
        const fiveMinutes = 5 * 60 * 1000

        expect(findMissedReminders([task(1, at(fiveMinutes - 1))], NOW, { windowMs: fiveMinutes })).toHaveLength(1)
        expect(findMissedReminders([task(1, at(fiveMinutes + 1))], NOW, { windowMs: fiveMinutes })).toEqual([])
    })

    it("ignores invalid reminder instants", () => {
        expect(findMissedReminders([task(1, "not-a-date")], NOW)).toEqual([])
    })
})

describe("findMissedReminders — وضعیت و فیلدها", () => {
    it("ignores DONE tasks", () => {
        expect(findMissedReminders([task(1, at(1000), { status: "DONE" })], NOW)).toEqual([])
    })

    it("keeps open tasks (TODO and IN_PROGRESS)", () => {
        const found = findMissedReminders(
            [task(1, at(2000), { status: "TODO" }), task(2, at(1000), { status: "IN_PROGRESS" })],
            NOW,
        )

        expect(found.map((item) => item.taskId)).toEqual([1, 2])
    })

    it("ignores tasks without a reminder", () => {
        expect(findMissedReminders([task(1, null)], NOW)).toEqual([])
    })
})

describe("findMissedReminders — تکرار", () => {
    it("skips reminders already recorded in the shared fired namespace", () => {
        const iso = at(1000)
        const fired = new Set([reminderFiredKey(1, iso)])

        expect(findMissedReminders([task(1, iso)], NOW, { fired })).toEqual([])
    })

    it("collapses the same task cached in two different days into one entry", () => {
        const iso = at(1000)

        expect(findMissedReminders([task(1, iso), task(1, iso)], NOW)).toHaveLength(1)
    })

    it("reports a NEW key after reminderAt changes, even if the old key is fired", () => {
        const oldIso = at(2000)
        const newIso = at(1000)
        const fired = new Set([reminderFiredKey(1, oldIso)])

        const found = findMissedReminders([task(1, newIso)], NOW, { fired })

        expect(found).toHaveLength(1)
        expect(found[0].key).toBe(reminderFiredKey(1, newIso))
    })

    it("sorts oldest first and supports a limit", () => {
        const tasks = [task(3, at(1000)), task(1, at(5000)), task(2, at(3000))]

        expect(findMissedReminders(tasks, NOW).map((item) => item.taskId)).toEqual([1, 2, 3])
        expect(findMissedReminders(tasks, NOW, { limit: 2 }).map((item) => item.taskId)).toEqual([1, 2])
    })

    it("exposes a small toast budget to avoid a notification storm", () => {
        expect(MAX_MISSED_TOASTS).toBeGreaterThan(0)
        expect(MAX_MISSED_TOASTS).toBeLessThanOrEqual(5)
    })
})
