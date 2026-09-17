import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* فاز ۴ — Step 6: shared authorization + delegation tests برای بقیه‌ی   */
/* endpointهای admin. requireAdmin mock می‌شود؛ delegation به foundation */
/* با spy verify می‌شود (الگوی route tests repo).                        */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    requireAdmin: vi.fn(),
}))

vi.mock("@/app/lib/requireAdmin", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/requireAdmin")>()),
    requireAdmin: mocks.requireAdmin,
}))

// foundation توابع فقط برای همین فایل mock می‌شوند — فایل‌های واقعی untouched
const foundation = vi.hoisted(() => ({
    getUserDetail: vi.fn(),
    getAdminActivity: vi.fn(),
    getUserAiUsage: vi.fn(),
    getAdminErrorLogs: vi.fn(),
    getAdminGlobalActivity: vi.fn(),
    getAdminActivityStats: vi.fn(),
    getAdminOverview: vi.fn(),
}))

vi.mock("@/app/lib/services/admin.query", () => foundation)

import { ServiceError } from "@/app/lib/services/errors"
import { AdminForbiddenError } from "@/app/lib/requireAdmin"

import { GET as usersIdGET } from "@/app/api/admin/users/[id]/route"
import { GET as activityGET } from "@/app/api/admin/activity/route"
import { GET as aiUsageGET } from "@/app/api/admin/users/[id]/ai-usage/route"
import { GET as errorsGET } from "@/app/api/admin/errors/route"
import { GET as overviewGET } from "@/app/api/admin/overview/route"

const ADMIN = { id: 1, role: "ADMIN", plan: "PRO", username: "root" }

beforeEach(() => {
    vi.clearAllMocks()
})

describe("admin routes — authorization matrix (shared across all endpoints)", () => {
    const cases: [string, (req?: NextRequest) => Promise<Response>][] = [
        ["GET /api/admin/users/[id]", (req) => usersIdGET(req ?? new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: "5" }) })],
        ["GET /api/admin/activity", (req) => activityGET(req ?? new NextRequest("http://localhost/x"))],
        ["GET /api/admin/users/[id]/ai-usage", (req) => aiUsageGET(req ?? new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: "5" }) })],
        ["GET /api/admin/errors", (req) => errorsGET(req ?? new NextRequest("http://localhost/x"))],
        ["GET /api/admin/overview", () => overviewGET()],
    ]

    for (const [name, handler] of cases) {
        it(`${name}: 401 when unauthenticated`, async () => {
            mocks.requireAdmin.mockRejectedValue(new ServiceError(401, "UNAUTHORIZED", "Unauthorized"))

            const res = await handler()

            expect(res.status).toBe(401)
            const parsed = await res.json()
            expect(parsed.error.code).toBe("UNAUTHORIZED")
        })

        it(`${name}: 403 ADMIN_FORBIDDEN for USER (also for PRO role=USER and fake JWT role claim — decision is DB-role only)`, async () => {
            mocks.requireAdmin.mockRejectedValue(new AdminForbiddenError())

            const res = await handler()

            expect(res.status).toBe(403)
            const parsed = await res.json()
            expect(parsed.error.code).toBe("ADMIN_FORBIDDEN")
        })
    }
})

describe("GET /api/admin/users/[id] — detail / IDOR / not-found", () => {
    it("400 for a non-integer id (server-side parsing — never trusted)", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)

        const res = await usersIdGET(
            new NextRequest("http://localhost/x"),
            { params: Promise.resolve({ id: "abc" }) },
        )

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(foundation.getUserDetail).not.toHaveBeenCalled()
    })

    it("delegates to getUserDetail with the parsed server-side id", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        foundation.getUserDetail.mockResolvedValue({
            user: { id: 5, username: "u5", emailMasked: "u5***@x.com", plan: "FREE", role: "USER", timezone: "Asia/Tehran", lastSeenAt: null },
            activitySummary: null,
            aiQuotaSummary: null,
            recentErrors: [],
        })

        const res = await usersIdGET(
            new NextRequest("http://localhost/x"),
            { params: Promise.resolve({ id: "5" }) },
        )

        expect(res.status).toBe(200)
        expect(foundation.getUserDetail).toHaveBeenCalledWith(5)
        const parsed = await res.json()
        expect(parsed.ok).toBe(true)
        expect(parsed.data.user.id).toBe(5)
        expect(JSON.stringify(parsed)).not.toContain("password")
        expect(JSON.stringify(parsed)).not.toContain("phone")
    })

    it("maps USER_NOT_FOUND to 404 (repository-standard not-found)", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        foundation.getUserDetail.mockRejectedValue(
            new ServiceError(404, "USER_NOT_FOUND", "کاربری یافت نشد"),
        )

        const res = await usersIdGET(
            new NextRequest("http://localhost/x"),
            { params: Promise.resolve({ id: "999" }) },
        )

        expect(res.status).toBe(404)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("USER_NOT_FOUND")
    })

    it("maps a DB failure to 500 INTERNAL without leaking Prisma details", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        foundation.getUserDetail.mockRejectedValue(new Error("P2025: db down"))
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

        const res = await usersIdGET(
            new NextRequest("http://localhost/x"),
            { params: Promise.resolve({ id: "5" }) },
        )

        expect(res.status).toBe(500)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("INTERNAL")
        expect(JSON.stringify(parsed)).not.toContain("P2025")
        errorSpy.mockRestore()
    })
})

describe("GET /api/admin/users/[id]/ai-usage — read-only delegation", () => {
    it("delegates with period/status filters and the §16 projection shape", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        foundation.getUserAiUsage.mockResolvedValue({
            plan: "FREE",
            period: { periodType: "MONTHLY", periodStart: "2026-09-01T00:00:00.000Z" },
            allowedUnits: 5,
            reservedUnits: 2,
            consumedUnits: 1,
            utilization: 0.2,
            events: [],
            page: 1,
            pageSize: 20,
            total: 0,
        })

        const res = await aiUsageGET(
            new NextRequest("http://localhost/x?status=CONSUMED&page=1&limit=25"),
            { params: Promise.resolve({ id: "5" }) },
        )

        expect(res.status).toBe(200)
        expect(foundation.getUserAiUsage).toHaveBeenCalledWith(
            5,
            expect.objectContaining({ period: "MONTHLY", status: "CONSUMED", page: 1, limit: 25 }),
        )
        const parsed = await res.json()
        expect(parsed.data.allowedUnits).toBe(5)
        expect(parsed.data.utilization).toBe(0.2)
        expect(parsed.data.hasMore).toBe(false)
    })

    it("normalizes an invalid status filter instead of failing", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        foundation.getUserAiUsage.mockResolvedValue({
            plan: "FREE",
            period: { periodType: "MONTHLY", periodStart: "2026-09-01T00:00:00.000Z" },
            allowedUnits: 5,
            reservedUnits: 0,
            consumedUnits: 0,
            utilization: 0,
            events: [],
            page: 1,
            pageSize: 20,
            total: 0,
        })

        await aiUsageGET(
            new NextRequest("http://localhost/x?status=HACKED"),
            { params: Promise.resolve({ id: "5" }) },
        )

        expect(foundation.getUserAiUsage).toHaveBeenCalledWith(
            5,
            expect.objectContaining({ status: undefined }),
        )
    })
})

describe("GET /api/admin/activity — ProductEvent delegation", () => {
    it("delegates to the global activity reader + stats (Phase 3 source)", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        foundation.getAdminGlobalActivity.mockResolvedValue({
            events: [{ id: "e1", userId: 5, requestId: null, eventName: "task.created", feature: null, properties: null, createdAt: "2026-09-16T00:00:00.000Z" }],
            page: 1,
            pageSize: 20,
            total: 1,
        })
        foundation.getAdminActivityStats.mockResolvedValue({
            totalInWindow: 1,
            byEventName: [{ eventName: "task.created", count: 1 }],
            byFeature: [],
            windowHours: 24,
        })

        const res = await activityGET(
            new NextRequest("http://localhost/x?event=task.created&page=1&limit=100"),
        )

        expect(res.status).toBe(200)
        expect(foundation.getAdminGlobalActivity).toHaveBeenCalledWith(
            expect.objectContaining({ eventName: "task.created", page: 1, pageSize: 100 }),
        )
        const parsed = await res.json()
        expect(parsed.data.items).toHaveLength(1)
        expect(parsed.data.stats.byEventName).toHaveLength(1)
    })

    it("passes date-range filters through (from/to → since/until)", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        foundation.getAdminGlobalActivity.mockResolvedValue({ events: [], page: 1, pageSize: 20, total: 0 })
        foundation.getAdminActivityStats.mockResolvedValue({ totalInWindow: 0, byEventName: [], byFeature: [], windowHours: 24 })

        await activityGET(
            new NextRequest("http://localhost/x?from=2026-09-01T00:00:00.000Z&to=2026-09-02T00:00:00.000Z"),
        )

        expect(foundation.getAdminGlobalActivity).toHaveBeenCalledWith(
            expect.objectContaining({
                since: new Date("2026-09-01T00:00:00.000Z"),
                until: new Date("2026-09-02T00:00:00.000Z"),
            }),
        )
    })
})

describe("GET /api/admin/errors — ErrorLog delegation (redaction preserved)", () => {
    it("delegates to getAdminErrorLogs with §10 filters and a stack-free payload", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        foundation.getAdminErrorLogs.mockResolvedValue({
            logs: [
                {
                    id: "err1",
                    requestId: "r1",
                    userId: 5,
                    endpoint: "/api/tasks",
                    feature: null,
                    errorCode: "VALIDATION_ERROR",
                    statusCode: 400,
                    category: "VALIDATION",
                    severity: "WARNING",
                    message: "bad request",
                    metadata: undefined,
                    environment: null,
                    createdAt: "2026-09-16T00:00:00.000Z",
                },
            ],
            page: 1,
            pageSize: 20,
            total: 1,
        })

        const res = await errorsGET(
            new NextRequest("http://localhost/x?code=VALIDATION_ERROR&severity=WARNING&userId=5&page=2&limit=50"),
        )

        expect(res.status).toBe(200)
        expect(foundation.getAdminErrorLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 5,
                errorCode: "VALIDATION_ERROR",
                severity: "WARNING",
                page: 2,
                pageSize: 50,
            }),
        )
        const body = JSON.stringify(await res.json())
        expect(body).not.toContain("stack")
    })
})

describe("GET /api/admin/overview — independent widgets delegation", () => {
    it("delegates to getAdminOverview and returns the four-widget shape", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        foundation.getAdminOverview.mockResolvedValue({
            users: { dau: 1, wau: 2, mau: 3 },
            activity: { totalInWindow: 4, byEventName: [], byFeature: [], windowHours: 24 },
            aiQuota: null,
            errors: { totalInWindow: 0, bySeverity: [], topErrors: [] },
        })

        const res = await overviewGET()

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed.data.users.dau).toBe(1)
        expect(parsed.data.activity.totalInWindow).toBe(4)
        expect(parsed.data.aiQuota).toBeNull()
        expect(parsed.data.errors).toBeDefined()
    })
})
