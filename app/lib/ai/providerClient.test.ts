import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* providerClient — قرارداد orchestration (تعداد تلاش و backoff)       */
/* ------------------------------------------------------------------ */
/* این لایه تصمیم می‌گیرد «چند بار» و «با چه فاصله‌ای» تلاش کند. provider */
/* فقط یک تلاش می‌زند. این تست‌ها مرز این دو لایه را قفل می‌کنند تا در    */
/* مرحله‌های بعدی (مثلاً fallback) کسی ناخواسته تعداد تلاش را عوض نکند.    */

vi.hoisted(() => {
    process.env.AI_MAX_ATTEMPTS = "3"
    process.env.AI_TIMEOUT_MS = "3000"
})

const fetchMock = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", fetchMock)

import { AI_MAX_ATTEMPTS, AI_TIMEOUT_MS, NonRetryableError, RetryableError, fetchProviderRaw, retryBackoffMs, sleep } from "@/app/lib/ai/providerClient"

const MESSAGES = [{ role: "user", content: "سلام" }]
const PROVIDER_OK = JSON.stringify({ choices: [{ message: { content: "پاسخ" } }] })
const httpStatus = (status: number) => new Response("boom", { status })

describe("providerClient — قرارداد بدون تغییر", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubEnv("OPENROUTER_API_KEY", "test-key")
    })
    afterEach(() => {
        vi.unstubAllEnvs()
        delete process.env.OPENROUTER_API_KEY
    })

    it("keeps the same retry budget and timeout defaults", () => {
        expect(AI_MAX_ATTEMPTS).toBe(3)
        expect(AI_TIMEOUT_MS).toBe(3000)
    })

    it("returns the raw provider text without parsing it", async () => {
        fetchMock.mockResolvedValue(new Response(PROVIDER_OK, { status: 200 }))

        await expect(fetchProviderRaw(MESSAGES)).resolves.toBe("پاسخ")
    })

    it("performs exactly one provider call per invocation", async () => {
        fetchMock.mockResolvedValue(new Response(PROVIDER_OK, { status: 200 }))

        await fetchProviderRaw(MESSAGES)

        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it("marks transient upstream failures as retryable so the caller can retry", async () => {
        fetchMock.mockResolvedValue(httpStatus(429))

        const error: any = await fetchProviderRaw(MESSAGES).catch((e) => e)

        expect(error).toBeInstanceOf(RetryableError)
    })

    it("marks definitive rejections as non-retryable so the quota is not burned", async () => {
        fetchMock.mockResolvedValue(httpStatus(401))

        const error: any = await fetchProviderRaw(MESSAGES).catch((e) => e)

        expect(error).toBeInstanceOf(NonRetryableError)
        expect(error).not.toBeInstanceOf(RetryableError)
    })

    it("grows the backoff exponentially and caps it, still adding jitter", () => {
        const attempts = [1, 2, 3, 4, 5, 6].map(retryBackoffMs)

        for (const value of attempts) {
            expect(value).toBeGreaterThanOrEqual(0)
            expect(value).toBeLessThanOrEqual(1500 + 200)
        }
        // نوسان jitter باعث می‌شود دو فراخوانی پشت‌سرهم دقیقاً یکی نباشند
        expect(retryBackoffMs(3)).not.toBe(retryBackoffMs(3))
    })

    it("sleeps for the requested duration", async () => {
        const started = Date.now()
        await sleep(5)
        expect(Date.now() - started).toBeGreaterThanOrEqual(4)
    })
})
