import { describe, expect, it } from "vitest"

import {
    auditActionLabel,
    buildAuditLogsPageVM,
    buildAuditQueryString,
    formatAuditSnapshot,
    hasPromoQuota,
    maxRedemptionsLabel,
    orderQuotaPolicies,
    promoStatusLabel,
    resolvePromoStatus,
} from "./adminViewModels"

const NOW = new Date("2026-09-15T00:00:00.000Z")

describe("resolvePromoStatus — display-only state", () => {
    const base = { isActive: true, validFrom: "2026-09-01T00:00:00.000Z", expiresAt: "2026-10-01T00:00:00.000Z" }

    it("inactive wins over the time window", () => {
        expect(resolvePromoStatus({ ...base, isActive: false }, NOW)).toBe("inactive")
    })
    it("active inside the window", () => {
        expect(resolvePromoStatus(base, NOW)).toBe("active")
    })
    it("expired after the window", () => {
        expect(resolvePromoStatus({ ...base, expiresAt: "2026-09-10T00:00:00.000Z" }, NOW)).toBe("expired")
    })
    it("upcoming before validFrom", () => {
        expect(resolvePromoStatus({ ...base, validFrom: "2026-09-20T00:00:00.000Z" }, NOW)).toBe("upcoming")
    })
    it("labels", () => {
        expect(promoStatusLabel("active")).toBe("فعال")
        expect(promoStatusLabel("inactive")).toBe("غیرفعال")
        expect(promoStatusLabel("expired")).toBe("منقضی")
        expect(promoStatusLabel("upcoming")).toBe("آینده")
    })
})

describe("orderQuotaPolicies — stable FREE/PRO × ANALYZE/PLAN", () => {
    it("orders deterministically regardless of input order", () => {
        const rows = [
            { plan: "PRO" as const, feature: "PLAN" as const, allowedUnits: 50 },
            { plan: "FREE" as const, feature: "ANALYZE" as const, allowedUnits: 15 },
            { plan: "PRO" as const, feature: "ANALYZE" as const, allowedUnits: 270 },
            { plan: "FREE" as const, feature: "PLAN" as const, allowedUnits: 2 },
        ]
        expect(orderQuotaPolicies(rows).map((r) => `${r.plan}:${r.feature}`)).toEqual([
            "FREE:ANALYZE",
            "FREE:PLAN",
            "PRO:ANALYZE",
            "PRO:PLAN",
        ])
    })
})

describe("maxRedemptionsLabel / hasPromoQuota", () => {
    it("shows a neutral label for null cap", () => {
        expect(maxRedemptionsLabel(null)).toBe("بدون سقف")
        expect(maxRedemptionsLabel(10)).toBe("۱۰")
    })
    it("detects the absence of a promo bucket", () => {
        expect(hasPromoQuota({ capacity: 0, reserved: 0, consumed: 0, remaining: 0 })).toBe(false)
        expect(hasPromoQuota({ capacity: 5, reserved: 0, consumed: 0, remaining: 5 })).toBe(true)
    })
})

describe("buildAuditQueryString — allowlist", () => {
    it("serializes only provided filters and clamps limit", () => {
        const q = buildAuditQueryString({
            action: "promo.created",
            targetType: "",
            targetId: "pc1",
            actorUserId: "7",
            page: 2,
            limit: 5000,
        })
        const sp = new URLSearchParams(q)
        expect(sp.get("action")).toBe("promo.created")
        expect(sp.get("targetType")).toBeNull()
        expect(sp.get("targetId")).toBe("pc1")
        expect(sp.get("actorUserId")).toBe("7")
        expect(sp.get("page")).toBe("2")
        expect(sp.get("limit")).toBe("100")
    })
})

describe("buildAuditLogsPageVM", () => {
    it("returns empty status for null data with no error", () => {
        const vm = buildAuditLogsPageVM(null, false, null)
        expect(vm.status).toBe("empty")
    })
    it("computes totals/hasMore", () => {
        const vm = buildAuditLogsPageVM({ items: [], page: 1, limit: 20, total: 21, hasMore: true }, false, null)
        expect(vm.status).toBe("empty")
        expect(vm.total).toBe(21)
        expect(vm.hasNext).toBe(true)
    })
})

describe("formatAuditSnapshot / auditActionLabel", () => {
    it("renders a text summary, never raw JSON", () => {
        expect(formatAuditSnapshot({ allowedUnits: 5 })).toBe("allowedUnits: 5")
        expect(formatAuditSnapshot({ allowedUnits: 5, isActive: true })).toBe("allowedUnits: 5 · isActive: true")
        expect(formatAuditSnapshot(null)).toBe("—")
    })
    it("labels known actions and passes unknown ones through", () => {
        expect(auditActionLabel("quota_policy.updated")).toBe("تغییر سقف سهمیه")
        expect(auditActionLabel("promo.redeem_rejected")).toBe("رد ریدیمپشن کد هدیه")
        expect(auditActionLabel("something.else")).toBe("something.else")
    })
})
