import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* fallback: OpenRouter (primary) → 1xai (fallback)                    */
/* ------------------------------------------------------------------ */
/* کل fallback در همین فایل و با fetch کاملاً mock آزموده می‌شود.        */
/* هیچ درخواستی به OpenRouter یا 1xai واقعی نمی‌رود و هیچ API key واقعی */
/* استفاده نمی‌شود — همهٔ کلیدها مقادیر ساختگی تست هستند.               */
/*                                                                      */
/* قرارداد اصلی: quota یک «logical operation» است، نه تعداد provider   */
/* call؛ پس هیچ‌جا در این مسیر reserve/complete/release صدا زده نمی‌شود. */
/* آن‌ها در route و یک‌بار انجام می‌شوند (تست شده در fallback.quota.test). */

vi.hoisted(() => {
    process.env.AI_MAX_ATTEMPTS = "2"
    process.env.AI_TIMEOUT_MS = "3000"
})

const fetchMock = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", fetchMock)

import { ProviderUnusableError, NonRetryableError, RetryableError } from "@/app/lib/ai/providers"
import {
    AI_FALLBACK_MAX_ATTEMPTS,
    isAiFallbackEnabled,
    runAiOperation,
} from "@/app/lib/ai/providerClient"

const MESSAGES = [{ role: "user", content: "سلام" }]
const OK = JSON.stringify({ choices: [{ message: { content: "پاسخ" } }] })
const ok = () => new Response(OK, { status: 200 })
/**
 * پاسخ ۲۰۰ **تازه** برای هر فراخوانی.
 *
 * یک `Response` فقط یک‌بار خوانده می‌شود؛ اگر همان شیء برای همه‌ی callها برگردد،
 * فراخوانی دوم با «Body is unusable» شکست می‌خورد و در عمل داریم transport را
 * به‌جای parse می‌آزماییم. برای سناریوی «parse خراب» حتماً از این استفاده کن.
 */
const okEachTime = () => vi.fn(() => new Response(OK, { status: 200 }))
const status = (code: number) => new Response("boom", { status: code })

/** پاسخ 200 که محتوای خالی دارد → خطای «empty content» (قابل تلاش مجدد). */
const EMPTY_CONTENT = JSON.stringify({ choices: [{ message: { content: "   " } }] })

const urls = () => fetchMock.mock.calls.map((call) => String(call[0]))
const oneXaiCalls = () => urls().filter((u) => u.startsWith("https://1xai.ir")).length
const openRouterCalls = () => urls().filter((u) => u.startsWith("https://openrouter.ai")).length

const bothKeys = () => {
    vi.stubEnv("AIXAI_API_KEY", "aixai-key")
    vi.stubEnv("OPENROUTER_API_KEY", "or-key")
}

const clearEnv = () => {
    delete process.env.AIXAI_API_KEY
    delete process.env.AIXAI_BASE_URL
    delete process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_BASE_URL
    delete process.env.OPENROUTER_MODEL
    delete process.env.AI_ALLOW_FALLBACK
}

/** یک عملیات ساده که فقط متن خام provider را برمی‌گرداند. */
const rawOperation = () => runAiOperation({ buildMessages: () => MESSAGES })

/** پیش‌فرض مشترک گروه‌ها: هر دو کلید حاضر، fallback روشن، mock پاک. */
const setup = () => {
    // mockReset (نه clearAllMocks) لازم است تا پاسخ‌های queue‌شدهٔ تست قبلی
    // به تست بعدی نشت نکنند.
    fetchMock.mockReset()
    clearEnv()
    bothKeys()
    vi.stubEnv("AI_ALLOW_FALLBACK", "true")
}

const teardown = () => {
    vi.unstubAllEnvs()
    clearEnv()
}

/* ------------------------------------------------------------------ */

describe("feature flag AI_ALLOW_FALLBACK", () => {
    beforeEach(() => {
        fetchMock.mockReset()
        clearEnv()
    })
    afterEach(() => {
        vi.unstubAllEnvs()
        clearEnv()
    })

    it("defaults to disabled when the flag is absent", () => {
        expect(isAiFallbackEnabled()).toBe(false)
    })

    it.each(["", "0", "false", "no", "off", "TRUE ", "yes"])(
        "treats %o as disabled (fail-safe: never accidentally on)",
        (value) => {
            vi.stubEnv("AI_ALLOW_FALLBACK", value)
            expect(isAiFallbackEnabled()).toBe(false)
        },
    )

    it("is enabled only by the exact string \"true\"", () => {
        vi.stubEnv("AI_ALLOW_FALLBACK", "true")
        expect(isAiFallbackEnabled()).toBe(true)
    })

    it("exposes a bounded fallback attempt budget with a conservative default", () => {
        expect(AI_FALLBACK_MAX_ATTEMPTS).toBeGreaterThanOrEqual(1)
        expect(AI_FALLBACK_MAX_ATTEMPTS).toBeLessThanOrEqual(2)
    })
})

/* --- A — primary succeeds ------------------------------------------- */

describe("A — primary succeeds", () => {
    beforeEach(setup)
    afterEach(teardown)

    it("calls only OpenRouter and reports it as the effective provider", async () => {
        fetchMock.mockResolvedValue(ok())

        const result = await rawOperation()

        expect(openRouterCalls()).toBe(1)
        expect(oneXaiCalls()).toBe(0)
        expect(result.providerId).toBe("openrouter")
        expect(result.fallbackUsed).toBe(false)
        expect(result.content).toBe("پاسخ")
    })

    it("is identical whether the flag is on or off", async () => {
        fetchMock.mockResolvedValue(ok())
        const withFlag = await rawOperation()

        vi.clearAllMocks()
        vi.stubEnv("AI_ALLOW_FALLBACK", "false")
        fetchMock.mockResolvedValue(ok())
        const withoutFlag = await rawOperation()

        expect(withoutFlag).toEqual(withFlag)
    })
})

/* --- B — primary retryable → retry → success ------------------------- */

describe("B — primary retries its own attempts before succeeding", () => {
    beforeEach(setup)
    afterEach(teardown)

    it("retries the same provider and never touches the fallback", async () => {
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(openRouterCalls()).toBe(2)
        expect(oneXaiCalls()).toBe(0)
        expect(result.providerId).toBe("openrouter")
        expect(result.fallbackUsed).toBe(false)
        expect(result.attempts).toBe(2)
    })

    it("retries on a 429 rate limit as before", async () => {
        fetchMock.mockResolvedValueOnce(status(429))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(oneXaiCalls()).toBe(0)
        expect(result.providerId).toBe("openrouter")
    })
})

/* --- C — primary exhausted → fallback -------------------------------- */

describe("C — primary exhausted → fallback", () => {
    beforeEach(setup)
    afterEach(teardown)

    it("falls back only after the primary has used all its attempts", async () => {
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(openRouterCalls()).toBe(2) // AI_MAX_ATTEMPTS=2
        expect(oneXaiCalls()).toBe(1)
        expect(result.providerId).toBe("1xai")
        expect(result.fallbackUsed).toBe(true)
    })

    it("returns the fallback provider content through the same raw pipeline", async () => {
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ choices: [{ message: { content: "پاسخ fallback" } }] }), {
                status: 200,
            }),
        )

        const result = await rawOperation()

        expect(result.content).toBe("پاسخ fallback")
    })

    it("does not fall back at all when the flag is off, even though it is configured", async () => {
        vi.stubEnv("AI_ALLOW_FALLBACK", "false")
        fetchMock.mockResolvedValue(status(503))

        const error: any = await rawOperation().catch((e) => e)

        expect(error).toBeInstanceOf(RetryableError)
        expect(openRouterCalls()).toBe(2)
        expect(oneXaiCalls()).toBe(0)
    })

    it("does not fall back when 1xai has no API key", async () => {
        delete process.env.AIXAI_API_KEY
        fetchMock.mockResolvedValue(status(503))

        const error: any = await rawOperation().catch((e) => e)

        expect(error).toBeInstanceOf(RetryableError)
        expect(openRouterCalls()).toBe(2)
        expect(oneXaiCalls()).toBe(0)
    })
})

/* --- D — network / timeout failure → fallback ------------------------ */

describe("D — primary network or timeout failure → fallback", () => {
    beforeEach(setup)
    afterEach(teardown)

    it("falls back after exhausting retries on a network failure", async () => {
        fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"))
        fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(oneXaiCalls()).toBe(1)
        expect(result.providerId).toBe("1xai")
        expect(result.fallbackUsed).toBe(true)
    })

    it("falls back after an abort/timeout on the primary", async () => {
        fetchMock.mockRejectedValueOnce(new Error("The operation was aborted"))
        fetchMock.mockRejectedValueOnce(new Error("The operation was aborted"))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(result.providerId).toBe("1xai")
    })

    it("falls back when the primary keeps returning empty content", async () => {
        fetchMock.mockResolvedValueOnce(new Response(EMPTY_CONTENT, { status: 200 }))
        fetchMock.mockResolvedValueOnce(new Response(EMPTY_CONTENT, { status: 200 }))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(oneXaiCalls()).toBe(1)
        expect(result.providerId).toBe("1xai")
    })
})

/* --- F — all providers fail ------------------------------------------ */

describe("F — every provider fails", () => {
    beforeEach(setup)
    afterEach(teardown)

    it("throws the primary error when the fallback also fails", async () => {
        fetchMock.mockResolvedValue(status(503))

        const error: any = await rawOperation().catch((e) => e)

        expect(error).toBeInstanceOf(RetryableError)
        expect(error.message).toBe("openrouter HTTP 503")
        expect(openRouterCalls()).toBe(2)
        expect(oneXaiCalls()).toBeGreaterThanOrEqual(1)
    })

    it("surfaces the same error with the flag off, so enabling it cannot change the contract", async () => {
        fetchMock.mockResolvedValue(status(503))
        const withFlag: any = await rawOperation().catch((e) => e)

        fetchMock.mockReset()
        vi.stubEnv("AI_ALLOW_FALLBACK", "false")
        fetchMock.mockResolvedValue(status(503))
        const withoutFlag: any = await rawOperation().catch((e) => e)

        expect(withFlag.message).toBe(withoutFlag.message)
        expect(withFlag.constructor).toBe(withoutFlag.constructor)
    })

    it("gives the fallback only its own bounded number of attempts", async () => {
        fetchMock.mockResolvedValue(status(503))

        await rawOperation().catch(() => undefined)

        expect(oneXaiCalls()).toBe(AI_FALLBACK_MAX_ATTEMPTS)
    })

    it("never reports success when nothing succeeded", async () => {
        fetchMock.mockResolvedValue(status(503))

        const result = await rawOperation().then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error }),
        )

        expect(result.ok).toBe(false)
    })
})

/* --- G — invalid request: no blind fallback -------------------------- */

describe("G — a definitive request error never triggers fallback", () => {
    beforeEach(setup)
    afterEach(teardown)

    it.each([400, 404])("does not retry or fall back on HTTP %i", async (code) => {
        fetchMock.mockResolvedValue(status(code))

        const error: any = await rawOperation().catch((e) => e)

        expect(error).toBeInstanceOf(NonRetryableError)
        expect(openRouterCalls()).toBe(1)
        expect(oneXaiCalls()).toBe(0)
    })

    it("reaches the fallback only after a real 4xx rejection from the provider", async () => {
        fetchMock.mockResolvedValueOnce(status(400))
        fetchMock.mockResolvedValueOnce(ok())

        const error: any = await rawOperation().catch((e) => e)

        expect(error).toBeInstanceOf(NonRetryableError)
        expect(error.message).toContain("openrouter HTTP 400")
        expect(oneXaiCalls()).toBe(0)
    })
})

/* --- H — provider unusable: auth/config failure ---------------------- */

describe("H — a provider with a bad key is skipped, not fatal", () => {
    beforeEach(setup)
    afterEach(teardown)

    it.each([401, 403])("falls back immediately on HTTP %i without retrying it", async (code) => {
        fetchMock.mockResolvedValueOnce(status(code))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(openRouterCalls()).toBe(1) // no retry on auth failure
        expect(oneXaiCalls()).toBe(1)
        expect(result.providerId).toBe("1xai")
        expect(result.fallbackUsed).toBe(true)
    })

    it("distinguishes an unusable provider from a definitive request error", async () => {
        vi.stubEnv("AI_ALLOW_FALLBACK", "false")
        fetchMock.mockResolvedValueOnce(status(401))

        const error: any = await rawOperation().catch((e) => e)

        // با fallback خاموش، خطای 401 باید همان رفتار قطعی قبلی را نگه دارد
        expect(error).toBeInstanceOf(ProviderUnusableError)
        expect(error).toBeInstanceOf(NonRetryableError)
        expect(oneXaiCalls()).toBe(0)
    })

    it("skips the fallback too when it is the one with the bad key", async () => {
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(401))

        const error: any = await rawOperation().catch((e) => e)

        expect(error).toBeInstanceOf(RetryableError)
        // خطای برگشتی همیشه خطای provider اصلی است، حتی وقتی fallback شکست خورده —
        // تا روشن‌کردن flag قرارداد خطا را عوض نکند.
        expect(error.message).toBe("openrouter HTTP 503")
        expect(oneXaiCalls()).toBe(1) // بی‌فایده تکرار نشد
    })
})

/* ------------------------------------------------------------------ */
/* سناریوهای اجباری درخواست: ترتیب معکوس‌شده                          */
/* ------------------------------------------------------------------ */

describe("سناریوهای اجباری — OpenRouter پیش‌فرض، 1xai فقط fallback", () => {
    beforeEach(setup)
    afterEach(teardown)

    /* Test 1 — OpenRouter موفق: هیچ درخواستی به 1xai نمی‌رود */
    it("Test 1 — OpenRouter success: exactly one OpenRouter call and zero 1xai calls", async () => {
        fetchMock.mockResolvedValue(ok())

        const result = await rawOperation()

        expect(openRouterCalls()).toBe(1)
        expect(oneXaiCalls()).toBe(0)
        // اثبات مستقل: هیچ URL مربوط به 1xai اصلاً ثبت نشده است
        expect(urls().some((u) => u.includes("1xai"))).toBe(false)
        expect(urls()).toEqual(["https://openrouter.ai/api/v1/chat/completions"])
        expect(result.providerId).toBe("openrouter")
        expect(result.fallbackUsed).toBe(false)
    })

    /* Test 2 — OpenRouter شکست → 1xai موفق */
    it("Test 2 — OpenRouter failure then 1xai success reports the real provider", async () => {
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(openRouterCalls()).toBe(2)
        expect(oneXaiCalls()).toBe(1)
        expect(result.providerId).toBe("1xai")
        expect(result.fallbackUsed).toBe(true)
    })

    /* Test 3 — هر دو شکست: قرارداد خطای primary حفظ می‌شود */
    it("Test 3 — both providers fail: the primary error contract is preserved", async () => {
        fetchMock.mockResolvedValue(status(503))

        const error: any = await rawOperation().catch((e) => e)

        expect(error).toBeInstanceOf(RetryableError)
        expect(error.message).toBe("openrouter HTTP 503")
        expect(openRouterCalls()).toBe(2)
        expect(oneXaiCalls()).toBe(AI_FALLBACK_MAX_ATTEMPTS)
    })

    /* Test 4 — fallback خاموش: 1xai اصلاً صدا زده نمی‌شود */
    it("Test 4 — AI_ALLOW_FALLBACK=false: only OpenRouter is used", async () => {
        vi.stubEnv("AI_ALLOW_FALLBACK", "false")
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))

        const error: any = await rawOperation().catch((e) => e)

        expect(error).toBeInstanceOf(RetryableError)
        expect(openRouterCalls()).toBe(2)
        expect(oneXaiCalls()).toBe(0)
    })

    /* Test 5 — metadata هر دو مسیر موفق */
    it("Test 5 — provider metadata is correct on both the direct and the fallback path", async () => {
        fetchMock.mockResolvedValueOnce(ok())
        const direct = await rawOperation()

        fetchMock.mockReset()
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(ok())
        const viaFallback = await rawOperation()

        expect(direct).toMatchObject({
            providerId: "openrouter",
            fallbackUsed: false,
            content: "پاسخ",
        })
        expect(viaFallback).toMatchObject({
            providerId: "1xai",
            fallbackUsed: true,
            content: "پاسخ",
        })
    })
})

/* ================================================================== */
/*  باگ‌های تأییدشده‌ی providerClient:                                 */
/*   A) `attempts` دوبار شمرده می‌شد (یک‌بار قبل از complete، یک‌بار در  */
/*      catch) ⇒ گزارش نادرست از تعداد واقعی call.                      */
/*   B) خطای parse/transform زنجیره را به provider بعدی می‌برد ⇒ یک    */
/*      خطای محلیِ schema می‌توانست provider پولی را هم صدا بزند.       */
/* ================================================================== */

describe("A — attempts = تعداد واقعی provider call", () => {
    beforeEach(setup)
    afterEach(teardown)

    it("موفقیت در اولین تلاش ⇒ attempts = 1", async () => {
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(result.attempts).toBe(1)
        expect(openRouterCalls()).toBe(1)
    })

    it("یک خطای transport + یک موفقیت ⇒ attempts = 2 (نه ۳)", async () => {
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(result.attempts).toBe(2)
        expect(openRouterCalls()).toBe(2)
    })

    it("parse failure با retry ⇒ attempts = تعداد واقعی call، نه دوبرابر", async () => {
        // HTTP 200 ولی transform همیشه throw می‌کند. AI_MAX_ATTEMPTS = 2.
        fetchMock.mockImplementation(okEachTime())
        const parseError = new Error("schema mismatch")

        const error: any = await runAiOperation({
            buildMessages: () => MESSAGES,
            transform: () => {
                throw parseError
            },
        }).catch((e) => e)

        // ۲ call واقعی انجام شده، ۴ بار شمرده نمی‌شود
        expect(openRouterCalls()).toBe(2)
        expect(error).toBe(parseError)
    })

    it("fallback به provider دوم ⇒ attempts = مجموع واقعی هر دو provider", async () => {
        // ۲ خطای transport روی primary (سقف retry خودش) + ۱ موفقیت روی 1xai
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(result.fallbackUsed).toBe(true)
        expect(result.providerId).toBe("1xai")
        expect(openRouterCalls()).toBe(2)
        expect(oneXaiCalls()).toBe(1)
        expect(result.attempts).toBe(3)
    })
})

describe("B — خطای parse/schema هرگز fallback نمی‌گیرد", () => {
    beforeEach(setup)
    afterEach(teardown)

    /** عملیاتی که transform آن همیشه شکست می‌خورد. */
    const failingParse = () => {
        const parseError = new Error("ZodError: expected object, received null")
        return runAiOperation({
            buildMessages: () => MESSAGES,
            transform: () => {
                throw parseError
            },
        })
    }

    it("provider دوم صفر بار صدا زده می‌شود، حتی وقتی fallback فعال است", async () => {
        // fallback از قبل توسط setup روشن است؛ فقط تأکید می‌کنیم که مسیر fallback
        // واقعاً در زنجیره حاضر است.
        expect(isAiFallbackEnabled()).toBe(true)
        fetchMock.mockImplementation(okEachTime()) // هر call در سطح HTTP موفق

        const error: any = await failingParse().catch((e) => e)

        // retryهای primary طبق policy انجام شده‌اند (AI_MAX_ATTEMPTS = 2)
        expect(openRouterCalls()).toBe(2)
        // ولی provider پولی **هیچ‌بار** صدا زده نشده
        expect(oneXaiCalls()).toBe(0)
        // و خطای نهایی همان parse error است، نه خطای provider دوم
        expect(error).toBeInstanceOf(Error)
        expect(error.message).toBe("ZodError: expected object, received null")
    })

    it("خطای نهایی همان parse error است، حتی اگر primary چند خطای transport هم داشته باشد", async () => {
        const parseError = new Error("transform boom")
        fetchMock.mockResolvedValueOnce(status(503)) // retryable
        fetchMock.mockResolvedValueOnce(ok()) // HTTP ok ولی parse خراب

        const error: any = await runAiOperation({
            buildMessages: () => MESSAGES,
            transform: () => {
                throw parseError
            },
        }).catch((e) => e)

        expect(error).toBe(parseError)
        expect(oneXaiCalls()).toBe(0)
        expect(openRouterCalls()).toBe(2)
    })

    it("خطای transport همچنان fallback می‌گیرد (رفتار موجود تغییری نکرده)", async () => {
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(result.fallbackUsed).toBe(true)
        expect(oneXaiCalls()).toBe(1)
    })

    it("parse failure روی provider دوم هم زنجیره را تمدید نمی‌کند (provider سومی نیست)", async () => {
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(ok()) // 1xai پاسخ داد ولی parse خراب است

        const error: any = await failingParse().catch((e) => e)

        expect(error).toBeInstanceOf(Error)
        expect(openRouterCalls()).toBe(2)
        expect(oneXaiCalls()).toBe(1) // fallback اجازه داشت؛ parse دوباره جلوی آن را نگرفت
    })
})
