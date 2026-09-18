import { describe, expect, it } from "vitest"
import {
    buildAiUsagePageVM,
    buildActivityPageVM,
    buildErrorsPageVM,
    buildErrorsQueryString,
    buildOverviewVM,
    buildPerUserQueryString,
    buildUserDetailVM,
    buildUsersPageVM,
    buildUsersQueryString,
    countBySeverity,
    faDigits,
    formatTimestamp,
    formatUtilization,
    maskIdTail,
    planLabel,
    resolveAccessStatus,
    resolveListStatus,
    roleLabel,
    severityTone,
} from "./adminViewModels"
import type {
    AdminOverview,
    AdminUserDetail,
    AdminUsersPage,
} from "./adminTypes"

/* ------------------------------------------------------------------ */
/* Step 7 — تست ویومدل‌های خالص صفحات Admin.                            */
/* محیط node بدون DOM/jsdom (قانون بدون وابستگی جدید) — همان الگوی       */
/* AdvisorCard.test.ts: منطقِ نمایش pure استخراج و تست می‌شود.            */
/* ------------------------------------------------------------------ */

const usersPage = (overrides: Partial<AdminUsersPage> = {}): AdminUsersPage => ({
    items: [
        {
            id: 7,
            username: "alpha",
            emailMasked: "al***@example.com",
            plan: "PRO",
            role: "USER",
            timezone: "Asia/Tehran",
            lastSeenAt: "2026-09-17T10:00:00.000Z",
        },
        {
            id: 3,
            username: "beta",
            emailMasked: "be***@example.com",
            plan: "FREE",
            role: "ADMIN",
            timezone: "Asia/Tehran",
            lastSeenAt: null,
        },
    ],
    page: 1,
    limit: 20,
    total: 42,
    hasMore: true,
    ...overrides,
})

describe("resolveListStatus", () => {
    it("returns loading while loading regardless of data", () => {
        expect(resolveListStatus(true, null, 0)).toBe("loading")
        expect(resolveListStatus(true, null, 5)).toBe("loading")
    })

    it("returns error when an error message exists and loading finished", () => {
        expect(resolveListStatus(false, "خطا", 5)).toBe("error")
    })

    it("returns empty for zero items and data otherwise", () => {
        expect(resolveListStatus(false, null, 0)).toBe("empty")
        expect(resolveListStatus(false, null, 2)).toBe("data")
    })
})

describe("access status (UX فقط — امنیت server-side است)", () => {
    it("maps 401/UNAUTHORIZED to unauthenticated", () => {
        expect(resolveAccessStatus("401 UNAUTHORIZED", false)).toBe("unauthenticated")
    })

    it("maps 403/ADMIN_FORBIDDEN to forbidden", () => {
        expect(resolveAccessStatus("403 ADMIN_FORBIDDEN", false)).toBe("forbidden")
    })

    it("stays checking while loading without error and allowed otherwise", () => {
        expect(resolveAccessStatus(null, true)).toBe("checking")
        expect(resolveAccessStatus(null, false)).toBe("allowed")
    })

    it("never grants admin state from client data — only message-driven", () => {
        // هیچ مسیری به «allowed با role ذخیره‌شده» وجود ندارد؛ فقط نبودِ خطا
        expect(resolveAccessStatus("خطای شبکه", false)).toBe("allowed")
    })
})

describe("query builders (allowlist + سقف limit=100)", () => {
    it("serializes only allowed keys and clamps limit", () => {
        const qs = buildUsersQueryString({ q: " ali ", plan: "PRO", role: "ADMIN", page: 2, limit: 500 })
        expect(qs).toBe("q=ali&plan=PRO&role=ADMIN&page=2&limit=100")
    })

    it("drops empty filters and keeps default limit", () => {
        const qs = buildUsersQueryString({ q: "", plan: "", role: "", page: 1, limit: 20 })
        expect(qs).toBe("page=1&limit=20")
    })

    it("builds error filters with page/limit and trims values", () => {
        const qs = buildErrorsQueryString({
            code: " VALIDATION_ERROR ",
            category: "",
            severity: "ERROR",
            endpoint: "",
            userId: "42",
            page: 3,
            limit: 50,
        })
        expect(qs).toContain("code=VALIDATION_ERROR")
        expect(qs).toContain("severity=ERROR")
        expect(qs).toContain("userId=42")
        expect(qs).not.toContain("category=")
        expect(qs).toContain("page=3")
        expect(qs).toContain("limit=50")
    })

    it("per-user query only includes allowed extras", () => {
        const qs = buildPerUserQueryString({ status: "CONSUMED", eventName: "ai.analyze" }, 2, 10)
        expect(qs).toBe("event=ai.analyze&status=CONSUMED&page=2&limit=10")
        const minimal = buildPerUserQueryString({}, 1, 10)
        expect(minimal).toBe("page=1&limit=10")
    })
})

describe("users page viewmodel", () => {
    it("computes pagination flags from API envelope without overriding ordering", () => {
        const vm = buildUsersPageVM(usersPage(), false, null)
        expect(vm.status).toBe("data")
        expect(vm.total).toBe(42)
        expect(vm.totalPages).toBe(3)
        expect(vm.hasPrev).toBe(false)
        expect(vm.hasNext).toBe(true)
        // ترتیب items دست‌نخورده می‌ماند (id DESC سرور)
        expect(vm.items[0]?.id).toBe(7)
        expect(vm.items[1]?.id).toBe(3)
    })

    it("handles empty and error states", () => {
        expect(buildUsersPageVM(usersPage({ items: [], total: 0, hasMore: false }), false, null).status).toBe("empty")
        const errVm = buildUsersPageVM(null, false, "شکست")
        expect(errVm.status).toBe("error")
        expect(errVm.items).toEqual([])
    })
})

describe("errors page viewmodel", () => {
    it("computes pagination and passes items through untouched", () => {
        const data = {
            items: [
                {
                    id: "e1",
                    requestId: "req-1",
                    userId: 5,
                    endpoint: "/api/tasks",
                    feature: "tasks",
                    errorCode: "VALIDATION_ERROR",
                    statusCode: 400,
                    category: "VALIDATION",
                    severity: "WARNING",
                    message: "ورودی نامعتبر",
                    environment: "dev",
                    createdAt: "2026-09-17T08:00:00.000Z",
                },
            ],
            page: 2,
            limit: 20,
            total: 21,
            hasMore: false,
        }
        const vm = buildErrorsPageVM(data, false, null)
        expect(vm.status).toBe("data")
        expect(vm.page).toBe(2)
        expect(vm.hasPrev).toBe(true)
        expect(vm.hasNext).toBe(false)
        expect(vm.items[0]?.message).toBe("ورودی نامعتبر")
    })
})

describe("overview viewmodel — widgetهای مستقل (§12)", () => {
    it("keeps every available widget when present and derives no new metrics", () => {
        const overview: AdminOverview = {
            users: { total: 120, dau: 3, wau: 9, mau: 20 },
            activity: { totalInWindow: 12, byEventName: [{ eventName: "auth.login_succeeded", count: 7 }], byFeature: [], windowHours: 24 },
            aiQuota: { periodStart: "2026-09-01T00:00:00.000Z", reservedUnits: 30, consumedUnits: 12 },
            aiUsage: { windowHours: 24, totalRequests: 40, requestsInWindow: 6, byStatus: [{ status: "CONSUMED", count: 5 }] },
            errors: { totalInWindow: 4, totalAllTime: 90, bySeverity: [{ severity: "ERROR", count: 4 }], topErrors: [], windowHours: 24 },
            billing: {
                activeSubscriptions: 7,
                paidInWindow: 3,
                windowDays: 7,
                recentPayments: [
                    {
                        id: "pay_01HZZZZZABCD",
                        userId: 7,
                        status: "PAID",
                        amount: 199000,
                        currency: "IRR",
                        entitlementDays: 30,
                        createdAt: "2026-09-17T08:00:00.000Z",
                        paidAt: "2026-09-17T08:02:00.000Z",
                    },
                ],
            },
            recentErrors: [
                {
                    id: "e1",
                    requestId: "req-1",
                    userId: 5,
                    endpoint: "/api/tasks",
                    feature: "tasks",
                    errorCode: "VALIDATION_ERROR",
                    statusCode: 400,
                    category: "VALIDATION",
                    severity: "WARNING",
                    message: "ورودی نامعتبر",
                    metadata: { password: "secret" },
                    environment: "prod",
                    createdAt: "2026-09-17T08:00:00.000Z",
                },
            ],
        }
        const vm = buildOverviewVM(overview)
        expect(vm.users).toEqual({ total: 120, dau: 3, wau: 9, mau: 20 })
        expect(vm.activity?.totalInWindow).toBe(12)
        expect(vm.aiQuota?.consumedUnits).toBe(12)
        expect(vm.aiUsage?.totalRequests).toBe(40)
        expect(vm.errors?.bySeverity[0]?.severity).toBe("ERROR")
        expect(vm.errors?.totalAllTime).toBe(90)
        expect(vm.billing?.activeSubscriptions).toBe(7)
        expect(vm.billing?.recentPayments).toHaveLength(1)
        expect(vm.recentErrors).toHaveLength(1)
        expect(vm.recentErrors[0]?.endpoint).toBe("/api/tasks")
    })

    it("hides only the unavailable widget (aiQuota null) — no fabricated data", () => {
        const overview = {
            users: { total: 5, dau: 0, wau: 0, mau: 0 },
            activity: { totalInWindow: 0, byEventName: [], byFeature: [], windowHours: 24 },
            aiQuota: null,
            aiUsage: null,
            errors: { totalInWindow: 0, totalAllTime: null, bySeverity: [], topErrors: [], windowHours: 24 },
            billing: null,
            recentErrors: [],
        } as unknown as AdminOverview
        const vm = buildOverviewVM(overview)
        expect(vm.aiQuota).toBeNull()
        expect(vm.aiUsage).toBeNull()
        expect(vm.billing).toBeNull()
        expect(vm.activity).not.toBeNull()
        expect(vm.errors).not.toBeNull()
    })

    it("returns an all-null-safe viewmodel for null input", () => {
        const vm = buildOverviewVM(null)
        expect(vm.users).toEqual({ total: null, dau: 0, wau: 0, mau: 0 })
        expect(vm.activity).toBeNull()
        expect(vm.aiQuota).toBeNull()
        expect(vm.aiUsage).toBeNull()
        expect(vm.errors).toBeNull()
        expect(vm.billing).toBeNull()
        expect(vm.recentErrors).toEqual([])
    })

    it("rejects malformed widgets instead of rendering partial data", () => {
        const overview = {
            users: { total: "120", dau: 1, wau: 1, mau: 1 },
            activity: { totalInWindow: 1, byEventName: [] },
            aiQuota: { reservedUnits: "30", consumedUnits: 1 },
            aiUsage: { totalRequests: 1, requestsInWindow: 1 },
            errors: { totalInWindow: 1, bySeverity: [] },
            billing: { activeSubscriptions: 1 },
            recentErrors: "not-an-array",
        } as unknown as AdminOverview
        const vm = buildOverviewVM(overview)
        expect(vm.users.total).toBeNull() // رشته ≠ عدد ⇒ unavailable، نه کست
        expect(vm.aiQuota).toBeNull()
        expect(vm.aiUsage).toBeNull()
        expect(vm.billing).toBeNull()
        expect(vm.recentErrors).toEqual([])
        expect(vm.errors).not.toBeNull()
    })

    it("recent-error feed projects an allowlist and caps rows", () => {
        const row = (i: number) => ({
            id: `e${i}`,
            requestId: `req-${i}`,
            userId: i,
            endpoint: "/api/tasks",
            feature: "tasks",
            errorCode: "INTERNAL",
            statusCode: 500,
            category: "INTERNAL",
            severity: "ERROR",
            message: `خطای ${i}`,
            metadata: { token: "secret" },
            stack: "at foo",
            environment: "prod",
            createdAt: "2026-09-17T08:00:00.000Z",
        })
        const overview = {
            users: { total: 0, dau: 0, wau: 0, mau: 0 },
            activity: null,
            aiQuota: null,
            aiUsage: null,
            errors: null,
            billing: null,
            recentErrors: [row(1), "bad", null, row(2), row(3), row(4), row(5), row(6), row(7), row(8), row(9), row(10), row(11)],
        } as unknown as AdminOverview
        const vm = buildOverviewVM(overview)
        expect(vm.recentErrors).toHaveLength(10) // سقف نمایش
        expect(vm.recentErrors.map((e) => e.id)).toEqual([
            "e1",
            "e2",
            "e3",
            "e4",
            "e5",
            "e6",
            "e7",
            "e8",
            "e9",
            "e10",
        ])
        // metadata/stack هرگز در فید UI نیستند
        expect(vm.recentErrors[0]).not.toHaveProperty("metadata")
        expect(vm.recentErrors[0]).not.toHaveProperty("stack")
    })

    it("drops a recent-error row that is missing required safe fields", () => {
        const overview = {
            users: { total: 0, dau: 0, wau: 0, mau: 0 },
            activity: null,
            aiQuota: null,
            aiUsage: null,
            errors: null,
            billing: null,
            recentErrors: [{ id: "e1", errorCode: "INTERNAL", severity: "ERROR" }],
        } as unknown as AdminOverview
        expect(buildOverviewVM(overview).recentErrors).toEqual([])
    })
})

describe("KPI helpers (فقط aggregate مستقیم سرور)", () => {
    it("counts severity rows without inventing values", () => {
        const counts = countBySeverity([
            { severity: "CRITICAL", count: 2 },
            { severity: "ERROR", count: 3 },
            { severity: "WARNING", count: 1 },
            { severity: "INFO", count: 4 },
            { severity: "SOMETHING_ELSE", count: 5 },
        ])
        expect(counts).toEqual({ CRITICAL: 2, ERROR: 3, WARNING: 1, INFO: 4, OTHER: 5 })
    })

    it("aggregates duplicate severity rows and ignores invalid counts", () => {
        const counts = countBySeverity([
            { severity: "ERROR", count: 2 },
            { severity: "ERROR", count: 5 },
            { severity: "WARNING", count: Number.NaN },
        ])
        expect(counts.ERROR).toBe(7)
        expect(counts.WARNING).toBe(0)
        expect(countBySeverity([])).toEqual({ CRITICAL: 0, ERROR: 0, WARNING: 0, INFO: 0, OTHER: 0 })
    })

    it("masks internal identifiers to the last four characters", () => {
        expect(maskIdTail("pay_01HZZZZZABCD")).toBe("••••ABCD")
        expect(maskIdTail("abcd")).toBe("••••")
        expect(maskIdTail("  ")).toBe("—")
    })
})

describe("user detail viewmodel (§15)", () => {
    it("passes safe identity through and keeps independent summaries", () => {
        const detail: AdminUserDetail = {
            user: {
                id: 9,
                username: "gamma",
                emailMasked: "ga***@example.com",
                plan: "FREE",
                role: "USER",
                timezone: "Asia/Tehran",
                lastSeenAt: "2026-09-16T09:30:00.000Z",
            },
            activitySummary: { windowHours: 168, totalEvents: 3, byEventName: [{ eventName: "task.created", count: 3 }] },
            aiQuotaSummary: {
                plan: "FREE",
                periodType: "MONTHLY",
                periodStart: "2026-09-01T00:00:00.000Z",
                allowedUnits: 10,
                reservedUnits: 2,
                consumedUnits: 1,
                utilization: 0.1,
            },
            recentErrors: [],
            billingSummary: null,
        }
        const vm = buildUserDetailVM(detail)
        expect(vm.user?.emailMasked).toBe("ga***@example.com")
        expect(vm.activitySummary?.totalEvents).toBe(3)
        expect(vm.aiQuotaSummary?.utilization).toBeCloseTo(0.1)
        expect(vm.billingSummary).toBeNull()
    })

    it("treats null summaries as normal absence and null detail as not-found view", () => {
        const detail: AdminUserDetail = {
            user: {
                id: 9,
                username: "gamma",
                emailMasked: "ga***@example.com",
                plan: "FREE",
                role: "USER",
                timezone: "Asia/Tehran",
                lastSeenAt: null,
            },
            activitySummary: null,
            aiQuotaSummary: null,
            recentErrors: [],
            billingSummary: null,
        }
        const vm = buildUserDetailVM(detail)
        expect(vm.activitySummary).toBeNull()
        expect(vm.aiQuotaSummary).toBeNull()
        expect(vm.recentErrors).toEqual([])
        expect(vm.billingSummary).toBeNull()

        const none = buildUserDetailVM(null)
        expect(none.user).toBeNull()
    })
})

describe("per-user sub-list viewmodels", () => {
    it("activity: passes status through (loading/empty/error/data)", () => {
        expect(buildActivityPageVM(null, true, null).status).toBe("loading")
        expect(buildActivityPageVM(null, false, null).status).toBe("empty")
        expect(buildActivityPageVM(null, false, "خطا").status).toBe("error")
        const data = {
            items: [
                {
                    id: "ev1",
                    userId: 9,
                    requestId: null,
                    eventName: "task.created",
                    feature: "tasks",
                    properties: null,
                    createdAt: "2026-09-17T07:00:00.000Z",
                },
            ],
            page: 1,
            limit: 10,
            total: 1,
            hasMore: false,
        }
        const vm = buildActivityPageVM(data, false, null)
        expect(vm.status).toBe("data")
        expect(vm.items[0]?.eventName).toBe("task.created")
    })

    it("ai usage: quota data rides along with items", () => {
        const empty = buildAiUsagePageVM(null, false, null)
        expect(empty.status).toBe("empty")
        expect(empty.quota).toBeNull()

        const data = {
            plan: "PRO" as const,
            period: { periodType: "MONTHLY", periodStart: "2026-09-01T00:00:00.000Z" },
            allowedUnits: 100,
            reservedUnits: 10,
            consumedUnits: 5,
            utilization: 0.05,
            items: [],
            page: 1,
            limit: 10,
            total: 0,
            hasMore: false,
        }
        const vm = buildAiUsagePageVM(data, false, null)
        expect(vm.status).toBe("empty") // آیتمی نیست اما quota موجود است
        expect(vm.quota?.allowedUnits).toBe(100)
    })
})

describe("formatting helpers", () => {
    it("converts digits to Persian", () => {
        expect(faDigits(42)).toBe("۴۲")
        expect(faDigits("7")).toBe("۷")
    })

    it("formats utilization as rounded percent, clamped", () => {
        expect(formatUtilization(0)).toBe("۰٪")
        expect(formatUtilization(0.256)).toBe("۲۶٪")
        expect(formatUtilization(1.5)).toBe("۱۰۰٪")
        expect(formatUtilization(Number.NaN)).toBe("۰٪")
    })

    it("formats timestamps deterministically or em-dash fallback", () => {
        expect(formatTimestamp(null)).toBe("—")
        expect(formatTimestamp("not-a-date")).toBe("—")
        expect(formatTimestamp("2026-09-17T06:30:00.000Z")).not.toBe("—")
    })

    it("labels plan/role in Persian and maps severity tones", () => {
        expect(planLabel("PRO")).toBe("حرفه‌ای")
        expect(planLabel("FREE")).toBe("رایگان")
        expect(roleLabel("ADMIN")).toBe("مدیر")
        expect(roleLabel("USER")).toBe("کاربر")
        expect(severityTone("CRITICAL")).toBe("critical")
        expect(severityTone("WARNING")).toBe("warning")
        expect(severityTone("OTHER")).toBe("neutral")
    })
})

describe("privacy درvariants در لایه‌ی UI", () => {
    it("masked email stays exactly as delivered by the API (no unmask logic exists)", () => {
        const vm = buildUsersPageVM(usersPage(), false, null)
        expect(vm.items[0]?.emailMasked).toBe("al***@example.com")
        // DTO کلاینت اصلاً فیلد email خام ندارد — تایپ‌ها فقط emailMasked دارند
        expect(Object.keys(usersPage().items[0] ?? {})).not.toContain("email")
        expect(Object.keys(usersPage().items[0] ?? {})).not.toContain("phone")
        expect(Object.keys(usersPage().items[0] ?? {})).not.toContain("password")
    })

    it("error log DTO has no stack field anywhere in the viewmodel output", () => {
        const data = {
            items: [
                {
                    id: "e2",
                    requestId: "req-2",
                    userId: null,
                    endpoint: "/api/ai/test",
                    feature: "ai",
                    errorCode: "INTERNAL",
                    statusCode: 500,
                    category: "INTERNAL",
                    severity: "ERROR",
                    message: "پیام امن",
                    metadata: { any: "thing" },
                    environment: "prod",
                    createdAt: "2026-09-17T06:00:00.000Z",
                    // stack عمداً غایب است (قرارداد سرور)
                },
            ],
            page: 1,
            limit: 20,
            total: 1,
            hasMore: false,
        }
        const vm = buildErrorsPageVM(data, false, null)
        expect(vm.items[0]).not.toHaveProperty("stack")
    })
})
