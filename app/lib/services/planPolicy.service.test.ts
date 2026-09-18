// فاز ۱ — تست‌های planPolicy.service
// پوشش: FREE=15، PRO=300، مقادیر نامعتبر/null، بازه‌ی ماهانه و مرز ماه‌ها.

import { describe, expect, it } from "vitest"

import { getMonthlyPeriod, resolvePlanPolicy } from "./planPolicy.service"

describe("resolvePlanPolicy", () => {
    it("FREE plan → 15 allowed units", () => {
        const policy = resolvePlanPolicy({ plan: "FREE" })
        expect(policy.plan).toBe("FREE")
        expect(policy.allowedUnits).toBe(15)
        expect(policy.periodType).toBe("MONTHLY")
    })

    it("PRO plan → 300 allowed units", () => {
        const policy = resolvePlanPolicy({ plan: "PRO" })
        expect(policy.plan).toBe("PRO")
        expect(policy.allowedUnits).toBe(300)
        expect(policy.periodType).toBe("MONTHLY")
    })

    it.each([
        ["null plan", null],
        ["undefined plan", undefined],
        ["unknown plan string", "ADMIN"],
        ["lowercase pro (invalid)", "pro"],
        ["empty string", ""],
    ])("%s → falls back to FREE/15", (_label, plan) => {
        const policy = resolvePlanPolicy({ plan: plan as string | null | undefined })
        expect(policy.plan).toBe("FREE")
        expect(policy.allowedUnits).toBe(15)
    })

    it("works when the plan key is absent entirely", () => {
        const policy = resolvePlanPolicy({})
        expect(policy.allowedUnits).toBe(15)
    })
})

describe("getMonthlyPeriod", () => {
    it("returns UTC month start at 00:00:00.000 for a mid-month instant", () => {
        const now = new Date("2026-09-16T13:45:00.000Z")
        const { periodStart, nextPeriodStart } = getMonthlyPeriod(now)

        expect(periodStart.toISOString()).toBe("2026-09-01T00:00:00.000Z")
        expect(nextPeriodStart.toISOString()).toBe("2026-10-01T00:00:00.000Z")
    })

    it("is stable exactly at the month boundary (start of month → same month)", () => {
        const now = new Date("2026-09-01T00:00:00.000Z")
        const { periodStart } = getMonthlyPeriod(now)
        expect(periodStart.toISOString()).toBe("2026-09-01T00:00:00.000Z")
    })

    it("rolls over exactly one millisecond after the boundary (end of month)", () => {
        const now = new Date("2026-09-30T23:59:59.999Z")
        const { periodStart, nextPeriodStart } = getMonthlyPeriod(now)
        expect(periodStart.toISOString()).toBe("2026-09-01T00:00:00.000Z")

        const after = new Date("2026-10-01T00:00:00.000Z")
        const rolled = getMonthlyPeriod(after)
        expect(rolled.periodStart.toISOString()).toBe("2026-10-01T00:00:00.000Z")
        expect(rolled.periodStart.toISOString()).toBe(nextPeriodStart.toISOString())
    })

    it("handles year rollover (December → January)", () => {
        const now = new Date("2026-12-15T10:00:00.000Z")
        const { periodStart, nextPeriodStart } = getMonthlyPeriod(now)
        expect(periodStart.toISOString()).toBe("2026-12-01T00:00:00.000Z")
        expect(nextPeriodStart.toISOString()).toBe("2027-01-01T00:00:00.000Z")
    })

    it("handles leap-year February (2024 → 29 days)", () => {
        const now = new Date("2024-02-10T00:00:00.000Z")
        const { periodStart, nextPeriodStart } = getMonthlyPeriod(now)
        expect(periodStart.toISOString()).toBe("2024-02-01T00:00:00.000Z")
        expect(nextPeriodStart.toISOString()).toBe("2024-03-01T00:00:00.000Z")
    })

    it("handles non-leap-year February (2026 → 28 days)", () => {
        const now = new Date("2026-02-28T23:59:59.999Z")
        const { periodStart, nextPeriodStart } = getMonthlyPeriod(now)
        expect(periodStart.toISOString()).toBe("2026-02-01T00:00:00.000Z")
        expect(nextPeriodStart.toISOString()).toBe("2026-03-01T00:00:00.000Z")
    })

    it("periodStart is always strictly before nextPeriodStart", () => {
        for (const month of [0, 3, 6, 11]) {
            const now = new Date(Date.UTC(2026, month, 15))
            const { periodStart, nextPeriodStart } = getMonthlyPeriod(now)
            expect(nextPeriodStart.getTime()).toBeGreaterThan(periodStart.getTime())
        }
    })
})

describe("getMonthlyPeriod — user timezone (فاز ۱ §۶)", () => {
    it("defaults to UTC and matches the previous UTC behavior (backward compatible)", () => {
        const now = new Date("2026-09-16T13:45:00.000Z")
        expect(getMonthlyPeriod(now)).toEqual(getMonthlyPeriod(now, "UTC"))
        expect(getMonthlyPeriod(now).periodStart.toISOString()).toBe("2026-09-01T00:00:00.000Z")
    })

    it("computes the local month start as a stable UTC instant (Asia/Tehran = UTC+03:30)", () => {
        const now = new Date("2026-09-16T13:45:00.000Z")
        const { periodStart, nextPeriodStart } = getMonthlyPeriod(now, "Asia/Tehran")

        // 2026-09-01T00:00:00+03:30 → 2026-08-31T20:30:00Z
        expect(periodStart.toISOString()).toBe("2026-08-31T20:30:00.000Z")
        expect(nextPeriodStart.toISOString()).toBe("2026-09-30T20:30:00.000Z")
    })

    it("stays in the current local month while the UTC clock is already at month end", () => {
        // UTC 2026-09-30T20:00Z → Tehran local 23:30 همان روز → هنوز September
        const now = new Date("2026-09-30T20:00:00.000Z")
        const { periodStart } = getMonthlyPeriod(now, "Asia/Tehran")
        expect(periodStart.toISOString()).toBe("2026-08-31T20:30:00.000Z")
    })

    it("rolls over at the user's local month boundary, not the UTC one", () => {
        // UTC 2026-09-30T21:00Z → Tehran local 2026-10-01T00:30 → اکتبر
        const now = new Date("2026-09-30T21:00:00.000Z")
        const { periodStart, nextPeriodStart } = getMonthlyPeriod(now, "Asia/Tehran")
        expect(periodStart.toISOString()).toBe("2026-09-30T20:30:00.000Z")
        expect(nextPeriodStart.toISOString()).toBe("2026-10-31T20:30:00.000Z")
    })

    it("gives a different period than a UTC user at the same instant (boundary correctness)", () => {
        const now = new Date("2026-09-30T21:00:00.000Z")
        expect(getMonthlyPeriod(now).periodStart.toISOString()).toBe("2026-09-01T00:00:00.000Z")
        expect(getMonthlyPeriod(now, "Asia/Tehran").periodStart.toISOString()).toBe(
            "2026-09-30T20:30:00.000Z",
        )
    })

    it("handles year rollover in the user's timezone (December → January)", () => {
        const now = new Date("2026-12-15T10:00:00.000Z")
        const { periodStart, nextPeriodStart } = getMonthlyPeriod(now, "Asia/Tehran")
        expect(periodStart.toISOString()).toBe("2026-11-30T20:30:00.000Z")
        expect(nextPeriodStart.toISOString()).toBe("2026-12-31T20:30:00.000Z")
    })

    it("falls back to UTC for an invalid/empty timezone (fail-safe, no throw)", () => {
        const now = new Date("2026-09-16T13:45:00.000Z")
        expect(getMonthlyPeriod(now, "Not/AZone").periodStart.toISOString()).toBe(
            "2026-09-01T00:00:00.000Z",
        )
        expect(getMonthlyPeriod(now, "").periodStart.toISOString()).toBe(
            "2026-09-01T00:00:00.000Z",
        )
    })

    it("keeps periodStart strictly before nextPeriodStart across timezones", () => {
        for (const tz of ["UTC", "Asia/Tehran", "America/New_York", "Europe/Berlin"]) {
            const { periodStart, nextPeriodStart } = getMonthlyPeriod(
                new Date("2026-03-15T00:00:00.000Z"),
                tz,
            )
            expect(nextPeriodStart.getTime()).toBeGreaterThan(periodStart.getTime())
        }
    })
})
