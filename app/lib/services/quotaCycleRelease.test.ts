// قرارداد محصول — آزادسازی سهمیه **دوره‌به‌دوره**.
//
// اشتراک چندماهه یعنی چند دورهٔ ۳۰روزهٔ *مستقل*، نه یک استخر بزرگ که از روز اول
// کامل قابل مصرف باشد. این فایل دقیقاً همین را قفل می‌کند و مهم‌ترین تست‌هایش آن‌هایی
// هستند که **باید قرمز شوند** اگر کسی روزی ظرفیت را از کل `entitlementDays` حساب کند.

import { describe, expect, it } from "vitest"

import { readQuotaBuckets, reserveBucketQuota } from "./aiQuotaV2.service"
import { QuotaExceededError } from "./errors"
import { activate, renew } from "./entitlement.service"
import { MS_PER_DAY, quotaWindowFor, resolveQuotaWindowFor } from "./quotaWindow"

const DAY = MS_PER_DAY
const USER = 7
const ANCHOR = new Date("2026-10-01T00:00:00.000Z")

const POLICY: Record<string, number> = {
    "PRO:ANALYZE": 270,
    "PRO:PLAN": 50,
    "FREE:ANALYZE": 15,
    "FREE:PLAN": 2,
}

function makeEnv() {
    const buckets = new Map<string, any>()
    const events = new Map<string, any>()
    let nextId = 1
    let entitlement: any = null
    const key = (w: any) =>
        `${w.userId}|${w.feature}|${w.source}|${w.periodType}|${w.periodStart.toISOString()}`

    const client: any = {
        entitlement: {
            findUnique: async () => entitlement,
            create: async ({ data }: any) => {
                entitlement = { id: "e1", userId: USER, ...data }
                return entitlement
            },
            updateMany: async ({ data }: any) => {
                entitlement = { ...entitlement, ...data }
                return { count: 1 }
            },
        },
        user: {
            updateMany: async () => ({ count: 1 }),
            findUnique: async () => ({
                id: USER,
                timezone: "Asia/Tehran",
                quotaAnchorAt: ANCHOR,
            }),
        },
        aiQuotaPolicy: {
            findUnique: async ({ where }: any) => ({
                allowedUnits:
                    POLICY[`${where.plan_feature.plan}:${where.plan_feature.feature}`] ?? 0,
            }),
        },
        aiUsageEvent: {
            findUnique: async ({ where }: any) => {
                const e = events.get(where.requestId)
                return e ? { status: e.status } : null
            },
            create: async ({ data }: any) => {
                if (events.has(data.requestId)) {
                    const err: any = new Error("unique")
                    err.code = "P2002"
                    throw err
                }
                const row = { id: nextId++, status: "RESERVED", bucketId: null, ...data }
                events.set(data.requestId, row)
                return row
            },
            updateMany: async ({ where, data }: any) => {
                let c = 0
                for (const [id, e] of events) {
                    if (where.requestId !== undefined && id !== where.requestId) continue
                    Object.assign(e, data)
                    c++
                }
                return { count: c }
            },
        },
        aiQuotaBucket: {
            findUnique: async ({ where }: any) => {
                for (const r of buckets.values())
                    if (key(where.userId_feature_source_periodType_periodStart) === key(r))
                        return { ...r }
                return null
            },
            create: async ({ data }: any) => {
                const k = key(data)
                for (const r of buckets.values()) {
                    if (key(r) === k) {
                        const err: any = new Error("unique")
                        err.code = "P2002"
                        throw err
                    }
                }
                const row = { id: nextId++, reservedUnits: 0, consumedUnits: 0, ...data }
                buckets.set(k, row)
                return { ...row }
            },
            updateMany: async ({ where, data }: any) => {
                for (const r of buckets.values()) {
                    if (r.id !== where.id) continue
                    if (where.capacityUnits === null && r.capacityUnits !== null) continue
                    if (
                        typeof where.reservedUnits === "number" &&
                        where.reservedUnits !== r.reservedUnits
                    )
                        continue
                    if (
                        typeof where.consumedUnits === "number" &&
                        where.consumedUnits !== r.consumedUnits
                    )
                        continue
                    if (data.reservedUnits?.increment) r.reservedUnits += data.reservedUnits.increment
                    if (data.reservedUnits?.decrement) r.reservedUnits -= data.reservedUnits.decrement
                    if (data.capacityUnits !== undefined) r.capacityUnits = data.capacityUnits
                    return { count: 1 }
                }
                return { count: 0 }
            },
        },
        $transaction: async (fn: (tx: any) => Promise<any>) => fn(client),
    }

    return {
        client,
        baseRows: () => [...buckets.values()].filter((r) => r.source === "BASE"),
        setEntitlement: (e: any) => {
            entitlement = e
        },
    }
}

type Env = ReturnType<typeof makeEnv>
let seq = 0

/** تا سقف دوره مصرف می‌کند؛ تعداد موفق را برمی‌گرداند. */
async function burn(
    env: Env,
    feature: "ANALYZE" | "PLAN",
    want: number,
    now: Date,
): Promise<number> {
    let ok = 0
    for (let i = 0; i < want; i++) {
        try {
            await reserveBucketQuota(env.client, {
                userId: USER,
                requestId: `q-${++seq}`,
                feature,
                units: 1,
                plan: "PRO",
                timezone: "Asia/Tehran",
                now,
            } as any)
            ok++
        } catch (e) {
            if (e instanceof QuotaExceededError) break
            throw e
        }
    }
    return ok
}

async function remaining(env: Env, now: Date) {
    const views = await readQuotaBuckets(env.client, {
        userId: USER,
        plan: "PRO",
        timezone: "Asia/Tehran",
        now,
    })
    const pick = (f: string) =>
        views.find((v) => v.feature === f && v.source === "BASE")!.remaining
    const cap = (f: string) =>
        views.filter((v) => v.feature === f).reduce((a, v) => a + v.capacity, 0)
    return { analyze: pick("ANALYZE"), plan: pick("PLAN"), analyzeCap: cap("ANALYZE"), planCap: cap("PLAN") }
}

const subscription = (days: number) => ({
    userId: USER,
    status: "ACTIVE",
    currentPeriodStart: ANCHOR,
    currentPeriodEnd: new Date(ANCHOR.getTime() + days * DAY),
})

// ────────────────────────────────────────────────────────────────────────────
describe("پنجرهٔ دوره با anchor = ۲۰۲۶-۱۰-۰۱", () => {
    const win = (day: number) => quotaWindowFor({ now: new Date(ANCHOR.getTime() + day * DAY), entitlement: subscription(90) })

    it("سه دورهٔ ۳۰ روزهٔ پیوسته می‌سازد", () => {
        expect(win(0).periodStart.toISOString()).toBe("2026-10-01T00:00:00.000Z")
        expect(win(0).periodEnd.toISOString()).toBe("2026-10-31T00:00:00.000Z")
        expect(win(30).periodStart.toISOString()).toBe("2026-10-31T00:00:00.000Z")
        expect(win(30).periodEnd.toISOString()).toBe("2026-11-30T00:00:00.000Z")
        expect(win(60).periodStart.toISOString()).toBe("2026-11-30T00:00:00.000Z")
        expect(win(60).periodEnd.toISOString()).toBe("2026-12-30T00:00:00.000Z")
    })

    it("روز ۲۹ هنوز دورهٔ صفر و روز ۳۰ دقیقاً دورهٔ یک است", () => {
        expect(win(0).periodIndex).toBe(0)
        expect(win(29).periodIndex).toBe(0)
        expect(win(30).periodIndex).toBe(1)
        expect(win(60).periodIndex).toBe(2)
        expect(win(89).periodIndex).toBe(2)
    })
})

// ────────────────────────────────────────────────────────────────────────────
// ⛔ تست‌های ضدباگ — اگر ظرفیت از کل entitlementDays حساب شود، این‌ها قرمز می‌شوند
// ────────────────────────────────────────────────────────────────────────────
describe("قرارداد: کل entitlement نباید در cycle 0 دیده شود", () => {
    it("90-day entitlement must not expose the full 810/150 quota in cycle 0", async () => {
        const env = makeEnv()
        env.setEntitlement(subscription(90))

        const r = await remaining(env, ANCHOR)

        expect(r.analyze).toBe(270)
        expect(r.plan).toBe(50)
        // حتی مجموع ظرفیتِ گزارش‌شده هم یک دوره است، نه سه.
        expect(r.analyzeCap).toBe(270)
        expect(r.planCap).toBe(50)
    })

    it("60-day entitlement must not expose 540/100 in cycle 0", async () => {
        const env = makeEnv()
        env.setEntitlement(subscription(60))

        const r = await remaining(env, ANCHOR)

        expect(r.analyze).toBe(270)
        expect(r.plan).toBe(50)
        expect(r.analyzeCap).toBe(270)
        expect(r.planCap).toBe(50)
    })

    it("30-day entitlement is a single cycle of exactly 270/50", async () => {
        const env = makeEnv()
        env.setEntitlement(subscription(30))

        const r = await remaining(env, ANCHOR)

        expect(r).toMatchObject({ analyze: 270, plan: 50, analyzeCap: 270, planCap: 50 })
    })
})

// ────────────────────────────────────────────────────────────────────────────
describe("چرخهٔ کامل ۹۰ روزه", () => {
    it("مصرف کامل cycle 0 ⇒ صفر تا پایان آن، و ۲۷۰/۵۰ در هر cycle بعد", async () => {
        const env = makeEnv()
        env.setEntitlement(subscription(90))

        // مصرف بیش از سقف ⇒ فقط سقف همان دوره مصرف می‌شود
        expect(await burn(env, "ANALYZE", 400, ANCHOR)).toBe(270)
        expect(await burn(env, "PLAN", 400, ANCHOR)).toBe(50)

        expect(await remaining(env, ANCHOR)).toMatchObject({ analyze: 0, plan: 0 })

        // یک روز بعد: هنوز صفر — هیچ چیز زودتر از موعد آزاد نمی‌شود
        expect(await remaining(env, new Date(ANCHOR.getTime() + 1 * DAY))).toMatchObject({
            analyze: 0,
            plan: 0,
        })
        expect(await remaining(env, new Date(ANCHOR.getTime() + 29 * DAY))).toMatchObject({
            analyze: 0,
            plan: 0,
        })

        // شروع cycle ۲
        expect(
            await remaining(env, new Date(ANCHOR.getTime() + 30 * DAY)),
        ).toMatchObject({ analyze: 270, plan: 50 })

        // شروع cycle ۳ — باز هم فقط یک دوره، نه ۸۱۰
        expect(
            await remaining(env, new Date(ANCHOR.getTime() + 60 * DAY)),
        ).toMatchObject({ analyze: 270, plan: 50, analyzeCap: 270, planCap: 50 })
    })

    it("bucketهای دوره‌های آینده از پیش ساخته نمی‌شوند (lazy)", async () => {
        const env = makeEnv()
        env.setEntitlement(subscription(90))

        // خواندن quota هیچ bucketی نمی‌سازد
        await remaining(env, ANCHOR)
        expect(env.baseRows()).toHaveLength(0)

        await burn(env, "ANALYZE", 1, ANCHOR)
        const rows = env.baseRows()
        expect(rows).toHaveLength(1)
        expect(rows[0].capacityUnits).toBe(270)
        expect(rows[0].periodStart.getTime()).toBe(ANCHOR.getTime())
    })

    it("ensureBucket فقط periodStart جاری را می‌سازد و entitlementDays نمی‌خواند", async () => {
        const env = makeEnv()
        env.setEntitlement(subscription(90))

        await burn(env, "PLAN", 1, ANCHOR)

        const row = env.baseRows()[0]
        expect(row.capacityUnits).toBe(50) // نه ۱۵۰
        expect(row.periodStart.getTime()).toBe(ANCHOR.getTime())
    })
})

// ────────────────────────────────────────────────────────────────────────────
describe("extension: ۳۰ روزه + خرید ۶۰ روزه پیش از expiry", () => {
    it("anchor حفظ، end تمدید، و ظرفیت cycle جاری ناگهان بزرگ نمی‌شود", async () => {
        const env = makeEnv()
        env.setEntitlement(null)
        await activate(
            env.client as never,
            { userId: USER, provider: "ZARINPAL", entitlementDays: 30 },
            ANCHOR,
        )
        expect((await remaining(env, ANCHOR)).analyze).toBe(270)

        const day20 = new Date(ANCHOR.getTime() + 20 * DAY)
        const extended = await renew(
            env.client as never,
            { userId: USER, provider: "ZARINPAL", entitlementDays: 60 },
            day20,
        )

        expect(extended.currentPeriodStart.getTime()).toBe(ANCHOR.getTime())
        expect(extended.currentPeriodEnd.getTime()).toBe(ANCHOR.getTime() + 90 * DAY)

        // ظرفیت cycle جاری همان ۲۷۰ است، نه ۸۱۰ و نه ۵۴۰
        const after = await remaining(env, day20)
        expect(after.analyze).toBe(270)
        expect(after.analyzeCap).toBe(270)
    })

    it("سهمیهٔ مصرف‌نشدهٔ cycle جاری rollover نمی‌شود", async () => {
        const env = makeEnv()
        env.setEntitlement(null)
        await activate(
            env.client as never,
            { userId: USER, provider: "ZARINPAL", entitlementDays: 30 },
            ANCHOR,
        )
        // فقط ۱۰ واحد از ۲۷۰ مصرف شده
        expect(await burn(env, "ANALYZE", 10, ANCHOR)).toBe(10)

        const day20 = new Date(ANCHOR.getTime() + 20 * DAY)
        await renew(
            env.client as never,
            { userId: USER, provider: "ZARINPAL", entitlementDays: 60 },
            day20,
        )
        // ۲۶۰ تای باقی‌مانده سرِ جایش است، نه ذخیره‌شده برای دورهٔ بعد
        expect((await remaining(env, day20)).analyze).toBe(260)

        // cycle ۲ دقیقاً ۲۷۰ تازه دارد (نه ۲۶۰ ذخیره + ۲۷۰، نه ۵۳۰)
        expect(
            await remaining(env, new Date(ANCHOR.getTime() + 30 * DAY)),
        ).toMatchObject({ analyze: 270, analyzeCap: 270 })
    })
})

// ────────────────────────────────────────────────────────────────────────────
describe("race در ابتدای یک cycle", () => {
    it("درخواست‌های هم‌زمان فقط یک bucket با ظرفیت یک دوره می‌سازند", async () => {
        const env = makeEnv()
        env.setEntitlement(subscription(90))
        const boundary = new Date(ANCHOR.getTime() + 30 * DAY)

        await Promise.all(
            Array.from({ length: 30 }, () =>
                reserveBucketQuota(env.client, {
                    userId: USER,
                    requestId: `race-${++seq}`,
                    feature: "ANALYZE",
                    units: 1,
                    plan: "PRO",
                    timezone: "Asia/Tehran",
                    now: boundary,
                } as any).catch(() => undefined),
            ),
        )

        const rows = env.baseRows()
        expect(rows).toHaveLength(1)
        expect(rows[0].capacityUnits).toBe(270)
        expect(rows[0].periodStart.getTime()).toBe(boundary.getTime())
    })

    it("هم‌زمانی در دو بُعد، دو bucket مستقل با ظرفیت درست می‌سازد", async () => {
        const env = makeEnv()
        env.setEntitlement(subscription(90))

        await Promise.all([
            reserveBucketQuota(env.client, {
                userId: USER, requestId: `a-${++seq}`, feature: "ANALYZE", units: 1,
                plan: "PRO", timezone: "Asia/Tehran", now: ANCHOR,
            } as any).catch(() => undefined),
            reserveBucketQuota(env.client, {
                userId: USER, requestId: `b-${++seq}`, feature: "PLAN", units: 1,
                plan: "PRO", timezone: "Asia/Tehran", now: ANCHOR,
            } as any).catch(() => undefined),
        ])

const caps = env.baseRows().map((r) => r.capacityUnits).sort((a, b) => a - b)
expect(caps).toEqual([50, 270])
    })
})

// ────────────────────────────────────────────────────────────────────────────
describe("resolver واقعی", () => {
    it("لنگر را از entitlement می‌گیرد و همان دوره را برمی‌گرداند", async () => {
        const env = makeEnv()
        env.setEntitlement(subscription(90))

        const w = await resolveQuotaWindowFor(env.client, {
            userId: USER,
            now: new Date(ANCHOR.getTime() + 45 * DAY),
            timezone: "Asia/Tehran",
        })

        expect(w.anchorKind).toBe("ENTITLEMENT")
        expect(w.anchor.toISOString()).toBe("2026-10-01T00:00:00.000Z")
        expect(w.periodIndex).toBe(1)
        expect(w.periodStart.toISOString()).toBe("2026-10-31T00:00:00.000Z")
    })
})