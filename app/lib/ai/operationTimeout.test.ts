import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* مرحلهٔ ۳ — سقف زمانی کل عملیات (operation-level budget)              */
/* ------------------------------------------------------------------ */
/* هدف: وقتی fallback فعال است، «1xAI retries + OpenRouter» نباید از      */
/* تایماوت پلتفرم رد شود.                                                 */
/*                                                                      */
/* نکتهٔ کلیدی طراحی: وقتی fallback خاموش است (حالت پیش‌فرض production) */
/* هیچ سقف کلی ساخته نمی‌شود تا رفتار فعلی 1xAI دست‌نخورده بماند.         */
/*                                                                      */
/* چرا هر گروه یک ماژول تازه import می‌کند: مقادیر AI_MAX_ATTEMPTS و */
/* AI_TIMEOUT_MS و AI_OPERATION_TIMEOUT_MS در سطح ماژول خوانده می‌شوند،   */
/* پس برای اینکه هر سناریو (بودجهٔ بزرگ برای fallback، بودجهٔ کوچک برای  */
/* deadline) قطعی باشد، هر گروه ماژول خودش را با env خودش بارگذاری می‌کند. */
/* بدون این کار، jitter بک‌اف مرز تست را ناپایدار می‌کرد.                   */
/*                                                                      */
/* همه‌جا fetch کاملاً mock است؛ هیچ درخواست واقعی ارسال نمی‌شود.          */

const fetchMock = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", fetchMock)

type Client = typeof import("@/app/lib/ai/providerClient")

const BASE_ENV = {
    AIXAI_API_KEY: "aixai-key",
    OPENROUTER_API_KEY: "or-key",
    AI_ALLOW_FALLBACK: "true",
}

const MESSAGES = [{ role: "user", content: "سلام" }]

/** یک نمونهٔ تازه از ماژول با env دلخواه — پایهٔ قطعی‌بودن تست‌ها. */
const loadClient = async (env: Record<string, string | undefined>): Promise<Client> => {
    vi.resetModules()
    for (const key of Object.keys(process.env)) {
        if (key.startsWith("AI_") || key.startsWith("AIXAI_") || key.startsWith("OPENROUTER_")) {
            delete process.env[key]
        }
    }
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) process.env[key] = value
    }
    return await import("@/app/lib/ai/providerClient")
}

const OK = JSON.stringify({ choices: [{ message: { content: "پاسخ" } }] })
const ok = () => new Response(OK, { status: 200 })
const status = (code: number) => new Response("boom", { status: code })

/** fetch که تا abort معلق می‌ماند — شبیه‌سازی تایماوت. */
const hangUntilAborted = () =>
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
                const error = new Error("The operation was aborted")
                error.name = "AbortError"
                reject(error)
            })
        }),
    )

const urls = () => fetchMock.mock.calls.map((call) => String(call[0]))
const oneXaiCalls = () => urls().filter((u) => u.startsWith("https://1xai.ir")).length
const openRouterCalls = () => urls().filter((u) => u.startsWith("https://openrouter.ai")).length

const globalAfterEach = () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    for (const key of Object.keys(process.env)) {
        if (key.startsWith("AI_") || key.startsWith("AIXAI_") || key.startsWith("OPENROUTER_")) {
            delete process.env[key]
        }
    }
}

const resetFetch = () => fetchMock.mockReset()

/* --- محاسبهٔ بودجه --------------------------------------------------- */

describe("operation timeout — محاسبهٔ بودجه و ایمنی پیش‌فرض", () => {
    afterEach(globalAfterEach)

    it("uses the explicit AI_OPERATION_TIMEOUT_MS when provided", async () => {
        const client = await loadClient({ ...BASE_ENV, AI_TIMEOUT_MS: "3000", AI_OPERATION_TIMEOUT_MS: "10000" })
        expect(client.AI_OPERATION_TIMEOUT_MS).toBe(10000)
    })

    it("derives a default budget from attempts × timeout plus backoff headroom", async () => {
        const client = await loadClient({ ...BASE_ENV, AI_MAX_ATTEMPTS: "3", AI_TIMEOUT_MS: "12000" })
        expect(client.AI_OPERATION_TIMEOUT_MS).toBe(53000)
    })

    it("never lets a configured budget exceed the hard platform cap", async () => {
        const client = await loadClient({ ...BASE_ENV, AI_OPERATION_TIMEOUT_MS: "999999" })
        expect(client.AI_OPERATION_TIMEOUT_MS).toBe(60000)
    })

    it("keeps at least one full attempt so the fallback is never starved", async () => {
        const client = await loadClient({ ...BASE_ENV, AI_TIMEOUT_MS: "9000", AI_OPERATION_TIMEOUT_MS: "10" })
        expect(client.AI_OPERATION_TIMEOUT_MS).toBe(9000)
    })

    it("ignores a malformed value and falls back to the derived default", async () => {
        // (۲ تلاش + ۱ تلاش fallback) × ۵ ثانیه + ۵ ثانیه حاشیه = ۲۰ ثانیه
        const client = await loadClient({ ...BASE_ENV, AI_MAX_ATTEMPTS: "2", AI_TIMEOUT_MS: "5000", AI_OPERATION_TIMEOUT_MS: "abc" })
        expect(client.AI_OPERATION_TIMEOUT_MS).toBe(20000)
    })

    it("keeps the fallback flag off by default", async () => {
        const client = await loadClient({ AIXAI_API_KEY: "aixai-key" })
        expect(client.isAiFallbackEnabled()).toBe(false)
    })
})

/* --- A — success before the deadline --------------------------------- */

describe("A — 1xAI succeeds before the operation deadline", () => {
    afterEach(globalAfterEach)

    it("returns the result and never consults the fallback", async () => {
        const client = await loadClient({
            ...BASE_ENV,
            AI_MAX_ATTEMPTS: "3",
            AI_TIMEOUT_MS: "3000",
            AI_OPERATION_TIMEOUT_MS: "10000",
        })
        resetFetch()
        fetchMock.mockResolvedValue(ok())

        const result = await client.runAiOperation({ buildMessages: () => MESSAGES })

        expect(result.providerId).toBe("1xai")
        expect(result.fallbackUsed).toBe(false)
        expect(result.content).toBe("پاسخ")
        expect(oneXaiCalls()).toBe(1)
        expect(openRouterCalls()).toBe(0)
    })

    it("leaves no pending timers behind on the success path", async () => {
        const client = await loadClient({
            ...BASE_ENV,
            AI_TIMEOUT_MS: "3000",
            AI_OPERATION_TIMEOUT_MS: "10000",
        })
        resetFetch()

        vi.useFakeTimers()
        try {
            fetchMock.mockResolvedValue(ok())

            await client.runAiOperation({ buildMessages: () => MESSAGES })

            // نه timer تایماوت تلاش، نه timer سقف عملیات باقی نمانده باشد
            expect(vi.getTimerCount()).toBe(0)
        } finally {
            vi.useRealTimers()
        }
    })
})

/* --- B — 1xAI times out → retried per policy ------------------------- */

describe("B — 1xAI times out and is retried per policy", () => {
    afterEach(globalAfterEach)

    it("retries the same provider on a per-attempt timeout", async () => {
        // بودجهٔ کل بزرگ‌تر از کلِ سه تلاش است، پس deadline دخالت نمی‌کند.
        // توجه: AI_TIMEOUT_MS یک کف ۳ ثانیه‌ای دارد، پس مقدار ۱۰۰۰ به ۳۰۰۰ می‌رسد.
        const client = await loadClient({
            ...BASE_ENV,
            AI_MAX_ATTEMPTS: "3",
            AI_TIMEOUT_MS: "3000",
            AI_OPERATION_TIMEOUT_MS: "20000",
        })
        resetFetch()
        hangUntilAborted()
        fetchMock.mockImplementationOnce((_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => {
                    const error = new Error("The operation was aborted")
                    error.name = "AbortError"
                    reject(error)
                })
            }),
        )
        fetchMock.mockResolvedValueOnce(ok())

        vi.useFakeTimers()
        try {
            const pending = client.runAiOperation({ buildMessages: () => MESSAGES })
            const assertion = expect(pending).resolves.toMatchObject({ providerId: "1xai" })
            // تایماوت تلاش اول (۳ ثانیه) + بک‌اف + تلاش دوم موفق
            await vi.advanceTimersByTimeAsync(5000)
            await assertion

            expect(oneXaiCalls()).toBe(2)
            expect(openRouterCalls()).toBe(0)
        } finally {
            vi.useRealTimers()
        }
    })

    it("maps a per-attempt timeout to a retryable provider failure", async () => {
        const client = await loadClient({ ...BASE_ENV, AI_TIMEOUT_MS: "3000", AI_OPERATION_TIMEOUT_MS: "20000" })
        resetFetch()
        fetchMock.mockRejectedValue(new Error("The operation was aborted"))

        const error: any = await client.runAiOperation({ buildMessages: () => MESSAGES }).catch((e) => e)

        expect(error).toBeInstanceOf(client.RetryableError)
        expect(error).not.toBeInstanceOf(client.OperationDeadlineError)
    })
})

/* --- C — fallback happens inside the budget -------------------------- */

describe("C — primary exhausted → fallback still runs inside the budget", () => {
    afterEach(globalAfterEach)

    it("reaches the fallback with budget to spare", async () => {
        const client = await loadClient({
            ...BASE_ENV,
            AI_MAX_ATTEMPTS: "3",
            AI_TIMEOUT_MS: "3000",
            AI_OPERATION_TIMEOUT_MS: "20000",
        })
        resetFetch()
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await client.runAiOperation({ buildMessages: () => MESSAGES })

        expect(oneXaiCalls()).toBe(3)
        expect(openRouterCalls()).toBe(1)
        expect(result.providerId).toBe("openrouter")
        expect(result.fallbackUsed).toBe(true)
    })
})

/* --- D — deadline hits before fallback starts ------------------------ */

describe("D — the operation deadline expires before fallback starts", () => {
    afterEach(globalAfterEach)

    // بودجهٔ کل عمداً کمتر از کلِ سه تلاش است، پس primary قطعاً «تمام» نمی‌شود و
    // تنها راه رسیدن به fallback، deadline است — یعنی fallback نباید شروع شود.
    // (کف ۳ ثانیه‌ای AI_TIMEOUT_MS رعایت شده: ۳ تلاش ۳ ثانیه‌ای ≈ ۹.۶ ثانیه > ۵ ثانیه)
    const TIGHT_BUDGET_MS = 5000
    const tight = {
        ...BASE_ENV,
        AI_MAX_ATTEMPTS: "3",
        AI_TIMEOUT_MS: "3000",
        AI_OPERATION_TIMEOUT_MS: String(TIGHT_BUDGET_MS),
    }

    it("never issues an OpenRouter request once the deadline is spent", async () => {
        const client = await loadClient(tight)
        resetFetch()
        hangUntilAborted()

        vi.useFakeTimers()
        try {
            const pending = client.runAiOperation({ buildMessages: () => MESSAGES })
            const assertion = expect(pending).rejects.toBeInstanceOf(client.OperationDeadlineError)
            await vi.advanceTimersByTimeAsync(TIGHT_BUDGET_MS)
            await assertion

            expect(openRouterCalls()).toBe(0)
        } finally {
            vi.useRealTimers()
        }
    })

    it("reports a deadline error rather than a generic provider error", async () => {
        const client = await loadClient(tight)
        resetFetch()
        hangUntilAborted()

        vi.useFakeTimers()
        try {
            const pending = client.runAiOperation({ buildMessages: () => MESSAGES })
            const assertion = expect(pending).rejects.toThrow("ai operation deadline exceeded")
            await vi.advanceTimersByTimeAsync(TIGHT_BUDGET_MS)
            await assertion
        } finally {
            vi.useRealTimers()
        }
    })

    it("stops issuing primary attempts once the deadline is spent", async () => {
        const client = await loadClient(tight)
        resetFetch()
        hangUntilAborted()

        vi.useFakeTimers()
        try {
            const pending = client.runAiOperation({ buildMessages: () => MESSAGES })
            const assertion = expect(pending).rejects.toBeInstanceOf(client.OperationDeadlineError)
            await vi.advanceTimersByTimeAsync(TIGHT_BUDGET_MS)
            await assertion

            expect(urls().length).toBeLessThan(3)
            expect(urls().every((u) => u.startsWith("https://1xai.ir"))).toBe(true)
        } finally {
            vi.useRealTimers()
        }
    })

    it("clears the deadline timer even when the operation fails on the deadline", async () => {
        const client = await loadClient(tight)
        resetFetch()
        hangUntilAborted()

        vi.useFakeTimers()
        try {
            const pending = client.runAiOperation({ buildMessages: () => MESSAGES }).catch(() => undefined)
            await vi.advanceTimersByTimeAsync(TIGHT_BUDGET_MS)
            await pending

            // مسیر خطا هم نباید timerی جا بگذارد
            expect(vi.getTimerCount()).toBe(0)
        } finally {
            vi.useRealTimers()
        }
    })
})

/* --- E — the fallback provider itself times out ---------------------- */

describe("E — OpenRouter times out", () => {
    afterEach(globalAfterEach)

    it("fails cleanly with the primary error, never with a success", async () => {
        const client = await loadClient({
            ...BASE_ENV,
            AI_MAX_ATTEMPTS: "3",
            AI_TIMEOUT_MS: "3000",
            AI_OPERATION_TIMEOUT_MS: "20000",
        })
        resetFetch()
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        hangUntilAborted()

        vi.useFakeTimers()
        try {
            const pending = client.runAiOperation({ buildMessages: () => MESSAGES })
            const assertion = expect(pending).rejects.toThrow("1xai HTTP 503")
            await vi.advanceTimersByTimeAsync(5000)
            await assertion

            expect(openRouterCalls()).toBe(1)
        } finally {
            vi.useRealTimers()
        }
    })
})

/* --- F — one failure signal, so quota releases once ------------------ */

describe("F — timeout/fallback failure surfaces exactly one error", () => {
    afterEach(globalAfterEach)

    it("throws once, so the caller can release the reservation a single time", async () => {
        const client = await loadClient({
            ...BASE_ENV,
            AI_MAX_ATTEMPTS: "3",
            AI_TIMEOUT_MS: "3000",
            AI_OPERATION_TIMEOUT_MS: "5000",
        })
        resetFetch()
        hangUntilAborted()

        let thrown: unknown = null
        let throwCount = 0
        vi.useFakeTimers()
        try {
            const pending = client
                .runAiOperation({ buildMessages: () => MESSAGES })
                .catch((error) => {
                    throwCount++
                    thrown = error
                })
            await vi.advanceTimersByTimeAsync(5000)
            await pending

            expect(thrown).toBeInstanceOf(client.OperationDeadlineError)
            // دقیقاً یک بار throw شده: caller یک‌بار release می‌کند، نه دوبار
            expect(throwCount).toBe(1)
        } finally {
            vi.useRealTimers()
        }
    })
})

/* --- G — fallback off: previous behavior preserved ------------------ */

describe("G — with the fallback flag off, no operation deadline is applied", () => {
    afterEach(globalAfterEach)

    it("keeps the original retry budget even beyond the operation timeout", async () => {
        // سقف عملیات ۵ ثانیه است ولی flag خاموش است → نباید اعمال شود؛
        // باید هر سه تلاش primary کامل اجرا شوند.
        const client = await loadClient({
            AIXAI_API_KEY: "aixai-key",
            OPENROUTER_API_KEY: "or-key",
            AI_ALLOW_FALLBACK: "false",
            AI_MAX_ATTEMPTS: "3",
            AI_TIMEOUT_MS: "3000",
            AI_OPERATION_TIMEOUT_MS: "5000",
        })
        resetFetch()
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await client.runAiOperation({ buildMessages: () => MESSAGES })

        expect(oneXaiCalls()).toBe(3)
        expect(openRouterCalls()).toBe(0)
        expect(result.providerId).toBe("1xai")
    })

    it("never reports a deadline error when the flag is off", async () => {
        const client = await loadClient({
            AIXAI_API_KEY: "aixai-key",
            OPENROUTER_API_KEY: "or-key",
            AI_ALLOW_FALLBACK: "false",
            AI_MAX_ATTEMPTS: "2",
            AI_TIMEOUT_MS: "3000",
            AI_OPERATION_TIMEOUT_MS: "5000",
        })
        resetFetch()
        fetchMock.mockResolvedValue(status(503))

        const error: any = await client.runAiOperation({ buildMessages: () => MESSAGES }).catch((e) => e)

        expect(error).toBeInstanceOf(client.RetryableError)
        expect(error).not.toBeInstanceOf(client.OperationDeadlineError)
        expect(error.message).toBe("1xai HTTP 503")
    })
})
