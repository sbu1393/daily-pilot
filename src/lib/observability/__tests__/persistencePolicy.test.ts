// فاز ۲ — تست‌های Persistence Policy (سند فاز ۲ §6/§19 + تصمیم‌های implementation A1/A2)
//
// قرارداد: policy صریح و testable است؛ هرگز از HTTP status استنتاج نمی‌شود.
//   persist=true  : QUOTA_UNAVAILABLE، AI_PROVIDER_UNAVAILABLE، INTERNAL،
//                   و database infrastructure failures (Prisma P2002 طبق normalization contract)
//   persist=false : QUOTA_EXCEEDED، validation، authn/authz، not-found،
//                   و conflictهای انتظاری کاربر/بیزینس — از جمله CONFLICT عمومی (بدون prismaCode)
//
// رگرسیون A2: P2002 باید persist شود در حالی که یک conflict انتظاری همچنان ignore بماند.

import { describe, expect, it } from "vitest"

import { PERSISTENT_PRISMA_CODES, shouldPersistError } from "../persistencePolicy"

describe("shouldPersistError — persistent operational codes (A1)", () => {
    for (const code of ["QUOTA_UNAVAILABLE", "AI_PROVIDER_UNAVAILABLE", "INTERNAL"]) {
        it(`persists ${code}`, () => {
            expect(shouldPersistError(code)).toBe(true)
        })
    }

    it("persists unknown codes conservatively (operational visibility by default)", () => {
        expect(shouldPersistError("SOMETHING_NEW_AND_UNKNOWN")).toBe(true)
        expect(shouldPersistError("PAYMENT_STATE_UNRESOLVED")).toBe(true)
    })
})

describe("shouldPersistError — ignored expected errors (A1)", () => {
    const ignored = [
        "QUOTA_EXCEEDED",
        "VALIDATION_ERROR",
        "MISSING_DAY_KEY",
        "SAME_PASSWORD",
        "UNAUTHORIZED",
        "INVALID_CREDENTIALS",
        "WRONG_PASSWORD",
        "NOT_FOUND",
        "TASK_NOT_FOUND",
        "USER_NOT_FOUND",
        "NO_ROLLOVER_CANDIDATES",
        "CONFLICT",
        "EMAIL_TAKEN",
        "USERNAME_TAKEN",
        "IDEMPOTENCY_CONFLICT",
        "TASK_ALREADY_DONE",
        "TASK_NOT_ANALYZEABLE",
        "PAYMENT_NOT_FOUND",
        "PAYMENT_IDEMPOTENCY_CONFLICT",
    ]

    for (const code of ignored) {
        it(`ignores ${code}`, () => {
            expect(shouldPersistError(code)).toBe(false)
        })
    }
})

describe("shouldPersistError — Prisma infrastructure classification (A2 regression)", () => {
    it("classifies P2002 (unique violation) as persistent infrastructure", () => {
        expect(PERSISTENT_PRISMA_CODES.has("P2002")).toBe(true)
        expect(shouldPersistError("CONFLICT", { prismaCode: "P2002" })).toBe(true)
    })

    it("does NOT make the generic CONFLICT code persistent (expected application conflict stays ignored)", () => {
        expect(shouldPersistError("CONFLICT")).toBe(false)
        expect(shouldPersistError("CONFLICT", { prismaCode: null })).toBe(false)
        expect(shouldPersistError("CONFLICT", {})).toBe(false)
    })

    it("keeps P2025 (expected not-found) ignored although it is also a Prisma code", () => {
        expect(PERSISTENT_PRISMA_CODES.has("P2025")).toBe(false)
        expect(shouldPersistError("NOT_FOUND", { prismaCode: "P2025" })).toBe(false)
    })

    it("never consults HTTP status — the decision is a pure function of code + classification", () => {
        // امضای تابع تنها (errorCode, classification) است؛ هیچ status/response ورودی نیست.
        expect(shouldPersistError.length).toBeLessThanOrEqual(2)
        expect(shouldPersistError("INTERNAL", { prismaCode: "P2025" })).toBe(true)
    })
})
