import { describe, expect, it, vi } from "vitest"

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: () => ({}) }))

import {
    ADMIN_AUDIT_MAX_PAGE_SIZE,
    listAdminAuditLogs,
    sanitizeSnapshot,
    toAdminAuditLogView,
} from "./adminAudit.query"

const ROW = {
    id: "a1",
    actorUserId: 7,
    action: "quota_policy.updated",
    targetType: "ai_quota_policy",
    targetId: "FREE:ANALYZE",
    before: { allowedUnits: 15 },
    after: { allowedUnits: 5 },
    requestId: "req-1",
    createdAt: new Date("2026-09-20T00:00:00.000Z"),
}

function makeClient(rows: unknown[], total = rows.length) {
    return {
        adminAuditLog: {
            findMany: vi.fn().mockResolvedValue(rows),
            count: vi.fn().mockResolvedValue(total),
        },
        user: {
            findMany: vi.fn().mockResolvedValue([{ id: 7, username: "root" }]),
        },
    }
}

describe("sanitizeSnapshot — projection allowlist (redaction)", () => {
    it("keeps scalars and arrays of scalars", () => {
        expect(sanitizeSnapshot({ allowedUnits: 5, note: "x", flags: [1, 2, true] })).toEqual({
            allowedUnits: 5,
            note: "x",
            flags: [1, 2, true],
        })
    })

    it("drops nested objects entirely (no raw JSON leakage)", () => {
        expect(sanitizeSnapshot({ reason: "EXPIRED", nested: { secret: "x" } })).toEqual({
            reason: "EXPIRED",
        })
    })

    it("drops non-finite numbers and returns null for empty/array input", () => {
        expect(sanitizeSnapshot({ n: Number.NaN })).toBeNull()
        expect(sanitizeSnapshot([1, 2])).toBeNull()
        expect(sanitizeSnapshot(null)).toBeNull()
    })

    it("truncates over-long strings", () => {
        const long = "x".repeat(500)
        const out = sanitizeSnapshot({ s: long }) as { s: string }
        expect(out.s.length).toBe(200)
    })
})

describe("toAdminAuditLogView — shape guard", () => {
    it("maps a valid row and serializes createdAt", () => {
        const view = toAdminAuditLogView(ROW)
        expect(view).not.toBeNull()
        expect(view?.createdAt).toBe("2026-09-20T00:00:00.000Z")
        expect(view?.before).toEqual({ allowedUnits: 15 })
    })

    it("returns null for a row missing required fields", () => {
        expect(toAdminAuditLogView({ id: "x" })).toBeNull()
        expect(toAdminAuditLogView(null)).toBeNull()
    })
})

describe("listAdminAuditLogs — filters + pagination + actor names", () => {
    it("clamps pageSize to the hard cap (bounded)", async () => {
        const client = makeClient([ROW])
        const result = await listAdminAuditLogs(client, { pageSize: 5000 })
        expect(result.pageSize).toBe(ADMIN_AUDIT_MAX_PAGE_SIZE)
    })

    it("applies the default 7-day window when no targetId is given", async () => {
        const client = makeClient([])
        await listAdminAuditLogs(client, {})
        const where = client.adminAuditLog.findMany.mock.calls[0][0].where
        expect(where.createdAt.gte).toBeInstanceOf(Date)
    })

    it("opens the lower window bound when targetId is filtered (deep link)", async () => {
        const client = makeClient([])
        await listAdminAuditLogs(client, { targetType: "promo_code", targetId: "pc1" })
        const where = client.adminAuditLog.findMany.mock.calls[0][0].where
        expect(where.targetId).toBe("pc1")
        expect(where.createdAt.gte).toBeUndefined()
    })

    it("resolves actor usernames from a bounded user lookup", async () => {
        const client = makeClient([ROW])
        const result = await listAdminAuditLogs(client, {})
        expect(client.user.findMany).toHaveBeenCalledWith({
            where: { id: { in: [7] } },
            select: { id: true, username: true },
        })
        expect(result.items[0].actorUsername).toBe("root")
    })

    it("never returns unknown snapshot fields (nested object dropped)", async () => {
        const client = makeClient([{ ...ROW, after: { reason: "EXPIRED", leak: { a: 1 } } }])
        const result = await listAdminAuditLogs(client, {})
        expect(result.items[0].after).toEqual({ reason: "EXPIRED" })
    })
})
