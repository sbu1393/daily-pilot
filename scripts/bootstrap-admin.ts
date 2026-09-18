/**
 * فاز ۴ §۶ — ADMIN BOOTSTRAP: ارتقای **یک** کاربر موجود به نقش `ADMIN`.
 *
 * قرارداد سند (§۶):
 * - اولین Admin فقط از طریق یک **اسکریپت عملیاتی یک‌باره و خارج از Public API** ایجاد می‌شود.
 * - ورودی: `email دقیق` (یا immutable userId) از operator — نه الگو، نه جستجوی fuzzy، نه لیست.
 * - مراحل: یافتن user → role = ADMIN → **verify نتیجه** → log امن.
 * - ممنوع: mass-admin، هر نوشتن روی plan/quota/password/session، هر تغییر روی کاربران دیگر.
 * - privacy (§۲۱): ایمیل در لاگ **ماسک‌شده** است؛ هیچ secret/token/هش چاپ نمی‌شود.
 *
 * این اسکریپت idempotent است: اگر کاربر از قبل ADMIN باشد، هیچ نوشتنی انجام نمی‌شود.
 *
 * Run (DATABASE_URL باید در environment موجود باشد — همان کلید runtime اپ):
 *   npm run bootstrap:admin -- operator@example.com
 *   BOOTSTRAP_ADMIN_EMAIL=operator@example.com npm run bootstrap:admin
 *
 * اگر می‌خواهی فایل `.env` محلی هم خوانده شود (فقط محیط local):
 *   node --env-file=.env --experimental-strip-types --disable-warning=ExperimentalWarning scripts/bootstrap-admin.ts <email>
 *
 * نکته‌ی عمدی: هیچ import ای از لایه‌ی admin خواندنی (`admin.query.ts`) این‌جا نیست تا اسکریپت
 * مستقل از path-aliasهای اپ (`@/…`) بماند و فقط به `getPrisma` (کلاینت موجود پروژه) وابسته باشد؛
 * بنابراین `maskEmail` به‌صورت محلی و با همان قرارداد «۲ کاراکتر اول + *** + دامنه» تکرار شده است.
 */

import { pathToFileURL } from "node:url"

import { getPrisma } from "../app/lib/getPrisma.ts"

/** کلید environment برای زمانی که ایمیل به‌عنوان آرگومان CLI داده نمی‌شود. */
export const BOOTSTRAP_ADMIN_EMAIL_KEY = "BOOTSTRAP_ADMIN_EMAIL"

/** اعتبارسنجی حداقلی و قطعی ایمیل — بدون هیچ الگو/wildcard. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** ماسک امن ایمیل برای لاگ (§۲۱): ۲ کاراکتر اول local + *** + دامنه. Pure. */
export function maskEmailForLog(email: string): string {
    const at = email.indexOf("@")
    if (at <= 0) return "***"
    const local = email.slice(0, at)
    return `${local.slice(0, Math.min(2, local.length))}***${email.slice(at)}`
}

/**
 * resolveRequestedEmail — ایمیل درخواستی را از آرگومان CLI یا environment می‌خواند.
 * خروجی: ایمیل trim‌شده‌ی معتبر، یا `null` (ورودی نامعتبر/غایب). Pure و بدون I/O.
 */
export function resolveRequestedEmail(
    argv: readonly string[],
    environment: Record<string, string | undefined> = process.env,
): string | null {
    const fromArgv = typeof argv[2] === "string" ? argv[2] : ""
    const candidate = (fromArgv.trim() !== "" ? fromArgv : (environment[BOOTSTRAP_ADMIN_EMAIL_KEY] ?? "")).trim()
    return EMAIL_RE.test(candidate) ? candidate : null
}

export type BootstrapOutcome =
    | { kind: "promoted"; userId: number; email: string }
    | { kind: "already-admin"; userId: number; email: string }
    | { kind: "user-not-found" }
    | { kind: "verify-failed"; userId: number; email: string }

/** کلاینت حداقلی موردنیاز این اسکریپت (تزریق‌پذیر برای تست/بازبینی). */
export interface BootstrapAdminClient {
    user: {
        findUnique: (args: unknown) => Promise<unknown>
        updateMany: (args: unknown) => Promise<{ count: number }>
    }
}

/**
 * promoteToAdmin — ارتقای قطعی یک کاربر به ADMIN.
 *
 * - lookup با ایمیل **دقیق** (`User.email` در schema `@unique` است → حداکثر یک ردیف).
 * - ارتقا با conditional updateMany (`role != ADMIN`) → idempotent و بدون mass-update.
 * - verify: نقش بعد از نوشتن دوباره خوانده می‌شود؛ اگر ADMIN نبود → `verify-failed`.
 * - هیچ فیلد دیگری (plan/quota/password/…) نوشته نمی‌شود.
 */
export async function promoteToAdmin(
    email: string,
    client: BootstrapAdminClient,
): Promise<BootstrapOutcome> {
    const row = (await client.user.findUnique({
        where: { email },
        select: { id: true, email: true, role: true },
    })) as Record<string, unknown> | null

    if (row === null || typeof row.id !== "number") return { kind: "user-not-found" }

    const userId = row.id
    const storedEmail = typeof row.email === "string" ? row.email : email

    if (row.role === "ADMIN") return { kind: "already-admin", userId, email: storedEmail }

    // conditional update: فقط اگر همین لحظه ADMIN نباشد (بدون overwrite کورکورانه)
    await client.user.updateMany({
        where: { id: userId, role: { not: "ADMIN" } },
        data: { role: "ADMIN" },
    })

    // verify نتیجه (§۶ گام ۴)
    const verified = (await client.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true },
    })) as Record<string, unknown> | null

    if (verified === null || verified.role !== "ADMIN") {
        return { kind: "verify-failed", userId, email: storedEmail }
    }
    return { kind: "promoted", userId, email: storedEmail }
}

const USAGE = [
    "Usage: npm run bootstrap:admin -- <exact-email>",
    `   or: ${BOOTSTRAP_ADMIN_EMAIL_KEY}=<exact-email> npm run bootstrap:admin`,
].join("\n")

async function main() {
    const email = resolveRequestedEmail(process.argv)
    if (email === null) {
        console.error("✖ ایمیل معتبر داده نشده است.")
        console.error(USAGE)
        process.exitCode = 1
        return
    }

    const prisma = getPrisma()
    try {
        const outcome = await promoteToAdmin(email, prisma as unknown as BootstrapAdminClient)

        switch (outcome.kind) {
            case "promoted":
            case "already-admin": {
                const payload = {
                    ok: true,
                    action: outcome.kind,
                    userId: outcome.userId,
                    emailMasked: maskEmailForLog(outcome.email),
                    role: "ADMIN",
                }
                console.log(JSON.stringify(payload))
                console.log(
                    outcome.kind === "promoted"
                        ? "✔ کاربر به ADMIN ارتقا یافت و verify شد. برای اعمال، کاربر باید دوباره وارد شود/درخواست تازه بزند."
                        : "ℹ کاربر از قبل ADMIN بود — هیچ نوشتنی انجام نشد (idempotent).",
                )
                return
            }
            case "user-not-found": {
                console.error(`✖ کاربری با ایمیل دقیق ${maskEmailForLog(email)} پیدا نشد — هیچ تغییری اعمال نشد.`)
                process.exitCode = 1
                return
            }
            case "verify-failed": {
                console.error(
                    `✖ verify ناموفق برای userId=${outcome.userId} (${maskEmailForLog(outcome.email)}) — نقش بعد از نوشتن ADMIN نیست.`,
                )
                process.exitCode = 1
                return
            }
        }
    } finally {
        await prisma.$disconnect()
    }
}

const invokedDirectly =
    process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
    main().catch((error) => {
        console.error("✖ BOOTSTRAP FAILED:", error instanceof Error ? error.message : error)
        process.exitCode = 1
    })
}
