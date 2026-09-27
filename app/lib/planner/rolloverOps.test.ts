import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* Phase 4.4 — rolloverOps (pure core of rollover)                    */
/* ------------------------------------------------------------------ */
/* این ماژول هیچ I/O ای ندارد: فقط «شرحِ نوشتن» را از روی تسک‌های خوانده‌شده */
/* تولید می‌کند. هر دو مسیرِ مصرف‌کننده (rolloverTasks با تراکنش خودش، و      */
/* applyPlan داخل تراکنش Apply) دقیقاً از همین هسته استفاده می‌کنند.            */
/* ------------------------------------------------------------------ */

import { buildRolloverOps } from "./rolloverOps"
import { canonicalKeyToLocalMidnight, shiftCanonicalKey } from "@/app/lib/canonicalDay"

const TIMEZONE = "Asia/Tehran"
const FROM = "2026-09-27"
const TO = "2026-09-28"

const source = (overrides: Partial<Parameters<typeof buildRolloverOps>[0][number]> = {}) => ({
    id: 1,
    dayKey: FROM,
    scheduledDate: canonicalKeyToLocalMidnight(FROM, TIMEZONE),
    allocatedMinutes: 30,
    ...overrides,
})

describe("buildRolloverOps — pure write-plan (no I/O)", () => {
    it("moves dayKey to the requested destination and resets the allocation", () => {
        const { taskOps } = buildRolloverOps([source()], TO, TIMEZONE)

        expect(taskOps).toHaveLength(1)
        expect(taskOps[0]).toMatchObject({
            taskId: 1,
            fromDayKey: FROM,
            toDayKey: TO,
            allocatedMinutes: null,
        })
    })

    it("computes scheduledDate as local midnight of the destination (DST-correct helper)", () => {
        const { taskOps } = buildRolloverOps([source()], TO, TIMEZONE)

        expect(taskOps[0].scheduledDate).toEqual(canonicalKeyToLocalMidnight(TO, TIMEZONE))
        expect(taskOps[0].scheduledDate).not.toEqual(canonicalKeyToLocalMidnight(FROM, TIMEZONE))
    })

    it("keeps the previous scheduledDate so rollover stays detectable", () => {
        const original = canonicalKeyToLocalMidnight(FROM, TIMEZONE)

        const { taskOps } = buildRolloverOps([source({ scheduledDate: original })], TO, TIMEZONE)

        expect(taskOps[0].previousScheduledDate).toEqual(original)
    })

    it("emits one ROLLED_OVER event per task with the from/to payload", () => {
        const { eventOps } = buildRolloverOps([source()], TO, TIMEZONE)

        expect(eventOps).toEqual([{ taskId: 1, fromDayKey: FROM, toDayKey: TO }])
    })

    it("never carries AI/ownership fields into the write plan (planning-only move)", () => {
        const { taskOps } = buildRolloverOps([source()], TO, TIMEZONE)

        for (const forbidden of ["score", "priority", "estimatedTime", "reason", "category", "status", "userId"]) {
            expect(taskOps[0]).not.toHaveProperty(forbidden)
        }
    })

    it("reports the moved summary (id/from/to) alongside the ops", () => {
        const { moved } = buildRolloverOps([source()], TO, TIMEZONE)

        expect(moved).toEqual([{ id: 1, from: FROM, to: TO }])
    })

    it("handles multiple tasks, preserving input order and per-task previousScheduledDate", () => {
        const s1 = canonicalKeyToLocalMidnight(FROM, TIMEZONE)
        const s2 = new Date("2026-09-27T09:00:00.000Z")

        const { taskOps, eventOps, moved } = buildRolloverOps(
            [source({ id: 1, scheduledDate: s1 }), source({ id: 2, scheduledDate: s2, allocatedMinutes: 0 })],
            TO,
            TIMEZONE,
        )

        expect(moved).toEqual([
            { id: 1, from: FROM, to: TO },
            { id: 2, from: FROM, to: TO },
        ])
        expect(taskOps.map((op) => op.taskId)).toEqual([1, 2])
        expect(taskOps[1].previousScheduledDate).toEqual(s2)
        expect(eventOps.map((op) => op.taskId)).toEqual([1, 2])
    })

    it("accepts a destination far in the future (past-day proposal) without clamping to today", () => {
        const destination = shiftCanonicalKey("2026-01-15", 1)

        const { taskOps, moved } = buildRolloverOps(
            [source({ dayKey: "2026-01-15" })],
            destination,
            TIMEZONE,
        )

        expect(destination).toBe("2026-01-16")
        expect(moved).toEqual([{ id: 1, from: "2026-01-15", to: "2026-01-16" }])
        expect(taskOps[0].scheduledDate).toEqual(canonicalKeyToLocalMidnight("2026-01-16", TIMEZONE))
    })

    it("crosses month/year boundaries through the canonical helper (2026-12-31 → 2027-01-01)", () => {
        const { taskOps, moved } = buildRolloverOps(
            [source({ dayKey: "2026-12-31" })],
            shiftCanonicalKey("2026-12-31", 1),
            TIMEZONE,
        )

        expect(moved[0].to).toBe("2027-01-01")
        expect(taskOps[0].scheduledDate).toEqual(canonicalKeyToLocalMidnight("2027-01-01", TIMEZONE))
    })

    it("crosses the leap-day boundary (2028-02-28 → 2028-02-29)", () => {
        const { moved } = buildRolloverOps(
            [source({ dayKey: "2028-02-28" })],
            shiftCanonicalKey("2028-02-28", 1),
            TIMEZONE,
        )

        expect(moved[0].to).toBe("2028-02-29")
    })

    it("produces no ops for an empty task list", () => {
        const result = buildRolloverOps([], TO, TIMEZONE)

        expect(result).toEqual({ moved: [], taskOps: [], eventOps: [] })
    })

    it("tolerates a task whose allocation is already null", () => {
        const { taskOps } = buildRolloverOps([source({ allocatedMinutes: null })], TO, TIMEZONE)

        expect(taskOps[0].allocatedMinutes).toBeNull()
    })
})
