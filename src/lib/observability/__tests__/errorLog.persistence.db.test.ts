// فاز ۲ — F10: تست integration واقعی ErrorLog با PostgreSQL واقعی
// (سند فاز ۲ §7 مدل، §8 فیلدها، §10 normalization، §14 persistence، §15 fail-open،
//  §16 console fallback، §17 route integration، §27 test plan)
//
// قواعد (عیناً مثل الگوی موجود `app/lib/services/*.concurrency.db.test.ts`):
// - PostgreSQL واقعی + Prisma واقعی — نه mock، نه fake، نه in-memory.
// - هیچ رکورد موجودی لمس نمی‌شود؛ داده‌ی تستی با marker اختصاصی و cleanup در finally/afterAll.
// - اگر DB در دسترس نباشد، تست با پیام صریح REAL_POSTGRESQL_UNAVAILABLE fail می‌شود؛
//   skip جعلی / سبزِ جعلی / mock-به‌جای-DB ممنوع است.
//
// تنها mockها مرزهای *غیر-observability* هستند (auth/rate-limit/AI provider) تا route واقعی اجرا شود؛
// نوشتن ErrorLog، normalization، redaction، policy و insert همگی واقعی‌اند.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "@prisma/client"
import type { NextRequest } from "next/server"

import { persistError, setRealPersistenceEnabled } from "../persistError"
import { recordError } from "../recordError"
import { resolveEnvironment } from "../environment"
import { QuotaUnavailableError } from "@/app/lib/services/errors"
import type { NormalizedErrorRecord } from "../normalizeError"
import type { ObservabilityContext } from "../types"

/** وضعیت مشترک mockها (vi.hoisted لازم است چون فکتوری vi.mock پیش از importها اجرا می‌شود). */
const hold = vi.hoisted(() => ({
    currentUser: null as { id: number; plan: string; timezone: string } | null,
}))

vi.mock("@/app/lib/getCurrentUser", () => ({
    getCurrentUser: async () => hold.currentUser,
}))
vi.mock("@/app/lib/rateLimit", () => ({ isRateLimited: () => false }))
vi.mock("@/app/lib/services/userActivity.service", () => ({
    touchAuthenticatedActivity: async () => {},
}))
vi.mock("@/app/lib/services/analysis.service", () => ({ runAiSamples: async () => [] }))
vi.mock("@/app/lib/services/tasks.service", async () => {
    const { AiProviderUnavailableError } = await import("@/app/lib/services/errors")
    return {
        reanalyzeTask: async () => {
            throw new AiProviderUnavailableError()
        },
    }
})

const MARKER_EMAIL = "phase2-observability-db-test@observability.internal"
const MARKER_USERNAME = "phase2-observability-db-test"
/** کاربر ناموجود → خطای واقعی DB (FK) در reserveQuota → QUOTA_UNAVAILABLE واقعی در route */
const NONEXISTENT_USER_ID = 2147483000

const DB_REQUIRED =
    "REAL_POSTGRESQL_UNAVAILABLE: تست ErrorLog persistence به PostgreSQL واقعی نیاز دارد؛ skip جعلی ممنوع است (Phase 2 §27)."

/** چند round-trip واقعی DB در هر تست + insert تا ۴KB متن. */
const DB_TEST_TIMEOUT_MS = 30_000

let prisma: PrismaClient
let dbAvailable = false
let testUserId = 0
const createdRequestIds: string[] = []

function requireDb(): void {
    if (!dbAvailable) throw new Error(DB_REQUIRED)
}

/** create واقعی Prisma — همان مسیر production، اما با client تزریق‌شده (الگوی DI موجود persistError). */
const realCreate =
    (client: PrismaClient) =>
    async (args: { data: any }) =>
        client.errorLog.create({ data: args.data })

const contextOf = (
    requestId: string,
    overrides: Partial<ObservabilityContext> = {},
): ObservabilityContext => ({
    requestId,
    endpoint: "/api/p2-db-test",
    feature: "observability",
    userId: testUserId,
    ...overrides,
})

const recordOf = (overrides: Partial<NormalizedErrorRecord> = {}): NormalizedErrorRecord => ({
    errorCode: "INTERNAL",
    statusCode: 500,
    category: "INTERNAL",
    severity: "ERROR",
    safeMessage: "boom",
    stack: "Error: boom\n    at f ()",
    ...overrides,
})

async function rowByRequestId(requestId: string) {
    return prisma.errorLog.findMany({ where: { requestId } })
}

beforeAll(async () => {
    prisma = new PrismaClient()
    try {
        await prisma.$queryRaw`SELECT 1`
        dbAvailable = true
    } catch {
        dbAvailable = false
    }

    if (!dbAvailable) return

    // F10 هر دو مسیر را می‌خواهد: (۱) insert واقعی با create تزریق‌شده، (۲) مسیر default در routeها.
    setRealPersistenceEnabled(true)

    // پاک‌سازی باقی‌مانده‌ی اجراهای قبلی همین suite (هیچ داده‌ی دیگری لمس نمی‌شود)
    await prisma.errorLog.deleteMany({
        where: {
            OR: [{ endpoint: { startsWith: "/api/p2-db" } }, { requestId: { startsWith: "p2-db-" } }],
        },
    })
    await prisma.user.deleteMany({
        where: { OR: [{ email: MARKER_EMAIL }, { username: MARKER_USERNAME }] },
    })

    const user = await prisma.user.create({
        data: {
            email: MARKER_EMAIL,
            username: MARKER_USERNAME,
            password: "not-a-real-login", // ورود از این مسیر نیست؛ هش واقعی لازم نیست
            timezone: "Asia/Tehran",
            plan: "FREE",
        },
    })
    testUserId = user.id
})

afterAll(async () => {
    if (dbAvailable) {
        await prisma.errorLog.deleteMany({
            where: {
                OR: [
                    { requestId: { in: createdRequestIds } },
                    { userId: testUserId },
                    { userId: NONEXISTENT_USER_ID },
                    { endpoint: { startsWith: "/api/p2-db" } },
                ],
            },
        })
        // cascade ردیف‌های quota/event کاربر تستی را هم پاک می‌کند
        await prisma.user.deleteMany({
            where: { OR: [{ email: MARKER_EMAIL }, { username: MARKER_USERNAME }] },
        })
    }
    setRealPersistenceEnabled(false)
    hold.currentUser = null
    await prisma?.$disconnect()
})

describe("ErrorLog persistence — real PostgreSQL (§7/§14)", () => {
    it("inserts a real ErrorLog row through persistError (happy path)", async () => {
        requireDb()
        const requestId = "p2-db-insert-happy"
        createdRequestIds.push(requestId)

        await persistError(
            recordOf({ errorCode: "QUOTA_UNAVAILABLE", statusCode: 503, category: "DATABASE" }),
            contextOf(requestId),
            { create: realCreate(prisma) },
        )

        const rows = await rowByRequestId(requestId)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            requestId,
            userId: testUserId,
            endpoint: "/api/p2-db-test",
            feature: "observability",
            errorCode: "QUOTA_UNAVAILABLE",
            statusCode: 503,
            category: "DATABASE",
            severity: "ERROR",
            message: "boom",
        })
        expect(rows[0]!.createdAt).toBeInstanceOf(Date)
    })

    it("round-trips JSON metadata through the real JSONB column", async () => {
        requireDb()
        const requestId = "p2-db-metadata-json"
        createdRequestIds.push(requestId)

        const metadata = {
            prismaCode: "P2002",
            nested: { attempt: 2, list: [1, 2, 3] },
            unicode: "سلام دنیا",
            flag: true,
        }

        await persistError(recordOf({ metadata }), contextOf(requestId), {
            create: realCreate(prisma),
        })

        const rows = await rowByRequestId(requestId)
        expect(rows[0]!.metadata).toEqual(metadata)
    })

    it("truncates message (2KB) and stack (4KB) at the DB boundary", async () => {
        requireDb()
        const requestId = "p2-db-truncation"
        createdRequestIds.push(requestId)

        await persistError(
            recordOf({ safeMessage: "a".repeat(3000), stack: "s".repeat(5000) }),
            contextOf(requestId),
            { create: realCreate(prisma) },
        )

        const row = (await rowByRequestId(requestId))[0]!
        expect(row.message.length).toBe(2048)
        expect(row.stack!.length).toBe(4096)
    })

    it("reads environment from configuration, not from a hard-coded value (§8 / F4)", async () => {
        requireDb()
        const requestId = "p2-db-environment"
        createdRequestIds.push(requestId)

        // مقدار config توسط deployment ست می‌شود؛ هیچ لیترال hard-code ای در ماژول وجود ندارد
        vi.stubEnv("APP_ENV", "observability-db-test")
        try {
            expect(resolveEnvironment()).toBe("observability-db-test")

            await persistError(recordOf(), contextOf(requestId), { create: realCreate(prisma) })

            const row = (await rowByRequestId(requestId))[0]!
            expect(row.environment).toBe("observability-db-test")
        } finally {
            vi.unstubAllEnvs()
        }

        // بدون config محیطی → همان مقدار واقعی محیط اجرا (نه لیترال ثابت)
        expect(resolveEnvironment()).toBe(process.env.NODE_ENV ?? null)
    })

    it("answers queries through every indexed dimension (createdAt/errorCode/category/severity/endpoint/userId)", async () => {
        requireDb()
        const requestId = "p2-db-indexed-query"
        createdRequestIds.push(requestId)

        await persistError(
            recordOf({
                errorCode: "AI_PROVIDER_UNAVAILABLE",
                statusCode: 503,
                category: "EXTERNAL_SERVICE",
            }),
            contextOf(requestId, { endpoint: "/api/p2-db-index" }),
            { create: realCreate(prisma) },
        )

        const found = await prisma.errorLog.findMany({
            where: {
                errorCode: "AI_PROVIDER_UNAVAILABLE",
                category: "EXTERNAL_SERVICE",
                severity: "ERROR",
                endpoint: "/api/p2-db-index",
                userId: testUserId,
                createdAt: {
                    gte: new Date(Date.now() - 5 * 60_000),
                    lte: new Date(Date.now() + 5 * 60_000),
                },
            },
        })
        expect(found.map((r) => r.requestId)).toContain(requestId)

        // عدم تطابق هر بعد → ردیف برنمی‌گردد (proving the filters are real, not vacuous)
        expect(
            await prisma.errorLog.count({ where: { requestId, category: "VALIDATION" } }),
        ).toBe(0)
        expect(await prisma.errorLog.count({ where: { requestId, severity: "INFO" } })).toBe(0)
        expect(
            await prisma.errorLog.count({ where: { requestId, endpoint: "/api/other" } }),
        ).toBe(0)
        expect(await prisma.errorLog.count({ where: { requestId, userId: 0 } })).toBe(0)
        expect(
            await prisma.errorLog.count({
                where: { requestId, createdAt: { gt: new Date(Date.now() + 5 * 60_000) } },
            }),
        ).toBe(0)
    })
})

describe("ErrorLog persistence — route integration (§17)", () => {
    it("QUOTA_UNAVAILABLE: a real quota DB failure in GET /api/ai/test writes exactly one correlated row", async () => {
        requireDb()

        // کاربر موجود نیست → reserveQuota با خطای واقعی DB (FK) fail-closed می‌شود (§19 فاز ۱)
        hold.currentUser = {
            id: NONEXISTENT_USER_ID,
            plan: "FREE",
            timezone: "Asia/Tehran",
        }

        const { GET } = await import("@/app/api/ai/test/route")
        const res = await GET()

        expect(res.status).toBe(503)
        const requestId = res.headers.get("X-Request-ID")
        expect(requestId).toBeTruthy()
        createdRequestIds.push(requestId!)

        const rows = await rowByRequestId(requestId!)
        // دقیقاً یک رکورد (بدون duplicate توسط outer catch)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            requestId,
            endpoint: "/api/ai/test",
            errorCode: "QUOTA_UNAVAILABLE",
            statusCode: 503,
            category: "DATABASE",
            severity: "ERROR",
            userId: NONEXISTENT_USER_ID,
        })
    })

    it("AI_PROVIDER_UNAVAILABLE: provider failure in PATCH /api/tasks/[id]/analyze writes exactly one correlated row", async () => {
        requireDb()
        hold.currentUser = { id: testUserId, plan: "FREE", timezone: "Asia/Tehran" }

        const { PATCH } = await import("@/app/api/tasks/[id]/analyze/route")
        const req = new Request("http://localhost/api/tasks/1/analyze", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
        }) as unknown as NextRequest

        const res = await PATCH(req, { params: Promise.resolve({ id: "1" }) })

        expect(res.status).toBe(503)
        const requestId = res.headers.get("X-Request-ID")
        expect(requestId).toBeTruthy()
        createdRequestIds.push(requestId!)

        const rows = await rowByRequestId(requestId!)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
            requestId,
            endpoint: "/api/tasks/[id]/analyze",
            errorCode: "AI_PROVIDER_UNAVAILABLE",
            statusCode: 503,
            category: "EXTERNAL_SERVICE",
            severity: "ERROR",
            userId: testUserId,
        })
    })
})

describe("ErrorLog persistence — fail-open (§15)", () => {
    it("keeps working when the ErrorLog table is unavailable (real PostgreSQL error, no throw)", async () => {
        requireDb()

        const url = new URL(process.env.DATABASE_URL!)
        url.searchParams.set("schema", "observability_missing_schema")
        const scoped = new PrismaClient({ datasources: { db: { url: url.toString() } } })
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        try {
            await expect(
                persistError(recordOf(), contextOf("p2-db-table-missing"), { create: realCreate(scoped) }, { skipTimeoutGuard: true }),
            ).resolves.toBeUndefined()

            // fallback ساختاریافته با فیلد الزامی level (§16)
            expect(spy).toHaveBeenCalledTimes(1)
            const parsed = JSON.parse(spy.mock.calls[0]![0] as string) as Record<string, unknown>
            expect(parsed).toMatchObject({
                level: "error",
                channel: "persistError.fallback",
                reason: "db_insert_failed",
                requestId: "p2-db-table-missing",
            })
        } finally {
            spy.mockRestore()
            await scoped.$disconnect()
        }
    })

    it("keeps working when PostgreSQL itself is unavailable (connection refused, no throw)", async () => {
        requireDb()

        const unreachable = new PrismaClient({
            datasources: { db: { url: "postgresql://nobody:nobody@127.0.0.1:1/nothing?connect_timeout=1" } },
        })
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        try {
            await expect(
                persistError(recordOf(), contextOf("p2-db-pg-down"), { create: realCreate(unreachable) } as never, { timeoutMs: 5_000 }),
            ).resolves.toBeUndefined()

            expect(spy).toHaveBeenCalledTimes(1)
            const parsed = JSON.parse(spy.mock.calls[0]![0] as string) as Record<string, unknown>
            expect(parsed.reason).toBe("db_insert_failed")
        } finally {
            spy.mockRestore()
            await unreachable.$disconnect()
        }
    })

    it("recordError never rejects even though persistence is real (route path stays fail-open)", async () => {
        requireDb()
        const requestId = "p2-db-record-error-failopen"
        createdRequestIds.push(requestId)
        vi.spyOn(console, "error").mockImplementation(() => {})

        await expect(
            recordError(new QuotaUnavailableError(), contextOf(requestId)),
        ).resolves.toBeUndefined()

        // مسیر default (همان مسیر route) واقعاً نوشته است — یعنی fail-open از «عدم تلاش» نیامده
        expect(await rowByRequestId(requestId)).toHaveLength(1)
    })
}, DB_TEST_TIMEOUT_MS)
