import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* Step 2C - route tests: GET /api/coach/weekly.                      */
/*                                                                    */
/* getWeeklyCoachReport is mocked. resolveCoachTimezone and the real   */
/* calendar helpers (isValidCanonicalDayKey/isWeekStart/weekStartOf)   */
/* run for real, so validation and default-week calculation are tested */
/* end-to-end. getCanonicalToday is pinned to control "today".         */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getWeeklyCoachReport: vi.fn(),
    getCanonicalToday: vi.fn(),
    recordError: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
// The real coach service module is imported for resolveCoachTimezone only;
// this prevents it from constructing a Prisma client in unit tests.
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: () => ({}) }))
vi.mock("@/app/lib/services/coach.service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/lib/services/coach.service")>()
    return { ...actual, getWeeklyCoachReport: mocks.getWeeklyCoachReport }
})
vi.mock("@/app/lib/canonicalDay", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/lib/canonicalDay")>()
    return { ...actual, getCanonicalToday: mocks.getCanonicalToday }
})
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))

import { PASSWORD_CHANGE_REQUIRED_CODE } from "@/app/lib/requireVerifiedUser"
import * as routeModule from "./route"

const ENDPOINT = "http://localhost/api/coach/weekly"

const USER = {
    id: 42,
    username: "coach-user",
    email: "coach@example.com",
    timezone: "Asia/Tehran",
    mustChangePassword: false,
}

const TODAY = "2026-11-03" // Tuesday
const WEEK_START = "2026-10-31" // Saturday
const WEEK_END = "2026-11-06"

const REPORT = {
    kind: "weekly",
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    coveredThrough: TODAY,
    state: "OK",
    days: [
        { dayKey: "2026-10-31", hasPlan: true, doneTasks: 2, openTasks: 1, isCovered: true },
        { dayKey: "2026-11-01", hasPlan: true, doneTasks: 1, openTasks: 1, isCovered: true },
        { dayKey: "2026-11-02", hasPlan: false, doneTasks: 1, openTasks: 0, isCovered: true },
        { dayKey: "2026-11-03", hasPlan: true, doneTasks: 3, openTasks: 1, isCovered: true },
        { dayKey: "2026-11-04", hasPlan: false, doneTasks: 0, openTasks: 0, isCovered: false },
        { dayKey: "2026-11-05", hasPlan: false, doneTasks: 0, openTasks: 0, isCovered: false },
        { dayKey: "2026-11-06", hasPlan: false, doneTasks: 0, openTasks: 0, isCovered: false },
    ],
    facts: {
        doneTotal: 7,
        openTotal: 3,
        totalTasks: 10,
        timedDoneTasks: 5,
        completionPct: 70,
        spentTotal: 200,
        savedTotal: 20,
        overspentTotal: 10,
        coveredDayCount: 4,
        plannedDays: 3,
        activeDays: 4,
        peakDayKey: "2026-11-03",
        peakDayDoneTasks: 3,
    },
    insights: [
        {
            id: "WEEK_PEAK_DAY",
            params: { dayKey: "2026-11-03", doneTasks: 3 },
        },
        {
            id: "WEEK_COMPLETION",
            params: { completionPct: 70, doneTasks: 7, openTasks: 3 },
        },
        {
            id: "WEEK_SAVED",
            params: { savedMinutes: 20, timedDoneTasks: 5, doneTasks: 7 },
        },
    ],
    dataQuality: {
        approximate: true,
        partialTimeCoverage: true,
        reasons: ["PAST_DAY_ROLLOVER", "PARTIAL_TIME_COVERAGE"],
    },
}

function call(url = ENDPOINT) {
    return routeModule.GET(new NextRequest(url))
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCurrentUser.mockResolvedValue(USER)
    mocks.getCanonicalToday.mockReturnValue(TODAY)
    mocks.getWeeklyCoachReport.mockResolvedValue(REPORT)
    mocks.recordError.mockResolvedValue(undefined)
})

/* ============================== success ============================== */

describe("GET /api/coach/weekly - success", () => {
    it("defaults to the Saturday of the current week when weekStart is omitted", async () => {
        const res = await call()

        expect(res.status).toBe(200)
        expect(mocks.getCanonicalToday).toHaveBeenCalledWith("Asia/Tehran")
        expect(mocks.getWeeklyCoachReport).toHaveBeenCalledWith({
            userId: 42,
            weekStart: WEEK_START,
            todayKey: TODAY,
        })
        await expect(res.json()).resolves.toEqual({ ok: true, data: REPORT })
    })

    it("keeps today itself when today is already a Saturday", async () => {
        mocks.getCanonicalToday.mockReturnValue("2026-10-31")

        const res = await call()

        expect(res.status).toBe(200)
        expect(mocks.getWeeklyCoachReport).toHaveBeenCalledWith({
            userId: 42,
            weekStart: "2026-10-31",
            todayKey: "2026-10-31",
        })
    })

    it("accepts an explicit valid Saturday in a previous week", async () => {
        const res = await call(`${ENDPOINT}?weekStart=2026-10-24`)

        expect(res.status).toBe(200)
        expect(mocks.getWeeklyCoachReport).toHaveBeenCalledWith({
            userId: 42,
            weekStart: "2026-10-24",
            todayKey: TODAY,
        })
        await expect(res.json()).resolves.toEqual({ ok: true, data: REPORT })
    })

    it("accepts the current week's Saturday exactly (boundary)", async () => {
        const res = await call(`${ENDPOINT}?weekStart=${WEEK_START}`)

        expect(res.status).toBe(200)
        expect(mocks.getWeeklyCoachReport).toHaveBeenCalledWith({
            userId: 42,
            weekStart: WEEK_START,
            todayKey: TODAY,
        })
    })

    it("sets X-Request-ID and Cache-Control: no-store on success", async () => {
        const res = await call()

        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
        expect(res.headers.get("Cache-Control")).toBe("no-store")
    })

    it("returns the Coach DTO unchanged with no extra fields or PII", async () => {
        const res = await call()
        const body = await res.json()

        expect(body).toEqual({ ok: true, data: REPORT })
        expect(Object.keys(body).sort()).toEqual(["data", "ok"])

        const text = JSON.stringify(body)
        expect(text).not.toContain(USER.email)
        expect(text).not.toContain(USER.username)
        expect(text).not.toContain(USER.timezone)
        expect(text).not.toContain('"userId"')
        expect(text).not.toContain('"title"')
        expect(text).not.toContain('"taskId"')
    })

    it("returns 200 for both domain states OK and NO_DATA", async () => {
        for (const state of ["OK", "NO_DATA"]) {
            mocks.getWeeklyCoachReport.mockResolvedValueOnce({ ...REPORT, state })

            const res = await call()

            expect(res.status).toBe(200)
            await expect(res.json()).resolves.toEqual({
                ok: true,
                data: { ...REPORT, state },
            })
        }
    })
})

/* ============================ auth & scope ============================ */

describe("GET /api/coach/weekly - authentication", () => {
    it("returns 401 UNAUTHORIZED without a session and never calls the service", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await call(`${ENDPOINT}?weekStart=${WEEK_START}`)

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(res.headers.get("Cache-Control")).toBe("no-store")
        expect(mocks.getWeeklyCoachReport).not.toHaveBeenCalled()
    })

    it("returns 403 PASSWORD_CHANGE_REQUIRED and never calls the service", async () => {
        mocks.getCurrentUser.mockResolvedValue({
            ...USER,
            mustChangePassword: true,
        })

        const res = await call(`${ENDPOINT}?weekStart=${WEEK_START}`)

        expect(res.status).toBe(403)
        const body = await res.json()
        expect(body.ok).toBe(false)
        expect(body.error.code).toBe(PASSWORD_CHANGE_REQUIRED_CODE)
        expect(res.headers.get("Cache-Control")).toBe("no-store")
        expect(mocks.getWeeklyCoachReport).not.toHaveBeenCalled()
    })

    it("uses only the session userId/tz and ignores query or header identity input", async () => {
        const res = await routeModule.GET(
            new NextRequest(
                `${ENDPOINT}?weekStart=2026-10-24&userId=999&timezone=UTC`,
                {
                    headers: {
                        "x-user-id": "999",
                        "x-timezone": "UTC",
                    },
                },
            ),
        )

        expect(res.status).toBe(200)
        expect(mocks.getWeeklyCoachReport).toHaveBeenCalledWith({
            userId: 42,
            weekStart: "2026-10-24",
            todayKey: TODAY,
        })
        expect(mocks.getCanonicalToday).toHaveBeenCalledWith("Asia/Tehran")
    })
})

/* ============================ validation ============================ */

describe("GET /api/coach/weekly - validation", () => {
    it("rejects malformed weekStart formats before calling the service", async () => {
        for (const bad of ["11-01-2026", "2026-11-3", ""]) {
            const res = await call(`${ENDPOINT}?weekStart=${bad}`)

            expect(res.status).toBe(400)
            const body = await res.json()
            expect(body.ok).toBe(false)
            expect(body.error.code).toBe("VALIDATION_ERROR")
            expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
            expect(res.headers.get("Cache-Control")).toBe("no-store")
        }

        expect(mocks.getWeeklyCoachReport).not.toHaveBeenCalled()
    })

    it("rejects calendar-invalid weekStart values", async () => {
        for (const bad of ["2026-02-30", "2026-13-01"]) {
            const res = await call(`${ENDPOINT}?weekStart=${bad}`)

            expect(res.status).toBe(400)
            await expect(res.json()).resolves.toMatchObject({
                ok: false,
                error: { code: "VALIDATION_ERROR" },
            })
        }

        expect(mocks.getWeeklyCoachReport).not.toHaveBeenCalled()
    })

    it("rejects a valid date that is not Saturday", async () => {
        for (const notSaturday of ["2026-11-01", "2026-11-03"]) {
            const res = await call(`${ENDPOINT}?weekStart=${notSaturday}`)

            expect(res.status).toBe(400)
            const body = await res.json()
            expect(body.error.code).toBe("VALIDATION_ERROR")
            expect(body.error.message).toContain("شنبه")
        }

        expect(mocks.getWeeklyCoachReport).not.toHaveBeenCalled()
    })

    it("rejects a future week before calling the service", async () => {
        const res = await call(`${ENDPOINT}?weekStart=2026-11-07`)

        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.getWeeklyCoachReport).not.toHaveBeenCalled()
    })

    it("rejects duplicate weekStart parameters even when the values are identical", async () => {
        const duplicateUrls = [
            `${ENDPOINT}?weekStart=${WEEK_START}&weekStart=2026-10-24`,
            `${ENDPOINT}?weekStart=${WEEK_START}&weekStart=${WEEK_START}`,
        ]

        for (const url of duplicateUrls) {
            const res = await call(url)

            expect(res.status).toBe(400)
            const body = await res.json()
            expect(body.ok).toBe(false)
            expect(body.error.code).toBe("VALIDATION_ERROR")
            expect(res.headers.get("Cache-Control")).toBe("no-store")
        }

        expect(mocks.getWeeklyCoachReport).not.toHaveBeenCalled()
    })
})

/* ============================ error mapping ============================ */

describe("GET /api/coach/weekly - error mapping", () => {
    it("returns 500 USER_TIMEZONE_INVALID for an invalid stored timezone, without leaking it", async () => {
        for (const timezone of ["Mars/Olympus", "", null, 123]) {
            mocks.getCurrentUser.mockResolvedValueOnce({ ...USER, timezone })

            const res = await call(`${ENDPOINT}?weekStart=${WEEK_START}`)

            expect(res.status).toBe(500)
            const body = await res.json()
            expect(body).toEqual({
                ok: false,
                error: {
                    code: "USER_TIMEZONE_INVALID",
                    message: expect.any(String),
                },
            })

            if (typeof timezone === "string" && timezone.length > 0) {
                expect(JSON.stringify(body)).not.toContain(timezone)
            }
            expect(res.headers.get("Cache-Control")).toBe("no-store")
        }

        expect(mocks.getCanonicalToday).not.toHaveBeenCalled()
        expect(mocks.getWeeklyCoachReport).not.toHaveBeenCalled()
    })

    it("maps a Prisma-style failure to the generic 500 INTERNAL without leaking details", async () => {
        const error = new Error("P1001: can't reach database server prisma://secret")
        mocks.getWeeklyCoachReport.mockRejectedValue(error)

        const res = await call(`${ENDPOINT}?weekStart=${WEEK_START}`)

        expect(res.status).toBe(500)
        const body = await res.json()
        expect(body).toEqual({
            ok: false,
            error: { code: "INTERNAL", message: "Server error" },
        })

        const text = JSON.stringify(body)
        expect(text).not.toContain("P1001")
        expect(text).not.toContain("prisma://")
        expect(text).not.toContain("stack")
        expect(mocks.recordError).toHaveBeenCalledWith(
            error,
            expect.objectContaining({
                endpoint: "/api/coach/weekly",
                feature: "coach",
                userId: 42,
            }),
        )
    })

    it("maps an engine invariant RangeError to 500 INTERNAL without leaking it", async () => {
        mocks.getWeeklyCoachReport.mockRejectedValue(new RangeError("INVALID:days"))

        const res = await call(`${ENDPOINT}?weekStart=${WEEK_START}`)

        expect(res.status).toBe(500)
        const text = JSON.stringify(await res.json())
        expect(text).not.toContain("INVALID:days")
        expect(JSON.parse(text).error.code).toBe("INTERNAL")
        expect(res.headers.get("Cache-Control")).toBe("no-store")
    })

    it("maps a per-row corrupt-data RangeError to 500 INTERNAL without leaking it", async () => {
        mocks.getWeeklyCoachReport.mockRejectedValue(new RangeError("INVALID:availableMinutes"))

        const res = await call(`${ENDPOINT}?weekStart=${WEEK_START}`)

        expect(res.status).toBe(500)
        const body = await res.json()
        expect(body).toEqual({
            ok: false,
            error: { code: "INTERNAL", message: "Server error" },
        })

        const text = JSON.stringify(body)
        expect(text).not.toContain("INVALID")
        expect(text).not.toContain("availableMinutes")
        expect(text).not.toContain("spentMinutes")
        expect(text).not.toContain("allocatedMinutes")
        expect(text).not.toContain("taskId")
        expect(text).not.toContain("title")
        expect(text).not.toContain("stack")
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
        expect(res.headers.get("Cache-Control")).toBe("no-store")
        expect(mocks.recordError).toHaveBeenCalled()
    })

    it("maps an authentication lookup infrastructure failure to 500 INTERNAL, not 401", async () => {
        mocks.getCurrentUser.mockRejectedValue(new Error("db down"))

        const res = await call(`${ENDPOINT}?weekStart=${WEEK_START}`)

        expect(res.status).toBe(500)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "INTERNAL", message: "Server error" },
        })
        expect(mocks.getWeeklyCoachReport).not.toHaveBeenCalled()
    })
})

/* ============================ method surface ============================ */

describe("GET /api/coach/weekly - method surface", () => {
    it("exports only GET; other verbs are left to Next.js 405 handling", () => {
        expect(typeof routeModule.GET).toBe("function")
        expect(routeModule).not.toHaveProperty("POST")
        expect(routeModule).not.toHaveProperty("PUT")
        expect(routeModule).not.toHaveProperty("PATCH")
        expect(routeModule).not.toHaveProperty("DELETE")
    })
})
