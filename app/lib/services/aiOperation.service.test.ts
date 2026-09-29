// AI Quota v2 — تست مسیر مرکزی چرخهٔ حیات (`aiOperation.service`)
//
// هدف این تست ثابت‌کردن **ترتیب و مرزها** است، نه منطق داخلی هر سرویس:
//   resolve policy → reserve → execute → complete / release
// و اینکه تصمیم legacy/جدید فقط از یک جا می‌آید.
//
// سرویس‌های پایین دست mock می‌شوند عمداً: آن‌ها خودشان تست جدا دارند. اینجا
// چیزی که باید قفل شود «سیم‌کشی» است — اینکه caller نمی‌تواند مرحله‌ای را رد کند.

import { beforeEach, describe, expect, it, vi } from "vitest"

const cutover = vi.hoisted(() => ({ cutoverAt: new Date("2026-10-01T00:00:00.000Z") }))
const legacy = vi.hoisted(() => ({
    reserveQuota: vi.fn(),
    completeQuota: vi.fn(),
    releaseQuota: vi.fn(),
}))
const v2 = vi.hoisted(() => ({
    reserveBucketQuota: vi.fn(),
    completeBucketQuota: vi.fn(),
    releaseBucketQuota: vi.fn(),
}))
const usage = vi.hoisted(() => ({
    markReleaseFailed: vi.fn(),
    recordProviderOutcome: vi.fn(),
}))

// فقط خواندن مرز mock می‌شود؛ خودِ `resolveQuotaMode` واقعی می‌ماند تا مرزِ
// «دقیقاً روی periodStart» در این تست هم واقعاً اجرا شود، نه اینکه assume شود.
vi.mock("./aiQuotaCutover.service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./aiQuotaCutover.service")>()
    return { ...actual, readCutoverAt: vi.fn(async () => cutover.cutoverAt) }
})

vi.mock("./aiQuota.service", () => legacy)
vi.mock("./aiQuotaV2.service", () => v2)
vi.mock("./aiUsage.service", () => usage)
vi.mock("@/app/lib/ai/aiDuration", () => ({
    readAiCallTelemetry: vi.fn(() => undefined),
}))

import { runAiOperation } from "./aiOperation.service"
import { AiProviderUnavailableError, QuotaUnavailableError } from "./errors"

const BEFORE_CUTOVER = new Date("2026-09-15T12:00:00.000Z")
const AT_CUTOVER = new Date("2026-10-01T00:00:00.000Z")

const user = { id: 7, plan: "FREE", timezone: "UTC" }
const prisma = { __fake: true } as any

function reset() {
    vi.clearAllMocks()
    legacy.reserveQuota.mockResolvedValue(undefined)
    legacy.completeQuota.mockResolvedValue(true)
    legacy.releaseQuota.mockResolvedValue(true)
    v2.reserveBucketQuota.mockResolvedValue({
        quotaSource: "BASE",
        bucketId: 1,
        periodStart: AT_CUTOVER,
        policyAllowedUnits: 15,
    })
    v2.completeBucketQuota.mockResolvedValue(true)
    v2.releaseBucketQuota.mockResolvedValue(true)
    usage.recordProviderOutcome.mockResolvedValue(true)
    usage.markReleaseFailed.mockResolvedValue(true)
}

describe("runAiOperation — مسیر LEGACY (دورهٔ قبل از cutover)", () => {
    beforeEach(reset)

    it("reserve قدیمی را صدا می‌زند و مسیر جدید را نه", async () => {
        const out = await runAiOperation({
            prisma,
            user,
            feature: "analyze",
            requestId: "r-1",
            now: BEFORE_CUTOVER,
            execute: async () => ({ result: "ok" }),
        })

        expect(out.quotaMode).toBe("LEGACY")
        expect(out.quotaSource).toBe("LEGACY")
        expect(legacy.reserveQuota).toHaveBeenCalledTimes(1)
        expect(v2.reserveBucketQuota).not.toHaveBeenCalled()
    })

    it("سقف از policy قدیمیِ plan می‌آید و units از جدول فیچر", async () => {
        await runAiOperation({
            prisma,
            user,
            feature: "plan",
            requestId: "r-2",
            now: BEFORE_CUTOVER,
            execute: async () => ({ result: "ok" }),
        })
        const arg = legacy.reserveQuota.mock.calls[0][1]
        expect(arg.units).toBe(1)
        expect(arg.feature).toBe("plan")
        expect(arg.userId).toBe(7)
    })

    it("موفقیت ⇒ complete", async () => {
        await runAiOperation({
            prisma,
            user,
            feature: "analyze",
            requestId: "r-3",
            now: BEFORE_CUTOVER,
            execute: async () => ({ result: "ok" }),
        })
        expect(legacy.completeQuota).toHaveBeenCalledTimes(1)
        expect(legacy.releaseQuota).not.toHaveBeenCalled()
    })

    it("شکست execute ⇒ release و سپس rethrow خطای اصلی", async () => {
        const boom = new Error("task not found")
        await expect(
            runAiOperation({
                prisma,
                user,
                feature: "analyze",
                requestId: "r-4",
                now: BEFORE_CUTOVER,
                execute: async () => {
                    throw boom
                },
            }),
        ).rejects.toBe(boom)

        expect(legacy.releaseQuota).toHaveBeenCalledTimes(1)
        expect(legacy.completeQuota).not.toHaveBeenCalled()
    })

    it("شکست provider ⇒ failureCode همان کد taxonomy می‌نشیند", async () => {
        const err = new AiProviderUnavailableError()
        await expect(
            runAiOperation({
                prisma,
                user,
                feature: "analyze",
                requestId: "r-5",
                now: BEFORE_CUTOVER,
                execute: async () => {
                    throw err
                },
            }),
        ).rejects.toBe(err)

        const options = legacy.releaseQuota.mock.calls[0][3]
        expect(options.failureCode).toBe("AI_PROVIDER_UNAVAILABLE")
    })

    it("شکست release ⇒ markReleaseFailed + fail-closed", async () => {
        legacy.releaseQuota.mockRejectedValue(new Error("db down"))
        await expect(
            runAiOperation({
                prisma,
                user,
                feature: "analyze",
                requestId: "r-6",
                now: BEFORE_CUTOVER,
                execute: async () => {
                    throw new Error("boom")
                },
            }),
        ).rejects.toBeInstanceOf(QuotaUnavailableError)
        expect(usage.markReleaseFailed).toHaveBeenCalledWith(prisma, "r-6")
    })
})

describe("runAiOperation — مسیر NEW (از لحظهٔ cutover)", () => {
    beforeEach(reset)

    it("دقیقاً روی periodStart مرز، همان دوره NEW است (تصمیم محصول)", async () => {
        const out = await runAiOperation({
            prisma,
            user,
            feature: "analyze",
            requestId: "n-1",
            now: AT_CUTOVER,
            execute: async () => ({ result: "ok" }),
        })
        expect(out.quotaMode).toBe("NEW")
        expect(v2.reserveBucketQuota).toHaveBeenCalledTimes(1)
        expect(legacy.reserveQuota).not.toHaveBeenCalled()
    })

    it("بُعد و هزینه از جدول فیچر به ledger تازه می‌رود", async () => {
        await runAiOperation({
            prisma,
            user,
            feature: "plan",
            requestId: "n-2",
            now: AT_CUTOVER,
            execute: async () => ({ result: "ok" }),
        })
        expect(v2.reserveBucketQuota).toHaveBeenCalledWith(
            prisma,
            expect.objectContaining({ feature: "PLAN", units: 1, userId: 7 }),
        )
    })

    it("منبع واقعی مصرف (PROMO/BASE) از خود رزرو گزارش می‌شود", async () => {
        v2.reserveBucketQuota.mockResolvedValue({
            quotaSource: "PROMO",
            bucketId: 5,
            periodStart: AT_CUTOVER,
            policyAllowedUnits: 15,
        })
        const out = await runAiOperation({
            prisma,
            user,
            feature: "analyze",
            requestId: "n-3",
            now: AT_CUTOVER,
            execute: async () => ({ result: "ok" }),
        })
        expect(out.quotaSource).toBe("PROMO")
    })

    it("موفقیت ⇒ complete روی همان ledger", async () => {
        await runAiOperation({
            prisma,
            user,
            feature: "analyze",
            requestId: "n-4",
            now: AT_CUTOVER,
            execute: async () => ({ result: "ok" }),
        })
        expect(v2.completeBucketQuota).toHaveBeenCalledTimes(1)
        expect(legacy.completeQuota).not.toHaveBeenCalled()
    })

    it("شکست execute ⇒ release روی ledger جدید، نه قدیمی", async () => {
        await expect(
            runAiOperation({
                prisma,
                user,
                feature: "analyze",
                requestId: "n-5",
                now: AT_CUTOVER,
                execute: async () => {
                    throw new Error("boom")
                },
            }),
        ).rejects.toThrow("boom")

        expect(v2.releaseBucketQuota).toHaveBeenCalledTimes(1)
        expect(legacy.releaseQuota).not.toHaveBeenCalled()
    })
})

describe("runAiOperation — audit provider (تصمیم D6)", () => {
    beforeEach(reset)

    it("provider واقعی از نتیجهٔ provider client ثبت می‌شود، نه hard-code", async () => {
        await runAiOperation({
            prisma,
            user,
            feature: "analyze",
            requestId: "d-1",
            now: AT_CUTOVER,
            execute: async () => ({
                result: "ok",
                provider: { provider: "openrouter", model: "gpt-x", fallbackUsed: true },
            }),
        })
        expect(usage.recordProviderOutcome).toHaveBeenCalledWith(prisma, "d-1", {
            provider: "openrouter",
            model: "gpt-x",
            fallbackUsed: true,
        })
    })

    it("نبودِ provider (مثلاً mock) چیزی ثبت نمی‌کند ولی نتیجه سالم می‌ماند", async () => {
        const out = await runAiOperation({
            prisma,
            user,
            feature: "analyze",
            requestId: "d-2",
            now: AT_CUTOVER,
            execute: async () => ({ result: "mocked" }),
        })
        expect(usage.recordProviderOutcome).not.toHaveBeenCalled()
        expect(out.result).toBe("mocked")
    })
})

describe("runAiOperation — caller نمی‌تواند quota را دور بزند", () => {
    beforeEach(reset)

    it("reserve شکست خورد ⇒ execute هرگز صدا زده نمی‌شود", async () => {
        v2.reserveBucketQuota.mockRejectedValue(new QuotaUnavailableError())
        const execute = vi.fn(async () => ({ result: "should not happen" }))

        await expect(
            runAiOperation({
                prisma,
                user,
                feature: "analyze",
                requestId: "g-1",
                now: AT_CUTOVER,
                execute,
            }),
        ).rejects.toBeInstanceOf(QuotaUnavailableError)
        expect(execute).not.toHaveBeenCalled()
    })

    it("feature ثبت‌نشده قبل از هر رزروی رد می‌شود", async () => {
        await expect(
            runAiOperation({
                prisma,
                user,
                feature: "not-a-feature" as never,
                requestId: "g-2",
                now: AT_CUTOVER,
                execute: async () => ({ result: "x" }),
            }),
        ).rejects.toMatchObject({ code: "UNKNOWN_AI_FEATURE" })
        expect(legacy.reserveQuota).not.toHaveBeenCalled()
        expect(v2.reserveBucketQuota).not.toHaveBeenCalled()
    })
})
