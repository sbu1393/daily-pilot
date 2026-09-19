// فاز ۳ — گام ۴: سرویس ProductEvent (fail-open bounded persistence)
// Source of Truth: monitoring/فاز سه.docx — §4 (Architecture), §10 (Validation),
// §17 (Failure Matrix: analytics failure never breaks request).
//
// طراحی:
// - روی contract گام ۳ ساخته شده (taxonomy/allowlist/validation را دوباره پیاده نمی‌کند).
// - userId فقط از authenticated server-side identity؛ هرگز از کلاینت.
// - requestId فقط correlation: nullable، non-unique، بدون deduplication.
// - insert فقط برای event معتبر؛ validation قبل از هر I/O.
// - bounded: insert تکی با timeout guard (الگوی persistError فاز ۲) — بدون retry.
// - fail-open: شکست هرگز throw نمی‌شود؛ از recordError فاز ۰/۲ گزارش می‌شود.
//   گارد recursion: فاکتور خطای ثابت و بدون properties — گزارش فقط یک سطح پیش می‌رود
//   (recordError → pipeline فاز ۲ → persistError) و persistError کانال کاملاً جدا و
//   fail-openی دارد که هرگز به این سرویس برنمی‌گردد؛ پس حلقه‌ی telemetry شکل نمی‌گیرد.
// - fire-and-forget ممنوع: Promise برمی‌گردد که caller می‌تواند await کند — اما این
//   Promise هرگز reject نمی‌شود (fail-open مطلق).

import { getPrisma } from "@/app/lib/getPrisma"
import { recordError } from "@/src/lib/observability/recordError"
import type { ObservabilityContext } from "@/src/lib/observability/types"

import {
    validateProductEvent,
    type ProductEventName,
    type ProductEventProperties,
} from "./productEvent.contract"

/** سقف زمان انتظار insert — الگوی PERSIST_TIMEOUT_MS فاز ۲ (مسیر پاسخ معطل نمی‌شود). */
export const PRODUCT_EVENT_TIMEOUT_MS = 2000

/** فاکتور خطای observability — ثابت و بدون properties حساس. */
const RECORD_FAILURE_ERROR_CODE = "PRODUCT_EVENT_RECORD_FAILED"

/** شکل سطر Prisma برای insert — خالص، برای تست‌پذیری جدا از I/O. */
export interface ProductEventRow {
    userId: number
    requestId: string | null
    eventName: ProductEventName
    feature: string | null
    properties: ProductEventProperties
}

/** شکل رکورد validated نهایی — همان properties whitelist‌شده‌ی قرارداد گام ۳. */
export interface ProductEventRecord {
    eventName: ProductEventName
    properties: ProductEventProperties
}

/** نتیجه‌ی recordProductEvent — هرگز throw نمی‌کند. */
export type RecordProductEventResult =
    | { recorded: true; eventName: ProductEventName }
    | { recorded: false; reason: "invalid_event" | "persistence_failed" | "persistence_timeout" | "persistence_disabled" }

/** تزریق وابستگی برای تست — پیش‌فرض کلاینت واقعی Prisma. */
export interface ProductEventDeps {
    create?: (args: { data: ProductEventRow }) => Promise<unknown>
}

/** گزینه‌های اختیاری رفتار — برای تست. */
export interface ProductEventOptions {
    timeoutMs?: number
    /** فقط مسیر تست: پرش از timeout guard برای کنترل کامل سناریو. */
    skipTimeoutGuard?: boolean
}

/**
 * بررسی وجود Prisma model ProductEvent — اگر model/migration موجود نباشد،
 * بدون کرش، false برمی‌گرداند تا caller بتواند fail-open عمل کند.
 */
function isProductEventModelAvailable(): boolean {
    try {
        const prisma = getPrisma()
        return prisma != null && typeof prisma.productEvent?.create === "function"
    } catch {
        return false
    }
}

function makeDefaultCreate() {
    return (args: { data: ProductEventRow }) => getPrisma().productEvent.create(args)
}

/**
 * recordProductEvent — ثبت یک رویداد تحلیلی ProductEvent.
 *
 * ترتیب (§4): validate → insert bounded → fail-open.
 * - validation از contract گام ۳؛ فقط event معتبر persist می‌شود.
 * - properties خروجی = دقیقاً همان whitelist validated (بدون serialization دلخواه).
 * - Promise همیشه resolve می‌کند؛ await آن در caller هرگز نمی‌شکند.
 * - userId باید از context/جلسه‌ی سمت سرور بیاید — تابع خودش identity را از
 *   request/client نمی‌خواند (مسئولیت caller).
 */
export async function recordProductEvent(
    userId: number,
    eventName: unknown,
    properties: unknown,
    context: Pick<ObservabilityContext, "requestId" | "endpoint"> & { feature?: string },
    deps?: ProductEventDeps,
    options?: ProductEventOptions,
): Promise<RecordProductEventResult> {
    // 1) userId معتبر server-side — کلاینت‌محور ممنوع
    if (typeof userId !== "number" || !Number.isInteger(userId) || userId <= 0) {
        return { recorded: false, reason: "invalid_event" }
    }

    // 2) validation قرارداد (fail-safe داخلی خودش است)
    const validation = validateProductEvent(eventName, properties)
    if (!validation.valid) {
        return { recorded: false, reason: "invalid_event" }
    }

    // 3) گارد محیط تست: بدون create تزریق‌شده، هیچ I/O واقعی اجرا نمی‌شود
    if (!deps?.create && (process.env.VITEST || process.env.NODE_ENV === "test")) {
        return { recorded: true, eventName: validation.eventName }
    }

    // 4) گارد model Prisma: اگر ProductEvent table/migration موجود نباشد،
    //    بدون کرش و بدون log spam، fail-open برمی‌گردانیم.
    if (!deps?.create && !isProductEventModelAvailable()) {
        return { recorded: false, reason: "persistence_disabled" }
    }

    const create = deps?.create ?? makeDefaultCreate()
    const row: ProductEventRow = {
        userId,
        // requestId فقط correlation — nullable، non-unique، بدون dedup
        requestId: context?.requestId || null,
        eventName: validation.eventName,
        feature: context?.feature ?? null,
        properties: validation.properties,
    }

    try {
        const timeoutMs = options?.timeoutMs ?? PRODUCT_EVENT_TIMEOUT_MS

        if (options?.skipTimeoutGuard) {
            // مسیر تست: کنترل کامل سناریو
            try {
                await create({ data: row })
                return { recorded: true, eventName: validation.eventName }
            } catch {
                reportPersistenceFailure(context)
                return { recorded: false, reason: "persistence_failed" }
            }
        }

        // مسیر production: timeout guard — برنده‌ی race تشخیص داده می‌شود؛
        // rejection دیرهنگام insert بلعیده می‌شود (بدون unhandledRejection، بدون fallback تکراری).
        let reported = false
        const insertPromise = create({ data: row })
        void insertPromise.catch(() => {
            if (!reported) {
                reported = true
                reportPersistenceFailure(context)
            }
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
        if (timer !== undefined) clearTimeout(timer)

        if (outcome === "timeout") {
            if (!reported) {
                reported = true
                reportPersistenceFailure(context)
            }
            return { recorded: false, reason: "persistence_timeout" }
        }
        if (outcome === "failed") {
            if (!reported) {
                reported = true
                reportPersistenceFailure(context)
            }
            return { recorded: false, reason: "persistence_failed" }
        }
        return { recorded: true, eventName: validation.eventName }
    } catch {
        // fail-open مطلق — هیچ مسیری از این تابع throw نمی‌گیرد
        reportPersistenceFailure(context)
        return { recorded: false, reason: "persistence_failed" }
    }
}

/**
 * گزارش شکست persistence از طریق recordError موجود فاز ۰/۲ — بدون recursion:
 * - فاکتور ثابت و بدون properties؛ هیچ raw properties/event nameی از caller وارد
 *   گزارش نمی‌شود (نکته‌ی امنیتی دستور).
 * - recordError به pipeline فاز ۲ می‌رود؛ policy فاز ۲ برای PRODUCT_EVENT_RECORD_FAILED
 *   unknown است → default محافظه‌کارانه persist=true → persistError اجرا می‌شود.
 *   آن مسیر کاملاً مستقل از این سرویس است (persistError کانال جدا دارد و خودش fail-open)،
 *   پس حلقه‌ی telemetry شکل نمی‌گیرد.
 * - خود این helper هم fail-open است.
 */
function reportPersistenceFailure(
    context: Pick<ObservabilityContext, "requestId" | "endpoint"> & { feature?: string },
): void {
    try {
        const error = new Error(RECORD_FAILURE_ERROR_CODE)
        // فقط شکل ServiceError-مانند حداقلی؛ category/severity صریح
        recordError(error, {
            requestId: context?.requestId || "unknown",
            endpoint: context?.endpoint || "unknown",
            userId: undefined,
            feature: context?.feature ?? "analytics",
        })
    } catch {
        // fail-open مطلق
    }
}
