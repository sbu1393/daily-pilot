import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* Step 2B - route tests: GET /api/coach/daily.                       */
/*                                                                    */
/* The Coach service is mocked (no DB) but resolveCoachTimezone stays  */
/* real so the USER_TIMEZONE_INVALID path is exercised end-to-end.     */
/* getCanonicalToday is mocked to pin "today"; dayKey validation is    */
/* real.                                                               */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getDailyCoachReport: vi.fn(),
    getCanonicalToday: vi.fn(),
    recordError: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
// The real coach service module is imported for resolveCoachTimezone only;
// this prevents it from constructing a Prisma client in unit tests.
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: () => ({}) }))
vi.mock("@/app/lib/services/coach.service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/lib/services/coach.service")>()
    return { ...actual, getDailyCoachReport: mocks.getDailyCoachReport }
})
vi.mock("@/app/lib/canonicalDay", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/lib/canonicalDay")>()
    return { ...actual, getCanonicalToday: mocks.getCanonicalToday }
})
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))

import { PASSWORD_CHANGE_REQUIRED_CODE } from "@/app/lib/requireVerifiedUser"
import * as routeModule from "./route"

const ENDPOINT = "http://localhost/api/coach/daily"

const USER = {
    id: 42,
    username: "coach-user",
    email: "coach@example.com",
    timezone: "Asia/Tehran",
    mustChangePassword: false,
}

const TODAY = "2026-11-03"
const DAY_KEY = "2026-11-02"

const REPORT = {
    kind: "daily",
    dayKey: DAY_KEY,
    state: "OK",
    facts: {
        doneTasks: 2,
        openTasks: 1,
        totalTasks: 3,
        timedDoneTasks: 2,
        completionPct: 67,
        spentMinutes: 90,
        savedMinutes: 10,
        overspentMinutes: 5,
        budget: { availableMinutes: 240, committedMinutes: 60 },
        poolMinutes: 90,
        overCommittedMinutes: 0,
    },
    insights: [
        {
            id: "DAILY_SAVED",
            params: { savedMinutes: 10, timedDoneTasks: 2, doneTasks: 2 },
        },
    ],
    dataQuality: {
        approximate: false,
        partialTimeCoverage: false,
        reasons: [],
    },
}

function call(url = ENDPOINT) {
    return routeModule.GET(new NextRequest(url))
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCurrentUser.mockResolvedValue(USER)
    mocks.getCanonicalToday.mockReturnValue(TODAY)
    mocks.getDailyCoachReport.mockResolvedValue(REPORT)
    mocks.recordError.mockResolvedValue(undefined)
})

/* ============================== success ============================== */

describe("GET /api/coach/daily - success", () => {
    it("uses the authenticated user's timezone and today when dayKey is omitted", async () => {
        const res = await call()

        expect(res.status).toBe(200)
        expect(mocks.getCanonicalToday).toHaveBeenCalledWith("Asia/Tehran")
        expect(mocks.getDailyCoachReport).toHaveBeenCalledWith({
            userId: 42,
            dayKey: TODAY,
            todayKey: TODAY,
        })
        await expect(res.json()).resolves.toEqual({ ok: true, data: REPORT })
    })

    it("accepts a valid explicit dayKey and passes it with todayKey", async () => {
        const res = await call(`${ENDPOINT}?dayKey=${DAY_KEY}`)

        expect(res.status).toBe(200)
        expect(mocks.getDailyCoachReport).toHaveBeenCalledWith({
            userId: 42,
            dayKey: DAY_KEY,
            todayKey: TODAY,
        })
        await expect(res.json()).resolves.toEqual({ ok: true, data: REPORT })
    })

    it("accepts dayKey equal to today (boundary, not a future day)", async () => {
        const res = await call(`${ENDPOINT}?dayKey=${TODAY}`)

        expect(res.status).toBe(200)
        expect(mocks.getDailyCoachReport).toHaveBeenCalledWith({
            userId: 42,
            dayKey: TODAY,
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

    it("returns 200 for domain states NO_PLAN and NO_TASKS", async () => {
        for (const state of ["NO_PLAN", "NO_TASKS"]) {
            mocks.getDailyCoachReport.mockResolvedValueOnce({ ...REPORT, state })

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

describe("GET /api/coach/daily - authentication", () => {
    it("returns 401 UNAUTHORIZED without a session and never calls the service", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await call(`${ENDPOINT}?dayKey=${DAY_KEY}`)

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(res.headers.get("Cache-Control")).toBe("no-store")
        expect(mocks.getDailyCoachReport).not.toHaveBeenCalled()
    })

    it("returns 403 PASSWORD_CHANGE_REQUIRED and never calls the service", async () => {
        mocks.getCurrentUser.mockResolvedValue({
            ...USER,
            mustChangePassword: true,
        })

        const res = await call(`${ENDPOINT}?dayKey=${DAY_KEY}`)

        expect(res.status).toBe(403)
        const body = await res.json()
        expect(body.ok).toBe(false)
        expect(body.error.code).toBe(PASSWORD_CHANGE_REQUIRED_CODE)
        expect(res.headers.get("Cache-Control")).toBe("no-store")
        expect(mocks.getDailyCoachReport).not.toHaveBeenCalled()
    })

    it("uses only the session userId and ignores userId/timezone query or header input", async () => {
        const res = await routeModule.GET(
            new NextRequest(
                `${ENDPOINT}?dayKey=${DAY_KEY}&userId=999&timezone=UTC`,
                { headers: { "x-timezone": "UTC" } },
            ),
        )

        expect(res.status).toBe(200)
        expect(mocks.getDailyCoachReport).toHaveBeenCalledWith({
            userId: 42,
            dayKey: DAY_KEY,
            todayKey: TODAY,
        })
        expect(mocks.getCanonicalToday).toHaveBeenCalledWith("Asia/Tehran")
    })
})

/* ============================ validation ============================ */

describe("GET /api/coach/daily - validation", () => {
    it("returns 400 VALIDATION_ERROR for malformed or calendar-invalid dayKey", async () => {
        for (const bad of ["2026-02-30", "2026-13-01", "01-01-2026", ""]) {
            const res = await call(`${ENDPOINT}?dayKey=${bad}`)

            expect(res.status).toBe(400)
            const body = await res.json()
            expect(body.ok).toBe(false)
            expect(body.error.code).toBe("VALIDATION_ERROR")
            expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
            expect(res.headers.get("Cache-Control")).toBe("no-store")
        }

        expect(mocks.getDailyCoachReport).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for a future dayKey and never calls the service", async () => {
        const res = await call(`${ENDPOINT}?dayKey=2026-11-04`)

        expect(res.status).toBe(400)
        const body = await res.json()
        expect(body.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.getDailyCoachReport).not.toHaveBeenCalled()
    })

    it("rejects duplicate dayKey parameters explicitly and never calls the service", async () => {
        const duplicateUrls = [
            `${ENDPOINT}?dayKey=${DAY_KEY}&dayKey=2026-11-01`,
            `${ENDPOINT}?dayKey=${DAY_KEY}&dayKey=${DAY_KEY}`,
        ]

        for (const url of duplicateUrls) {
            const res = await call(url)

            expect(res.status).toBe(400)
            const body = await res.json()
            expect(body.ok).toBe(false)
            expect(body.error.code).toBe("VALIDATION_ERROR")
            expect(res.headers.get("Cache-Control")).toBe("no-store")
        }

        expect(mocks.getDailyCoachReport).not.toHaveBeenCalled()
    })
})

/* ============================ error mapping ============================ */

describe("GET /api/coach/daily - error mapping", () => {
    it("returns 500 USER_TIMEZONE_INVALID for an invalid stored timezone, without leaking it", async () => {
        for (const timezone of ["Mars/Olympus", "", null, 123]) {
            mocks.getCurrentUser.mockResolvedValueOnce({ ...USER, timezone })

            const res = await call(`${ENDPOINT}?dayKey=${DAY_KEY}`)

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
        expect(mocks.getDailyCoachReport).not.toHaveBeenCalled()
    })

    it("maps a Prisma-style failure to the generic 500 INTERNAL without leaking details", async () => {
        const error = new Error("P1001: can't reach database server prisma://secret")
        mocks.getDailyCoachReport.mockRejectedValue(error)

        const res = await call(`${ENDPOINT}?dayKey=${DAY_KEY}`)

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
                endpoint: "/api/coach/daily",
                feature: "coach",
                userId: 42,
            }),
        )
    })

    it("maps an engine invariant RangeError to 500 INTERNAL without leaking it", async () => {
        mocks.getDailyCoachReport.mockRejectedValue(new RangeError("INVALID:committedMinutes"))

        const res = await call(`${ENDPOINT}?dayKey=${DAY_KEY}`)

        expect(res.status).toBe(500)
        const text = JSON.stringify(await res.json())
        expect(text).not.toContain("INVALID:committedMinutes")
        expect(JSON.parse(text).error.code).toBe("INTERNAL")
        expect(res.headers.get("Cache-Control")).toBe("no-store")
    })

    it("maps a per-row corrupt-data RangeError to 500 INTERNAL without leaking it", async () => {
        mocks.getDailyCoachReport.mockRejectedValue(new RangeError("INVALID:spentMinutes"))

        const res = await call(`${ENDPOINT}?dayKey=${DAY_KEY}`)

        expect(res.status).toBe(500)
        const body = await res.json()
        expect(body).toEqual({
            ok: false,
            error: { code: "INTERNAL", message: "Server error" },
        })

        const text = JSON.stringify(body)
        expect(text).not.toContain("INVALID")
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

        const res = await call(`${ENDPOINT}?dayKey=${DAY_KEY}`)

        expect(res.status).toBe(500)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "INTERNAL", message: "Server error" },
        })
        expect(mocks.getDailyCoachReport).not.toHaveBeenCalled()
    })
})

/* ============================ method surface ============================ */

describe("GET /api/coach/daily - method surface", () => {
    it("exports only GET; other verbs are left to Next.js 405 handling", () => {
        expect(typeof routeModule.GET).toBe("function")
        expect(routeModule).not.toHaveProperty("POST")
        expect(routeModule).not.toHaveProperty("PUT")
        expect(routeModule).not.toHaveProperty("PATCH")
        expect(routeModule).not.toHaveProperty("DELETE")
    })
})
