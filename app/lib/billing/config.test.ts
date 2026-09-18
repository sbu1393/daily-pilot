// فاز ۵ — گام ۱۷: unit test های config بیلینگ (سند §35 «billing config validation»)
//
// فقط resolver خالص `resolveBillingConfig(env)` تست می‌شود: هیچ env واقعی، هیچ I/O و هیچ
// secret ای خوانده/نوشته نمی‌شود. قرارداد این ماژول: fail-fast با پیام «فقط نام کلید»
// (هرگز مقدار کلید در پیام خطا نمی‌آید).

import { describe, expect, it } from "vitest"

import { BILLING_ENV, resolveBillingConfig, type BillingEnvSource } from "./config"

/** env معتبر پایه — هر تست فقط یک کلید را خراب می‌کند. */
function validEnv(overrides: BillingEnvSource = {}): BillingEnvSource {
    return {
        [BILLING_ENV.proAmount]: "100000",
        [BILLING_ENV.proCurrency]: "IRR",
        [BILLING_ENV.proEntitlementDays]: "30",
        [BILLING_ENV.merchantId]: "merchant-secret-value",
        [BILLING_ENV.mode]: "sandbox",
        [BILLING_ENV.baseUrl]: "https://sandbox.zarinpal.com/pg",
        [BILLING_ENV.callbackUrl]: "https://app.example.com/api/billing/callback/zarinpal",
        [BILLING_ENV.zarinpalDescription]: "DailyPilot PRO",
        [BILLING_ENV.orderTtlMs]: "1800000",
        [BILLING_ENV.resultUrlSuccess]: "https://app.example.com/billing/result?state=success",
        [BILLING_ENV.resultUrlFailure]: "https://app.example.com/billing/result?state=failure",
        ...overrides,
    }
}

describe("resolveBillingConfig — valid configuration", () => {
    it("maps every server-side value from the env source", () => {
        const config = resolveBillingConfig(validEnv())

        expect(config).toEqual({
            provider: "ZARINPAL",
            orderTtlMs: 1_800_000,
            pro: { planCode: "PRO", amount: 100000, currency: "IRR", entitlementDays: 30 },
            zarinpal: {
                merchantId: "merchant-secret-value",
                mode: "sandbox",
                baseUrl: "https://sandbox.zarinpal.com/pg",
                callbackUrl: "https://app.example.com/api/billing/callback/zarinpal",
                description: "DailyPilot PRO",
                timeoutMs: 12_000,
            },
            resultUrls: {
                success: "https://app.example.com/billing/result?state=success",
                failure: "https://app.example.com/billing/result?state=failure",
            },
        })
    })

    it("trims values and strips trailing slashes from URLs (no double slash paths)", () => {
        const config = resolveBillingConfig(
            validEnv({
                [BILLING_ENV.zarinpalDescription]: "  DailyPilot PRO  ",
                [BILLING_ENV.baseUrl]: "https://sandbox.zarinpal.com/pg///",
            }),
        )

        expect(config.zarinpal.description).toBe("DailyPilot PRO")
        expect(config.zarinpal.baseUrl).toBe("https://sandbox.zarinpal.com/pg")
    })

    it("accepts mode case-insensitively (sandbox/production only)", () => {
        expect(resolveBillingConfig(validEnv({ [BILLING_ENV.mode]: "SANDBOX" })).zarinpal.mode).toBe(
            "sandbox",
        )
        expect(
            resolveBillingConfig(validEnv({ [BILLING_ENV.mode]: "Production" })).zarinpal.mode,
        ).toBe("production")
    })

    it("uses the documented technical default for the provider timeout (not a business value)", () => {
        const config = resolveBillingConfig(validEnv())

        expect(config.zarinpal.timeoutMs).toBe(12_000)
    })

    it("clamps a too-small provider timeout to the technical minimum", () => {
        const config = resolveBillingConfig(validEnv({ [BILLING_ENV.providerTimeoutMs]: "1000" }))

        expect(config.zarinpal.timeoutMs).toBe(3_000)
    })

    it("keeps the provider id and product plan code fixed (no env override)", () => {
        const config = resolveBillingConfig(validEnv())

        expect(config.provider).toBe("ZARINPAL")
        expect(config.pro.planCode).toBe("PRO")
    })
})

describe("resolveBillingConfig — missing keys (fail-fast)", () => {
    const REQUIRED_KEYS = [
        BILLING_ENV.proAmount,
        BILLING_ENV.proCurrency,
        BILLING_ENV.proEntitlementDays,
        BILLING_ENV.merchantId,
        BILLING_ENV.mode,
        BILLING_ENV.baseUrl,
        BILLING_ENV.callbackUrl,
        BILLING_ENV.zarinpalDescription,
        BILLING_ENV.orderTtlMs,
        BILLING_ENV.resultUrlSuccess,
        BILLING_ENV.resultUrlFailure,
    ] as const

    for (const key of REQUIRED_KEYS) {
        it(`throws naming ${key} when it is absent`, () => {
            const env = validEnv()
            delete env[key]

            expect(() => resolveBillingConfig(env)).toThrow(new RegExp(key))
        })
    }

    it("treats blank/whitespace-only values as missing", () => {
        expect(() =>
            resolveBillingConfig(validEnv({ [BILLING_ENV.merchantId]: "   " })),
        ).toThrow(/BILLING_ZARINPAL_MERCHANT_ID/)
        expect(() => resolveBillingConfig(validEnv({ [BILLING_ENV.orderTtlMs]: " " }))).toThrow(
            /BILLING_ORDER_TTL_MS/,
        )
    })

    it("never echoes the configured value inside the error message", () => {
        let message = ""
        try {
            resolveBillingConfig(validEnv({ [BILLING_ENV.orderTtlMs]: "-5" }))
        } catch (error) {
            message = (error as Error).message
        }

        expect(message).toMatch(/BILLING_ORDER_TTL_MS/)
        expect(message).not.toContain("-5")
    })
})

describe("resolveBillingConfig — invalid values (fail-fast)", () => {
    it("rejects a non-positive or non-integer order TTL (required business value, no default)", () => {
        for (const invalid of ["0", "-1", "1.5", "abc", "1e6"]) {
            expect(() =>
                resolveBillingConfig(validEnv({ [BILLING_ENV.orderTtlMs]: invalid })),
            ).toThrow(/BILLING_ORDER_TTL_MS must be a positive integer/)
        }
    })

    it("rejects invalid product amount / entitlement days", () => {
        expect(() => resolveBillingConfig(validEnv({ [BILLING_ENV.proAmount]: "0" }))).toThrow(
            /BILLING_PRO_AMOUNT must be a positive integer/,
        )
        expect(() =>
            resolveBillingConfig(validEnv({ [BILLING_ENV.proEntitlementDays]: "-30" })),
        ).toThrow(/BILLING_PRO_ENTITLEMENT_DAYS must be a positive integer/)
    })

    it("accepts only IRR (exact, case-sensitive — no unit conversion)", () => {
        for (const invalid of ["IRT", "irr", "USD", "ریال"]) {
            expect(() =>
                resolveBillingConfig(validEnv({ [BILLING_ENV.proCurrency]: invalid })),
            ).toThrow(/BILLING_PRO_CURRENCY must be "IRR"/)
        }
    })

    it("rejects an unknown provider mode", () => {
        expect(() => resolveBillingConfig(validEnv({ [BILLING_ENV.mode]: "live" }))).toThrow(
            /BILLING_ZARINPAL_MODE must be "sandbox" or "production"/,
        )
    })

    it("rejects relative or non-http(s) URLs (base, callback and both result destinations)", () => {
        const cases: Array<[string, string]> = [
            [BILLING_ENV.baseUrl, "/pg/v4"],
            [BILLING_ENV.baseUrl, "ftp://sandbox.zarinpal.com"],
            [BILLING_ENV.callbackUrl, "not-a-url"],
            [BILLING_ENV.resultUrlSuccess, "javascript:alert(1)"],
            [BILLING_ENV.resultUrlFailure, "/relative-failure"],
        ]

        for (const [key, value] of cases) {
            // toThrow(string) = substring match؛ از escape کردن پرانتزها بی‌نیاز می‌کند
            expect(() => resolveBillingConfig(validEnv({ [key]: value }))).toThrow(
                `${key} must be an absolute http(s) URL`,
            )
        }
    })

    it("rejects an invalid configured provider timeout instead of silently defaulting", () => {
        for (const invalid of ["0", "-100", "soon"]) {
            expect(() =>
                resolveBillingConfig(validEnv({ [BILLING_ENV.providerTimeoutMs]: invalid })),
            ).toThrow(/BILLING_PROVIDER_TIMEOUT_MS must be a positive integer/)
        }
    })

    it("does not require the optional technical timeout key", () => {
        const env = validEnv()
        delete env[BILLING_ENV.providerTimeoutMs]

        expect(resolveBillingConfig(env).zarinpal.timeoutMs).toBe(12_000)
    })
})

// ── RB6: HTTPS enforcement in production mode ────────────────────────

describe("resolveBillingConfig — RB6: production HTTPS enforcement", () => {
    it("rejects http:// for BILLING_ZARINPAL_BASE_URL in production mode", () => {
        expect(() =>
            resolveBillingConfig(
                validEnv({
                    [BILLING_ENV.mode]: "production",
                    [BILLING_ENV.baseUrl]: "http://api.zarinpal.com/pg",
                }),
            ),
        ).toThrow(/must use HTTPS in production mode/)
    })

    it("rejects http:// for BILLING_ZARINPAL_CALLBACK_URL in production mode", () => {
        expect(() =>
            resolveBillingConfig(
                validEnv({
                    [BILLING_ENV.mode]: "production",
                    [BILLING_ENV.callbackUrl]: "http://app.example.com/callback",
                }),
            ),
        ).toThrow(/must use HTTPS in production mode/)
    })

    it("rejects http:// for BILLING_RESULT_URL_SUCCESS in production mode", () => {
        expect(() =>
            resolveBillingConfig(
                validEnv({
                    [BILLING_ENV.mode]: "production",
                    [BILLING_ENV.resultUrlSuccess]: "http://app.example.com/success",
                }),
            ),
        ).toThrow(/must use HTTPS in production mode/)
    })

    it("rejects http:// for BILLING_RESULT_URL_FAILURE in production mode", () => {
        expect(() =>
            resolveBillingConfig(
                validEnv({
                    [BILLING_ENV.mode]: "production",
                    [BILLING_ENV.resultUrlFailure]: "http://app.example.com/failure",
                }),
            ),
        ).toThrow(/must use HTTPS in production mode/)
    })

    it("accepts http:// for BILLING_ZARINPAL_BASE_URL in sandbox mode (development flexibility)", () => {
        expect(() =>
            resolveBillingConfig(
                validEnv({
                    [BILLING_ENV.mode]: "sandbox",
                    [BILLING_ENV.baseUrl]: "http://sandbox.zarinpal.com/pg",
                }),
            ),
        ).not.toThrow()
    })

    it("accepts https:// for all URLs in production mode", () => {
        expect(() =>
            resolveBillingConfig(
                validEnv({
                    [BILLING_ENV.mode]: "production",
                    [BILLING_ENV.baseUrl]: "https://api.zarinpal.com/pg",
                    [BILLING_ENV.callbackUrl]: "https://app.example.com/callback",
                    [BILLING_ENV.resultUrlSuccess]: "https://app.example.com/success",
                    [BILLING_ENV.resultUrlFailure]: "https://app.example.com/failure",
                }),
            ),
        ).not.toThrow()
    })
})
