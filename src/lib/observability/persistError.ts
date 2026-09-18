// فاز ۲ — گام ۴: Persistence خطا در جدول ErrorLog (سند فاز ۲)
//
// persistError(record, context): درج fail-open رکورد redacted در ErrorLog.
//
// قرارداد سند فاز ۲:
// - Fail-Open مطلق: شکست insert (DB down، timeout، …) هرگز throw نمی‌شود و مسیر
//   پاسخ‌دهی را معطل نمی‌کند؛ به‌جای آن structuredConsoleFallback چاپ می‌شود.
// - بدون transaction، بدون retry loop؛ یک insert تکی با timeout محدود.
// - بدون وابستگی به recordError (کانال لاگ جدا است تا حلقه‌ی لاگ→persist→لاگ شکل نگیرد).

import type { Prisma } from "@prisma/client"

import { getPrisma } from "@/app/lib/getPrisma"

import { resolveEnvironment } from "./environment"
import type { NormalizedErrorRecord } from "./normalizeError"
import type { ObservabilityContext } from "./types"
import { severityToConsoleLevel } from "./severityLevel"

/** سقف طول رشته‌ها قبل از درج — دفاع دوم در عمق DB (لایه اول redactor است). */
export const PERSIST_LIMITS = {
    message: 2048,
    stack: 4096,
} as const

/** سقف زمان انتظار insert در مسیر production (معطلی در مسیر پاسخ‌دهی ممنوع). */
export const PERSIST_TIMEOUT_MS = 2000

/** سطر ErrorLog برای درج — شکل خالص، جدا از I/O برای تست‌پذیری. */
interface ErrorLogRow {
    requestId: string
    userId: number | null
    endpoint: string
    feature: string | null
    errorCode: string
    statusCode: number
    category: string
    severity: string
    message: string
    stack: string | null
    metadata?: Prisma.InputJsonValue
    /** سند §8 — از deployment/config خوانده می‌شود (هرگز hard-code). null = config ست نشده. */
    environment: string | null
}

/** ساخت سطر ErrorLog از رکورد redacted + context؛ خالص و بدون I/O. */
export function toErrorLogRow(
    record: NormalizedErrorRecord,
    context: ObservabilityContext,
): ErrorLogRow {
    return {
        requestId: context.requestId || "unknown",
        userId: context.userId ?? null,
        endpoint: context.endpoint || "unknown",
        feature: context.feature ?? null,
        errorCode: record.errorCode,
        statusCode: record.statusCode,
        category: record.category,
        severity: record.severity,
        message: (record.safeMessage ?? "").slice(0, PERSIST_LIMITS.message),
        stack: record.stack ? record.stack.slice(0, PERSIST_LIMITS.stack) : null,
        metadata: (record.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        environment: resolveEnvironment(),
    }
}

/** fallback ساختاریافته — جدا از recordError تا حلقه‌ی لاگ→persist→لاگ ایجاد نشود. */
export function structuredConsoleFallback(
    record: NormalizedErrorRecord,
    context: ObservabilityContext,
    reason: string,
): void {
    try {
        console.error(
            JSON.stringify({
                level: severityToConsoleLevel(record.severity),
                channel: "persistError.fallback",
                timestamp: new Date().toISOString(),
                reason,
                requestId: context.requestId,
                endpoint: context.endpoint,
                userId: context.userId,
                feature: context.feature,
                errorCode: record.errorCode,
                statusCode: record.statusCode,
                category: record.category,
                severity: record.severity,
                message: record.safeMessage,
                stack: record.stack,
                metadata: record.metadata,
            }),
        )
    } catch {
        // حتی fallback هم fail-open است — هیچ استثنایی به بیرون نمی‌رسد
    }
}

/** اجرای insert — dependency injection برای تست؛ پیش‌فرض کلاینت واقعی Prisma. */
export type CreateFn = (args: { data: ErrorLogRow }) => Promise<unknown>

function makeDefaultCreate(): CreateFn {
    return (args) => getPrisma().errorLog.create(args)
}

/**
 * گارد محیط تست: در unit tests هیچ I/O واقعی DB اجرا نمی‌شود.
 *
 * چرا لازم است: مسیر پاسخ‌دهی routes تست‌شده نباید به یک PostgreSQL واقعی وابسته شود و
 * نباید connection pool باز کند. تست‌های unit با `deps.create` سناریو را کامل کنترل می‌کنند.
 *
 * پیش‌فرض در محیط test خاموش است؛ تست‌های integration با PostgreSQL واقعی
 * (`*.db.test.ts`) آن را صریحاً روشن می‌کنند.
 */
let realPersistenceEnabled = !(process.env.VITEST || process.env.NODE_ENV === "test")

/**
 * روشن/خاموش کردن I/O واقعی DB — فقط برای تست‌های integration با PostgreSQL واقعی.
 * مصرف: فایل‌های `*.db.test.ts` این را در `beforeAll` روشن و در `afterAll` خاموش می‌کنند.
 */
export function setRealPersistenceEnabled(enabled: boolean): void {
    realPersistenceEnabled = enabled
}

/** وضعیت فعلی گارد — برای تست/تشخیص. */
export function isRealPersistenceEnabled(): boolean {
    return realPersistenceEnabled
}

/**
 * persistError — درج fail-open رکورد خطا در ErrorLog.
 *
 * - بدون transaction، بدون retry؛ یک insert تکی.
 * - شکست هرگز throw نمی‌شود؛ در شکست، structuredConsoleFallback چاپ می‌شود.
 * - Promise همیشه resolve می‌کند (هرگز reject نمی‌شود) تا await آن در recordError
 *   یا هر caller دیگری هرگز مسیر پاسخ‌دهی را نشکند.
 */
export async function persistError(
    record: NormalizedErrorRecord,
    context: ObservabilityContext,
    deps?: { create?: CreateFn },
    options?: { skipTimeoutGuard?: boolean; timeoutMs?: number },
): Promise<void> {
    // گارد محیط تست: بدون create تزریق‌شده و بدون فعال‌سازی صریح، هیچ I/O واقعی دیتابیس اجرا نمی‌شود
    // (تست‌های unit با deps.create سناریو را کنترل می‌کنند؛ تست‌های *.db.test.ts گارد را روشن می‌کنند).
    if (!deps?.create && !realPersistenceEnabled) return

    const create = deps?.create ?? makeDefaultCreate()
    const row = toErrorLogRow(record, context)
    const timeoutMs = options?.timeoutMs ?? PERSIST_TIMEOUT_MS

    if (options?.skipTimeoutGuard) {
        // مسیر تست: کنترل کامل سناریو در اختیار تست است
        try {
            await create({ data: row })
        } catch {
            structuredConsoleFallback(record, context, "db_insert_failed")
        }
        return
    }

    // مسیر production: timeout guard تا مسیر پاسخ‌دهی معطل نشود.
    // برنده‌ی race تشخیص داده می‌شود تا فقط در timeout واقعی fallback چاپ شود؛
    // rejection دیرهنگام insert (بعد از برد timeout) بلعیده می‌شود (بدون unhandledRejection).
    let insertSettled = false
    const insertPromise = create({ data: row })
    void insertPromise.catch(() => {
        if (!insertSettled) structuredConsoleFallback(record, context, "db_insert_failed")
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
        insertPromise.then(
            () => "inserted" as const,
            () => "failed" as const,
        ),
        new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), timeoutMs)
            if (typeof timer.unref === "function") timer.unref()
        }),
    ])
    insertSettled = true
    if (timer !== undefined) clearTimeout(timer)

    if (outcome === "timeout") {
        structuredConsoleFallback(record, context, "persist_timeout")
    }
}
