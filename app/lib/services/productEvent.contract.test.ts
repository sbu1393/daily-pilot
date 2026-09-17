// فاز ۳ — گام ۳: تست‌های قرارداد ProductEvent (Taxonomy + Validation pure)
// پوشش: هر رویداد معتبر (۱۱ فاز ۳ + ۲ billing فاز ۵ گام ۱۵)، event ناشناخته،
// property ناشناخته، سقف‌های قرارداد، deterministic output، عدم throw، عدم عبور داده حساس.

import { describe, expect, it } from "vitest"

import {
    getAllowedProperties,
    isPlainObject,
    PRODUCT_EVENT_LIMITS,
    PRODUCT_EVENT_NAMES,
    validateProductEvent,
} from "./productEvent.contract"

// ---------------------------------------------------------------------------
// 1) Taxonomy — ۱۳ رویداد (۱۱ فاز ۳ + ۲ billing فاز ۵)
// ---------------------------------------------------------------------------

describe("taxonomy", () => {
    it("defines exactly the blueprint events (11 + 2 billing)", () => {
        expect([...PRODUCT_EVENT_NAMES]).toEqual([
            "auth.login_succeeded",
            "task.created",
            "task.updated",
            "task.completed",
            "task.deleted",
            "task.rolled_over",
            "ai.analysis_succeeded",
            "planner.day_viewed",
            "planner.suggestion_viewed",
            "planner.history_viewed",
            "profile.updated",
            "billing.entitlement_activated",
            "billing.entitlement_renewed",
        ])
    })

    it("validates all 13 valid events with their allowlists", () => {
        const cases: Array<[string, Record<string, unknown>]> = [
            ["auth.login_succeeded", {}],
            ["task.created", { taskId: "t1", category: "work", status: "todo" }],
            ["task.updated", { taskId: "t1", changedFields: ["title"] }],
            ["task.completed", { taskId: "t1", category: "work", status: "done" }],
            ["task.deleted", { taskId: "t1" }],
            ["task.rolled_over", { taskId: "t1", toDayKey: "2026-09-17" }],
            ["ai.analysis_succeeded", { units: 1, aiSource: "1xai", status: "ok" }],
            ["planner.day_viewed", {}],
            ["planner.suggestion_viewed", {}],
            ["planner.history_viewed", {}],
            ["profile.updated", { changedFields: ["name"] }],
            ["billing.entitlement_activated", { provider: "ZARINPAL", entitlementDays: 30 }],
            [
                "billing.entitlement_renewed",
                { provider: "ZARINPAL", entitlementDays: 30, renewalType: "EXTENDS_CURRENT" },
            ],
        ]
        for (const [name, props] of cases) {
            const result = validateProductEvent(name, props)
            expect(result.valid, `${name} should be valid`).toBe(true)
            if (result.valid) {
                expect(result.eventName).toBe(name)
                expect(result.properties).toEqual(props)
            }
        }
    })

    it("rejects unknown event names", () => {
        for (const bad of [
            "auth.logout",
            "task.created.extra",
            "TASK.CREATED",
            "",
            "task.created ",
        ]) {
            const result = validateProductEvent(bad, {})
            expect(result.valid).toBe(false)
            if (!result.valid) expect(result.reason).toBe("unknown_event")
        }
    })

    it("rejects non-string event names", () => {
        for (const bad of [123, null, undefined, {}, [], true]) {
            const result = validateProductEvent(bad, {})
            expect(result.valid).toBe(false)
            if (!result.valid) expect(result.reason).toBe("unknown_event")
        }
    })
})

// ---------------------------------------------------------------------------
// 1b) فاز ۵ — گام ۱۵: allowlist رویدادهای billing (سند §۲۳)
// ---------------------------------------------------------------------------

describe("billing events allowlist (§23)", () => {
    it("allows only provider + duration for first activation", () => {
        expect(getAllowedProperties("billing.entitlement_activated")).toEqual([
            "provider",
            "entitlementDays",
        ])
        expect(
            validateProductEvent("billing.entitlement_activated", {
                provider: "ZARINPAL",
                entitlementDays: 30,
            }).valid,
        ).toBe(true)
    })

    it("allows the renewal type only on the renewal event", () => {
        expect(getAllowedProperties("billing.entitlement_renewed")).toEqual([
            "provider",
            "entitlementDays",
            "renewalType",
        ])
        expect(
            validateProductEvent("billing.entitlement_renewed", {
                provider: "ZARINPAL",
                entitlementDays: 30,
                renewalType: "EXTENDS_CURRENT",
            }).valid,
        ).toBe(true)
        // renewalType روی رویداد فعال‌سازی مجاز نیست (allowlist هر رویداد مستقل است)
        expect(
            validateProductEvent("billing.entitlement_activated", {
                provider: "ZARINPAL",
                entitlementDays: 30,
                renewalType: "EXTENDS_CURRENT",
            }).valid,
        ).toBe(false)
    })

    it("rejects payment identifiers and provider secrets (§23 never-include list)", () => {
        const forbidden: Array<Record<string, unknown>> = [
            { authority: "A-123" },
            { providerAuthority: "A-123" },
            { providerReference: "R-1" },
            { merchantOrderId: "mo-1" },
            { merchantId: "merchant-secret" },
            { amount: 100000 },
            { cardNumber: "603799" },
            { rawResponse: { ok: true } },
            { error: "provider timeout" },
        ]
        for (const props of forbidden) {
            for (const event of ["billing.entitlement_activated", "billing.entitlement_renewed"] as const) {
                const result = validateProductEvent(event, props)
                expect(result.valid, `${event} must reject ${Object.keys(props)[0]}`).toBe(false)
            }
        }
    })

    it("does not add any other billing event name to the taxonomy", () => {
        const billing = PRODUCT_EVENT_NAMES.filter((name) => name.startsWith("billing."))
        expect([...billing]).toEqual(["billing.entitlement_activated", "billing.entitlement_renewed"])
    })
})

// ---------------------------------------------------------------------------
// 2) Allowlist — هیچ serialization دلخواه
// ---------------------------------------------------------------------------

describe("allowlist enforcement", () => {
    it("rejects unknown property on event with allowlist", () => {
        const result = validateProductEvent("task.created", { taskId: "t1", title: "secret content" })
        expect(result.valid).toBe(false)
        if (!result.valid) expect(result.reason).toBe("unknown_property")
    })

    it("rejects any property on empty-allowlist events", () => {
        const emptyAllowlistEvents = [
            "auth.login_succeeded",
            "planner.day_viewed",
            "planner.suggestion_viewed",
            "planner.history_viewed",
        ] as const
        for (const name of emptyAllowlistEvents) {
            const result = validateProductEvent(name, { anything: 1 })
            expect(result.valid).toBe(false)
            if (!result.valid) expect(result.reason).toBe("unknown_property")
        }
    })

    it("exposes per-event allowlists for documentation/tests", () => {
        expect(getAllowedProperties("task.created")).toEqual(["taskId", "category", "status"])
        expect(getAllowedProperties("task.deleted")).toEqual(["taskId"])
        expect(getAllowedProperties("profile.updated")).toEqual(["changedFields"])
        expect(getAllowedProperties("auth.login_succeeded")).toEqual([])
    })

    it("treats undefined/null properties as empty", () => {
        for (const props of [undefined, null]) {
            const result = validateProductEvent("planner.day_viewed", props)
            expect(result.valid).toBe(true)
            if (result.valid) expect(result.properties).toEqual({})
        }
    })

    it("rejects non-object properties", () => {
        for (const props of ["str", 5, true, [], new Date(), new Map()]) {
            const result = validateProductEvent("task.deleted", props)
            expect(result.valid).toBe(false)
            if (!result.valid) expect(result.reason).toBe("properties_not_object")
        }
    })

    it("isPlainObject distinguishes plain objects from wrappers/arrays", () => {
        expect(isPlainObject({})).toBe(true)
        expect(isPlainObject({ a: 1 })).toBe(true)
        expect(isPlainObject([])).toBe(false)
        expect(isPlainObject(new Date())).toBe(false)
        expect(isPlainObject(new Map())).toBe(false)
        expect(isPlainObject(null)).toBe(false)
        expect(isPlainObject("x")).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// 3) محدودیت‌ها — 20 props / 128 chars / depth 2 / 4KB
// ---------------------------------------------------------------------------

describe("limits", () => {
    it("has correct locked limits", () => {
        expect(PRODUCT_EVENT_LIMITS.maxProperties).toBe(20)
        expect(PRODUCT_EVENT_LIMITS.maxKeyLength).toBe(128)
        expect(PRODUCT_EVENT_LIMITS.maxDepth).toBe(2)
        expect(PRODUCT_EVENT_LIMITS.maxSerializedBytes).toBe(4 * 1024)
    })

    it("rejects key longer than 128 chars", () => {
        const longKey = "a".repeat(129)
        const result = validateProductEvent("task.created", { [longKey]: "x" })
        expect(result.valid).toBe(false)
        if (!result.valid) expect(result.reason).toBe("key_too_long")
    })

    it("checks key length before allowlist (deterministic ordering)", () => {
        // کلید ۱۲۹تایی حتی اگر allowlist هم نباشد → key_too_long (نه unknown_property)
        const longKey = "a".repeat(129)
        const result = validateProductEvent("task.created", { [longKey]: "x" })
        expect(result.valid).toBe(false)
        if (!result.valid) expect(result.reason).toBe("key_too_long")
    })

    it("rejects nested object value (depth 3)", () => {
        const result = validateProductEvent("task.created", {
            taskId: { nested: "deep" } as unknown as string,
        })
        expect(result.valid).toBe(false)
        if (!result.valid) expect(result.reason).toBe("depth_exceeded")
    })

    it("rejects object inside array value (depth 3)", () => {
        const result = validateProductEvent("task.updated", {
            taskId: "t1",
            changedFields: [{ bad: 1 } as unknown as string],
        })
        expect(result.valid).toBe(false)
        if (!result.valid) expect(result.reason).toBe("depth_exceeded")
    })

    it("rejects array inside array value (depth 3)", () => {
        const result = validateProductEvent("task.updated", {
            taskId: "t1",
            changedFields: [["nested"]],
        })
        expect(result.valid).toBe(false)
        if (!result.valid) expect(result.reason).toBe("depth_exceeded")
    })

    it("documents that the max-20 guard cannot be reached via allowlisted keys", () => {
        // بزرگ‌ترین allowlist در کل taxonomy ۳ کلید دارد؛ سقف ۲۰ تنها با کلیدهای
        // unknown قابل رسیدن است و unknown_property زودتر برمی‌گردد. رفتار مرزی
        // مستند است: guard سقف ۲۰ فعال است ولی از طریق allowlist قابل فعال‌شدن نیست.
        const allowed = getAllowedProperties("task.created")
        expect(allowed.length).toBeLessThan(PRODUCT_EVENT_LIMITS.maxProperties)
    })

    it("rejects payload larger than 4KB", () => {
        const big = "x".repeat(5000)
        const result = validateProductEvent("task.created", { taskId: big })
        expect(result.valid).toBe(false)
        if (!result.valid) expect(result.reason).toBe("payload_too_large")
    })

    it("accepts payload just under 4KB", () => {
        const big = "x".repeat(4000)
        const result = validateProductEvent("task.created", { taskId: big })
        // JSON.stringify({"taskId":"xxx…"}) ≈ 4011 bytes < 4096
        expect(result.valid).toBe(true)
        if (result.valid) {
            expect(result.properties.taskId).toBe(big)
        }
    })
})

// ---------------------------------------------------------------------------
// 4) Determinism و عدم throw
// ---------------------------------------------------------------------------

describe("determinism and safety", () => {
    it("produces identical output for identical input", () => {
        const a = validateProductEvent("task.created", { taskId: "t1", category: "work" })
        const b = validateProductEvent("task.created", { taskId: "t1", category: "work" })
        expect(a).toEqual(b)
        expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    })

    it("never throws for any hostile input", () => {
        const hostileNames: unknown[] = [
            undefined,
            null,
            123,
            "x",
            true,
            [],
            {},
            new Date(),
            new Map(),
            new Set(),
            Symbol("s"),
            () => {},
            NaN,
            Infinity,
            BigInt(1),
        ]
        for (const name of hostileNames) {
            expect(() => validateProductEvent(name, undefined)).not.toThrow()
            expect(() => validateProductEvent(name, { taskId: 1 })).not.toThrow()
            expect(() => validateProductEvent(name, null)).not.toThrow()
        }
        const hostileProps: unknown[] = [
            undefined,
            null,
            "str",
            5,
            true,
            [],
            [1, 2],
            new Date(),
            new Map(),
            new Set(),
            Symbol("s"),
            () => {},
        ]
        for (const props of hostileProps) {
            expect(() => validateProductEvent("task.created", props)).not.toThrow()
        }
        // circular reference
        const circular: Record<string, unknown> = {}
        circular.self = circular
        expect(() => validateProductEvent("task.created", circular)).not.toThrow()
        // getter انفجاری
        const evil: Record<string, unknown> = {}
        Object.defineProperty(evil, "taskId", {
            get() {
                throw new Error("boom")
            },
            enumerable: true,
        })
        expect(() => validateProductEvent("task.created", evil)).not.toThrow()
    })

    it("returns a safe invalid result for exploding getters", () => {
        const evil: Record<string, unknown> = {}
        Object.defineProperty(evil, "taskId", {
            get() {
                throw new Error("boom")
            },
            enumerable: true,
        })
        const result = validateProductEvent("task.created", evil)
        expect(result.valid).toBe(false)
        if (!result.valid) expect(result.reason).toBe("value_not_serializable")
    })

    it("rejects NaN/Infinity values instead of serializing them loosely", () => {
        const result = validateProductEvent("ai.analysis_succeeded", { units: NaN })
        expect(result.valid).toBe(false)
        if (!result.valid) expect(result.reason).toBe("value_not_serializable")
    })

    it("treats undefined value as null deterministically", () => {
        const result = validateProductEvent("task.created", { taskId: undefined })
        expect(result.valid).toBe(true)
        if (result.valid) expect(result.properties.taskId).toBeNull()
    })
})

// ---------------------------------------------------------------------------
// 5) امنیت — هیچ داده‌ی حساسی از allowlistها عبور نمی‌کند
// ---------------------------------------------------------------------------

describe("sensitive data protection", () => {
    it("never allows task content (title/description) into task.created", () => {
        for (const key of ["title", "description", "notes", "content", "prompt"]) {
            const result = validateProductEvent("task.created", { taskId: "t1", [key]: "sensitive" })
            expect(result.valid).toBe(false)
            if (!result.valid) expect(result.reason).toBe("unknown_property")
        }
    })

    it("never allows AI prompt/response/payload into ai.analysis_succeeded", () => {
        for (const key of ["prompt", "response", "payload", "raw", "providerPayload", "systemPrompt"]) {
            const result = validateProductEvent("ai.analysis_succeeded", { units: 1, [key]: "sensitive" })
            expect(result.valid).toBe(false)
            if (!result.valid) expect(result.reason).toBe("unknown_property")
        }
    })

    it("never allows value-carrying keys into profile.updated (only field names)", () => {
        const result = validateProductEvent("profile.updated", { changedFields: ["name"] })
        expect(result.valid).toBe(true) // نام فیلدِ تغییرکرده مجاز است — همان قرارداد
        for (const key of ["email", "phone", "value", "newValue", "oldValue"]) {
            const result = validateProductEvent("profile.updated", { [key]: "sensitive" })
            expect(result.valid).toBe(false)
            if (!result.valid) expect(result.reason).toBe("unknown_property")
        }
    })

    it("rejects unknown keys even when values are empty strings", () => {
        const result = validateProductEvent("task.deleted", { taskId: "", extra: "" })
        expect(result.valid).toBe(false)
        if (!result.valid) expect(result.reason).toBe("unknown_property")
    })
})
