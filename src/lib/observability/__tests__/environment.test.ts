// فاز ۲ — F4: تست‌های منبع محیط ErrorLog.environment (سند فاز ۲ §8)
//
// الزام سند: «environment — optional — sourced from deployment/config — never hard-coded».
// این تست‌ها ثابت می‌کنند:
//   1) مقدار همیشه از config (env) خوانده می‌شود؛
//   2) هیچ مقدار ثابت production/development/staging در ماژول وجود ندارد؛
//   3) در نبود config، مقدار null برمی‌گردد (ستون nullable — همان رفتار قبلی).

import { describe, expect, it } from "vitest"

import { ENVIRONMENT_ENV_KEYS, resolveEnvironment } from "../environment"

describe("resolveEnvironment — config-sourced only (§8 / F4)", () => {
    it("reads the value from configuration", () => {
        expect(resolveEnvironment({ APP_ENV: "staging" })).toBe("staging")
        expect(resolveEnvironment({ NODE_ENV: "production" })).toBe("production")
    })

    it("honours the documented precedence order (explicit keys win over NODE_ENV)", () => {
        expect(
            resolveEnvironment({
                APP_ENV: "production-eu",
                DEPLOYMENT_ENV: "deployment",
                ENVIRONMENT: "environment",
                NODE_ENV: "development",
            }),
        ).toBe("production-eu")

        expect(
            resolveEnvironment({ DEPLOYMENT_ENV: "deployment", ENVIRONMENT: "environment" }),
        ).toBe("deployment")

        expect(resolveEnvironment({ ENVIRONMENT: "environment", NODE_ENV: "test" })).toBe(
            "environment",
        )
    })

    it("ignores empty/whitespace-only values instead of returning them", () => {
        expect(resolveEnvironment({ APP_ENV: "   ", DEPLOYMENT_ENV: "canary" })).toBe("canary")
        expect(resolveEnvironment({ APP_ENV: "" })).toBeNull()
    })

    it("returns null when configuration genuinely provides nothing (nullable column preserved)", () => {
        expect(resolveEnvironment({})).toBeNull()
        expect(resolveEnvironment({ UNRELATED: "x" })).toBeNull()
    })

    it("never hard-codes an environment literal — an unknown env source yields null", () => {
        // اگر ماژول مقداری ثابت داشت، این فراخوانی هرگز null نمی‌داد.
        expect(resolveEnvironment({})).toBeNull()
        expect(ENVIRONMENT_ENV_KEYS).not.toHaveLength(0)
        for (const key of ENVIRONMENT_ENV_KEYS) {
            expect(typeof key).toBe("string")
        }
    })
})
