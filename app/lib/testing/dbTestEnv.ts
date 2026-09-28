/**
 * محافظ تست‌های دیتابیس (fail-closed) — ماژول خالص، بدون وابستگی
 * ---------------------------------------------------------------------------
 * چرا این فایل وجود دارد
 *
 * سه suite از این پروژه (`*.concurrency.db.test.ts` و
 * `errorLog.persistence.db.test.ts`) عمداً با «PostgreSQL واقعی» کار می‌کنند؛
 * skip و mock در آن‌ها ممنوع است. اگر `DATABASE_URL` به دیتابیس واقعی
 * (پروداکشن) اشاره کند، این تست‌ها روی داده‌ی واقعی کاربران اجرا می‌شوند و
 * رکورد تستی می‌سازند — همان اتفاقی که در عمل افتاد و بعد از قطع ناگهانی
 * پروسه، رکورد یتیم باقی ماند و اجرای بعدی را شکست.
 *
 * این ماژول دو چیز می‌دهد:
 *
 *   1. `assertTestDatabase()` — نگهبان fail-closed. **قبل از هر write** صدا زده
 *      می‌شود و اگر مقصد قطعاً «دیتابیس تست» نباشد throw می‌کند. قاعده عمداً
 *      سخت‌گیرانه است: هر چیزی که *قطعاً* تست نباشد رد می‌شود، چون خطای
 *      «هیچ تستی اجرا نشد» بسیار کم‌خطرتر از «نوشتن روی داده‌ی کاربر» است.
 *
 *   2. `newTestRunId()` — شناسه‌ی یکتا برای هر اجرا (UUID). به‌جای یک مقدار
 *      ثابت، هر اجرا marker خودش را می‌سازد؛ پس اجرای موازی یا اجرای دوباره
 *      بعد از قطع، هرگز با هم تداخل نمی‌کنند و cleanup هم دقیقاً همان اجرا را
 *      هدف می‌گیرد.
 *
 * چرا transaction راه‌حل نیست (و اینجا استفاده نشده)
 *
 * تست‌های این پروژه عمداً «concurrency واقعی» را می‌سنجند: چندین فراخوانی همزمان
 * روی connection‌های جدا (Promise.all) تا contention واقعی PostgreSQL دیده شود.
 * اگر همه‌ی آن‌ها داخل یک transaction می‌رفتند، هرگز یکدیگر را block
 * نمی‌کردند و تست چیزی را ثابت نمی‌کرد. بنابراین معماری درست این‌ها
 * «جداسازی + پاک‌سازی هدفمند» است، نه تراکنش.
 *
 * مرزها
 *
 * این ماژول هیچ چیزی را پاک نمی‌کند و هیچ DB‌ای را وصل نمی‌کند؛ فقط تصمیم
 * می‌گیرد آیا اجازه‌ی ادامه هست یا نه. پاک‌سازی را خودِ تست‌ها انجام می‌دهند و
 * آن هم فقط روی ردیف‌هایی که خودشان با marker یکتا ساخته‌اند.
 */

/* ------------------------------------------------------------------ */
/* الگوهای مجاز                                                       */
/* ------------------------------------------------------------------ */

/**
 * نام دیتابیس‌هایی که *قطعاً* تستی تلقی می‌شوند. تطبیق روی «نام دیتابیس»
 * (بخش انتهایی مسیر) انجام می‌شود، نه روی کل رشته.
 *
 * عمداً سخت‌گیر است: باید واژه‌ی تست را داشته باشند. `neondb` یا هر نام
 * دیگری رد می‌شود.
 */
const TEST_DATABASE_NAME = /(^|[_-])(test|testing|testdb|test_db)([_-]|$)/i

/** میزبان‌هایی که همیشه لوکال‌اند و می‌توانند با پورت تست معتبر باشند. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal"])

/**
 * میزبان‌های hosted/managed که هرگز نباید حتی با نام دیتابیس تست پذیرفته شوند.
 *
 * دلیل: در سرویس‌هایی مثل Neon، «branch» و «database» هر دو روی یک زیرساخت
 * مشترک‌اند. یعنی branch تست ممکن است نامی مثل `neondb_test` داشته باشد ولی
 * اگر `DATABASE_URL` اشتباه به endpoint پروداکشن اشاره کند، تست روی داده‌ی
 * واقعی نوشته می‌شود. پس برای این میزبان‌ها، **فقط** لوکال‌بودن یا پورت تستِ
 * صریح می‌تواند مجوز بدهد — نه نام دیتابیس.
 */
const MANAGED_HOST = /(\.neon\.tech$|\.aws\.neon\.tech$|neon\.tech$|\.supabase\.(com|co)$|\.onrender\.com$|\.railway\.app$|\.fly\.dev$|\.herokuapp\.com$)/i

/** پورت استاندارد PostgreSQL برای محیط تست (پورت ۵۴۳۲ = پروداکشن). */
const TEST_PORT = "5433"

/** الگوی یک پورت تست سفارشی که صریحاً با test/qa/dev شماره‌گذاری شده. */
const EXPLICIT_TEST_PORT = /^(5433|6432|6433|15432|25432|35432|45432)$/

/* ------------------------------------------------------------------ */
/* نتیجه‌ی بررسی                                                      */
/* ------------------------------------------------------------------ */

export type DatabaseCheckResult =
    | { ok: true; reason: string }
    | { ok: false; reason: string }

/**
 * تصمیم می‌گیرد آیا `DATABASE_URL` یک دیتابیس تست است.
 *
 * فقط وقتی `ok: true` برمی‌گرداند که یکی از این‌ها برقرار باشد:
 *   - میزبان لوکال (localhost/127.0.0.1/…) — چیزی جز دیتابیس این ماشین نیست؛
 *   - نام دیتابیس صریحاً تستی (شامل test/testdb/…)؛
 *   - پورت تست شناخته‌شده (۵۴۳۳ و مشابه، یا شماره‌های صریحِ تست).
 *
 * هر چیز دیگری (Neon، دامنه‌ی ناشناخته، URL خراب، نبودِ متغیر) `ok: false`
 * می‌دهد — یعنی fail-closed.
 */
export function checkDatabaseUrl(url: string | undefined | null): DatabaseCheckResult {
    if (typeof url !== "string" || url.trim() === "") {
        return {
            ok: false,
            reason: "متغیر DATABASE_URL تنظیم نشده است.",
        }
    }

    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return {
            ok: false,
            reason: "DATABASE_URL قابل تجزیه نیست (URL نامعتبر).",
        }
    }

    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
        return {
            ok: false,
            reason: `پروتکل «${parsed.protocol}» پشتیبانی نمی‌شود؛ فقط postgres/postgresql.`,
        }
    }

    const host = parsed.hostname.toLowerCase()
    const port = parsed.port || "5432"

    // نام دیتابیس = آخرین بخش مسیر، بدون اسلش انتهایی
    const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, "")).toLowerCase()

    const isLocal = LOCAL_HOSTS.has(host)
    const isTestNamed = TEST_DATABASE_NAME.test(dbName)
    const isTestPort =
        port === TEST_PORT || (isLocal && EXPLICIT_TEST_PORT.test(port))
    const isManaged = MANAGED_HOST.test(host)

    if (isLocal) {
        return {
            ok: true,
            reason: `میزبان «${host}» لوکال است، پس دیتابیس بیرون از این ماشین نیست.`,
        }
    }

    // میزبان managed: نام دیتابیس به‌تنهایی هرگز کافی نیست (شاخه‌ی تست ممکن
    // است نام تستی داشته باشد ولی endpoint اشتباه به پروداکشن وصل شود).
    if (isManaged && !isTestPort) {
        return {
            ok: false,
            reason:
                `میزبان «${host}» یک سرویس مدیریت‌شده است و نام دیتابیس برای اثبات ` +
                "تستی‌بودن کافی نیست. برای این سرویس فقط یک دیتابیس تستِ واقعاً " +
                "جدا (یا پورت تست صریح) پذیرفته می‌شود.",
        }
    }

    if (isTestNamed) {
        return {
            ok: true,
            reason: `نام دیتابیس «${dbName}» صریحاً تستی است.`,
        }
    }

    if (isTestPort) {
        return {
            ok: true,
            reason: `پورت «${port}» پورت تست شناخته‌شده است.`,
        }
    }

    return {
        ok: false,
        reason:
            `مقصد «${host}:${port}/${dbName}» دیتابیس تست تشخیص داده نشد. ` +
            "تست‌های DB فقط روی دیتابیس تست اجرا می‌شوند (لوکال، یا نام/پورت تست).",
    }
}

/* ------------------------------------------------------------------ */
/* نگهبان fail-closed                                                 */
/* ------------------------------------------------------------------ */

/**
 * اگر مقصد دیتابیس تست نباشد، throw می‌کند.
 *
 * **این تابع باید پیش از نخستین write صدا زده شود.** روی مقصد پروداکشن
 * تست را متوقف می‌کند بدون آنکه حتی یک ردیف بخواند یا بنویسد.
 */
export function assertTestDatabase(url: string | undefined | null = process.env.DATABASE_URL): void {
    const result = checkDatabaseUrl(url)

    if (result.ok) {
        if (typeof process !== "undefined" && process.env.DB_TEST_GUARD_DEBUG === "1") {
            // eslint-disable-next-line no-console
            console.log(`[dbTestEnv] اجازه‌ی اجرا: ${result.reason}`)
        }
        return
    }

    throw new Error(
        "DB_TEST_NOT_ALLOWED: اجرای تست دیتابیس روی این مقصد مجاز نیست و پیش از " +
            `هر نوشتنی متوقف شد — ${result.reason} برای تست DB یک دیتابیس تست جدا ` +
            "لازم است (مثلاً یک branch جدا در Neon یا PostgreSQL لوکال).",
    )
}

/* ------------------------------------------------------------------ */
/* marker یکتا برای هر اجرا                                            */
/* ------------------------------------------------------------------ */

/**
 * شناسه‌ی یکتا برای یک اجرای تست.
 *
 * چرا یکتا: اگر پروسه‌ای وسط کار قطع شود و cleanup اجرا نشود، marker ثابت
 * اجرای بعدی را می‌شکند (unique constraint) — و داده‌ی یتیم جمع می‌شود. با
 * marker یکتا، اجرای بعدی هیچ تداخلی ندارد و داده‌ی یتیم هم قابل شناسایی است.
 */
export function newTestRunId(): string {
    // در Node 18+ به‌صورت سراسری هست؛ import صریح هم fallback را تضمین می‌کند.
    if (typeof globalThis.crypto?.randomUUID === "function") {
        return globalThis.crypto.randomUUID()
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * marker یکتا برای یک suite مشخص.
 *
 * مثال: `testMarker("step11")` → `"step11-<uuid>@dbtest.invalid"`.
 * دامنه‌ی `.invalid` طبق RFC 2606 تضمین می‌کند هرگز به یک دامنه‌ی واقعی اشاره
 * نکند (درستی marker و جلوگیری از نشت تصادفی).
 */
export function testMarker(prefix: string, runId: string = newTestRunId()): string {
    return `${prefix}-${runId}@dbtest.invalid`
}
