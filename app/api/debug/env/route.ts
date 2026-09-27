import { NextRequest } from "next/server"
import { timingSafeEqual } from "crypto"
import { errorResponse, okResponse } from "@/app/lib/apiResponse"
import { clientIp, isRateLimited } from "@/app/lib/rateLimit"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { isSandboxFromAddress, resolveFromAddress } from "@/app/lib/email"

/* ------------------------------------------------------------------ */
/* GET /api/debug/env — تشخیص پیکربندی ایمیل در همان محیطی که اجرا است  */
/*                                                                     */
/* چرا این مسیر وجود دارد؟                                             */
/* خطای 401 از Resend یعنی «مقداری که این deployment از env خوانده      */
/* معتبر نیست». برای تفکیک «متغیر ست نشده» / «مقدار معیوب» / «کلید      */
/* اشتباه یا قدیمی» باید مقدار runtime *همان محیط* دیده شود.           */
/*                                                                     */
/* قواعد امنیتی:                                                       */
/* - fail-closed: بدون DEBUG_ENV_TOKEN این مسیر در production وجود      */
/*   ندارد (404). با توکن، فقط درخواستِ دارای توکن صحیح پاسخ می‌گیرد.   */
/* - هیچ‌گاه مقدار کامل کلید برگردانده نمی‌شود؛ فقط hasKey/boolean و    */
/*   metadata کم‌خطر (prefix کوتاه + طول) برای مقایسهٔ چشمی با پنل.       */
/* - body کلید بی‌ریسک است ولی در هر حالتی محافظت‌شده است.               */
/* - rate-limit تا توکن قابل brute-force نباشد.                         */
/* ------------------------------------------------------------------ */

/** این مسیر باید مقادیر runtime را بخواند؛ ارزیابی استاتیک یعنی خروجی در زمان build ثابت شود. */
export const dynamic = "force-dynamic"

/** crypto.timingSafeEqual روی Buffer نیاز به runtime نودی دارد. */
export const runtime = "nodejs"

/** نام هدری که توکن دیباگ از آن خوانده می‌شود (روش ترجیحی — در لاگ URL نمی‌نشیند). */
const DEBUG_TOKEN_HEADER = "x-debug-token"

/** حداکثر تلاش در پنجرهٔ پیش‌فرض برای جلوگیری از حدس زدن توکن. */
const RATE_LIMIT_MAX_ATTEMPTS = 10

/**
 * توکن ارائه‌شده را از هدر (ترجیحی) یا query می‌خواند.
 * query برای باز کردن سریع در مرورگر است؛ هدر امن‌تر است چون در access-log ثبت نمی‌شود.
 */
function readProvidedToken(req: NextRequest): string | null {
    const header = req.headers.get(DEBUG_TOKEN_HEADER)
    if (header !== null && header.trim() !== "") return header.trim()

    const query = new URL(req.url).searchParams.get("token")
    return query !== null && query.trim() !== "" ? query.trim() : null
}

/** مقایسهٔ ثابت‌زمان — نشت اطلاعات از طریق اختلاف زمان مقایسه را حذف می‌کند. */
function tokensMatch(provided: string, expected: string): boolean {
    const providedBuffer = Buffer.from(provided)
    const expectedBuffer = Buffer.from(expected)
    if (providedBuffer.length !== expectedBuffer.length) return false
    return timingSafeEqual(providedBuffer, expectedBuffer)
}

export async function GET(req: NextRequest) {
    const context = createObservabilityContext("/api/debug/env", "debug")
    const requestId = context.requestId

    try {
        if (isRateLimited(`debug:env:${clientIp(req)}`, RATE_LIMIT_MAX_ATTEMPTS)) {
            return errorResponse(
                429,
                "RATE_LIMITED",
                "تلاش‌های زیادی انجام شده؛ کمی بعد دوباره تلاش کن",
                undefined,
                requestId,
            )
        }

        const configuredToken = (process.env.DEBUG_ENV_TOKEN ?? "").trim()

        if (configuredToken !== "") {
            const provided = readProvidedToken(req)
            if (provided === null || !tokensMatch(provided, configuredToken)) {
                // هیچ بخشی از توکن لاگ نمی‌شود.
                console.warn("[debug/env] rejected: invalid or missing debug token")
                return errorResponse(
                    403,
                    "FORBIDDEN",
                    "توکن دیباگ نامعتبر است",
                    undefined,
                    requestId,
                )
            }
        } else if (process.env.NODE_ENV === "production") {
            // fail-closed: بدون توکن، این مسیر در production وجود ندارد (حتی وجودش افشا نمی‌شود).
            return errorResponse(404, "NOT_FOUND", "یافت نشد", undefined, requestId)
        }

        // همان چیزی که مسیر ارسال ایمیل می‌بیند — با همان trim.
        const rawKey = process.env.RESEND_API_KEY
        const key = (rawKey ?? "").trim()
        const from = resolveFromAddress()
        const rawFrom = process.env.RESEND_FROM_EMAIL

        return okResponse(
            {
                // برای تأیید اینکه پاسخ از کدام deployment/محیط آمده است.
                environment: {
                    nodeEnv: process.env.NODE_ENV ?? null,
                    vercelEnv: process.env.VERCEL_ENV ?? null, // production | preview | development
                    commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
                    deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
                },
                resend: {
                    /** آیا متغیر در این محیط مقدار (بعد از trim) دارد؟ */
                    hasKey: key !== "",
                    /**
                     * ۴ کاراکتر اول کلید — فقط برای مقایسهٔ چشمی با پنل Resend.
                     * توجه: این تنها فیلدی است که بخشی از secret است؛ اگر سیاست
                     * پروژه سخت‌گیرانه است، حذفش کن (بقیهٔ فیلدها boolean هستند).
                     */
                    keyPrefix: key === "" ? null : key.slice(0, 4),
                    /** طول رشتهٔ کلید پس از trim — برای تشخیص کلید ناقص/بریده‌شده. */
                    length: key.length,
                    /** کلیدهای Resend با «re_» شروع می‌شوند؛ غیر از آن ⇒ 401 از Resend. */
                    startsWithResendPrefix: key.startsWith("re_"),
                    /** فاصله/`\n` انتهایی در مقدار env (paste دستی یا CLI) — trim می‌شود. */
                    hadSurroundingWhitespace: rawKey !== undefined && rawKey !== key,
                    /** آدرس فرستندهٔ مؤثر (مقدار غیرحساس). */
                    fromAddress: from,
                    senderIsSandbox: isSandboxFromAddress(from),
                    /** اگر false باشد، sandbox پیش‌فرض Resend استفاده می‌شود (فقط ارسال به مالک حساب). */
                    fromEmailConfigured: rawFrom !== undefined && rawFrom.trim() !== "",
                },
                debug: {
                    /** بدون این، مسیر در production به‌صورت fail-closed بسته است. */
                    tokenConfigured: configuredToken !== "",
                },
            },
            { requestId },
        )
    } catch {
        // هیچ جزئیات داخلی افشا نمی‌شود و هیچ خطای دیباگی در ErrorLog ذخیره نمی‌شود.
        return errorResponse(500, "INTERNAL", "خطای سرور", undefined, requestId)
    }
}
