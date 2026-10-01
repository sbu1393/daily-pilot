"use client"

// صفحه اشتراک — یک کارت رایگان + سه محصول اشتراکی، همه از کاتالوگ سروری.
//
// نکته‌ی اصلی: هیچ عددِ **قیمت/مدت/تخفیف** در این فایل hard-code نشده — همه از
// `BILLING_PRODUCTS` در `app/lib/billing/products.ts` می‌آیند، همان ماژولی که سرور مبلغ
// و مدت را از آن snapshot می‌کند. تنها اعداد نمایشیِ دیگر (سهمیه‌ی هوشمند و هزینه‌ی هر
// روز) از `planCopy.ts` می‌آید که خودشان از سیاست سهمیه مشتق می‌شوند.
//
// واحد: کاتالوگ ریال (IRR) است؛ فقط برای نمایش به تومان تبدیل می‌شود (`tomanFromRial`)
// که یک تبدیل نمایشی است و هیچ نقشی در مبلغ پرداختی ندارد.
//
// سلسله‌مراتب بصری هر کارت (برای مقایسه‌ی سریع): نام پلن → قیمت → تخفیف و صرفه‌جویی
// → مدت → مزایا → سهمیه‌ی هوشمند → دکمهٔ خرید.
//
// خرید: `POST /api/billing/checkout` با بدنه‌ی `{ productCode }` و یک هدر
// `Idempotency-Key` تازه برای هر تلاش. بعد از موفقیت، کاربر به `redirectUrl` درگاه
// هدایت می‌شود.
//
// بخش کد هدیه (PromoRedeemBox) دست‌-نخورده باقی مانده است.

import { useState } from "react"
import Link from "next/link"
import {
    ArrowRight,
    BrainCircuit,
    CalendarCheck,
    Check,
    Crown,
    Headphones,
    ListTodo,
    Loader2,
    Sparkles,
    Star,
} from "lucide-react"

import { api, ApiClientError } from "@/app/lib/api/client"
import { BILLING_PRODUCTS, tomanFromRial, type ProductCode } from "@/app/lib/billing/products"
import { faDigits } from "@/app/lib/time"
import PromoRedeemBox from "./PromoRedeemBox"
import {
    FREE_PLAN,
    PLAN_COPY,
    faGrouped,
    perDayToman,
    renderFeatureLabel,
    smartQuotaFor,
    type FeatureIcon,
} from "./planCopy"
import styles from "./subscription.module.css"

/** آیکون مینیمال هر بولت — فقط برای اسکن سریع‌تر کارت، نه تزئین. */
const FEATURE_ICONS: Record<FeatureIcon, typeof Check> = {
    analyze: BrainCircuit,
    plan: CalendarCheck,
    support: Headphones,
    tasks: ListTodo,
    basic: Check,
}

/** پاسخ checkout — فقط همان چیزهایی را که route مجاز به برگرداندن است. */
interface CheckoutResult {
    orderId: string
    status: string
    redirectUrl?: string
}

export default function SubscriptionView({ user }: { user: { id: number } | null }) {
    const [pending, setPending] = useState<ProductCode | null>(null)
    const [error, setError] = useState<string | null>(null)

    const handleBuy = async (productCode: ProductCode) => {
        // قفل هم‌زمانی سمت کلاینت: تا وقتی درخواست جاری تمام نشده، تلاش دوم ارسال نمی‌شود
        // (سرور هم با rate limit و کلید idempotency خودش محافظت می‌شود).
        if (pending !== null) return
        setPending(productCode)
        setError(null)
        try {
            const result = await api<CheckoutResult>("/api/billing/checkout", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    // کلید تازه در هر تلاش؛ کد محصول داخل کلید است تا اگر کاربر محصول عوض
                    // کرد، هرگز به سفارش محصول قبلی برنخورد.
                    "Idempotency-Key": `checkout-${productCode}-${crypto.randomUUID()}`,
                },
                // تنها چیزی که کلاینت می‌فرستد؛ مبلغ/مدت را سرور از کاتالوگ می‌گیرد.
                body: JSON.stringify({ productCode }),
            })
            if (typeof result.redirectUrl === "string" && result.redirectUrl !== "") {
                window.location.assign(result.redirectUrl)
                return
            }
            // بدون redirect یعنی سفارش از قبل terminal بوده (مثلاً پرداخت‌شده) و نیازی به
            // فرستادن دوباره‌ی کاربر به درگاه نیست؛ کاربر به داشبورد برمی‌گردد.
            window.location.assign("/dashboard")
        } catch (err) {
            setError(
                err instanceof ApiClientError
                    ? err.message
                    : "شروع پرداخت ناموفق بود؛ کمی بعد دوباره تلاش کن",
            )
        } finally {
            setPending(null)
        }
    }

    return (
        <div className={styles.page}>
            <header className={styles.head}>
                {/* مسیر برگشت — این صفحه `layout.tsx` ندارد، پس نه `Header` نه
                    `AppShell` روی آن رندر نمی‌شود و بدون این دکمه تنها راه خروج،
                    لینکِ پلن فعلی داخل کارت رایگان است که برچسبش ناوبری را توصیف
                    نمی‌کند. مقصد عمداً ثابت است (`/dashboard`). */}
                <div className={styles.backLink}>
                    <Link href="/dashboard" className="dp-btn dp-btn-ghost">
                        <ArrowRight size={16} aria-hidden="true" />
                        بازگشت به داشبورد
                    </Link>
                </div>

                <h1 className={styles.title}>
                    <Crown className={styles.titleIcon} size={28} aria-hidden="true" />
                    اشتراک ویژه
                </h1>
                <p className={styles.subtitle}>
                    ارتقا بده و بدون محدودیت روزت را بساز
                </p>
            </header>

            {/* کد هدیه — پیش از کارت‌های پلن، چون «ظرفیت» همیشه گزینهٔ اول کاربر
                با سهمیهٔ کم است و پلن‌ها جایگزینِ آن هستند، نه مقدم بر آن. */}
            <PromoRedeemBox user={user} />

            <div className={styles.grid}>
                {/* پلن رایگان — محصول قابل خرید نیست و از کاتالوگ نمی‌آید. عمداً
                    آرام‌تر از کارت‌های اشتراکی است تا تفاوت «رایگان / پولی» فوری دیده شود. */}
                <section className={styles.cardFree}>
                    <div className={styles.cardHead}>
                        <h2 className={styles.cardTitle}>{FREE_PLAN.title}</h2>
                        <p className={styles.cardSubtitle}>{FREE_PLAN.subtitle}</p>
                    </div>

                    <div className={styles.priceRow}>
                        <span className={styles.priceValue}>
                            {FREE_PLAN.price}
                            <span className={styles.priceUnit}> تومان</span>
                        </span>
                        <span className={styles.pricePeriod}>{FREE_PLAN.period}</span>
                    </div>

                    <ul className={styles.features}>
                        {FREE_PLAN.features.map((feature) => {
                            const Icon = FEATURE_ICONS[feature.icon]
                            return (
                                <li key={feature.label} className={styles.feature}>
                                    <Icon
                                        size={16}
                                        className={styles.featureIcon}
                                        aria-hidden="true"
                                    />
                                    <span>{feature.label}</span>
                                </li>
                            )
                        })}
                    </ul>

                    <div className={styles.cta}>
                        <Link href="/dashboard" className="dp-btn dp-btn-ghost dp-btn-block">
                            {FREE_PLAN.cta}
                        </Link>
                    </div>
                </section>

                {/* سه محصول اشتراکی — همه‌ی اعداد از کاتالوگ، بدون hard-code */}
                {BILLING_PRODUCTS.map((product) => {
                    const copy = PLAN_COPY[product.code]
                    const quota = smartQuotaFor(product.entitlementDays)
                    const amountToman = tomanFromRial(product.amount)
                    const saving = product.baseAmount - product.amount
                    const perDay = perDayToman(amountToman, product.entitlementDays)
                    const busy = pending === product.code
                    const blocked = pending !== null && !busy
                    const periodLabel =
                        quota.months > 1 ? `${faDigits(quota.months)} ماه` : "ماهانه"

                    return (
                        <section
                            key={product.code}
                            className={
                                copy.featured === true
                                    ? styles.cardFeatured
                                    : styles.card
                            }
                        >
                            {copy.featured === true && (
                                <span className={styles.badge}>
                                    <Star size={13} aria-hidden="true" />
                                    پیشنهاد ویژه
                                </span>
                            )}

                            <div className={styles.cardHead}>
                                <h2 className={styles.cardTitle}>{copy.title}</h2>
                                {copy.featured === true && (
                                    <p className={styles.cardSubtitle}>
                                        کمترین هزینه به ازای هر روز
                                    </p>
                                )}
                            </div>

                            {/* قیمت فعلی — بزرگ‌ترین عنصر قیمتی کارت */}
                            <div className={styles.priceRow}>
                                <span className={styles.priceValue}>
                                    {faGrouped(amountToman)}
                                    <span className={styles.priceUnit}> تومان</span>
                                </span>
                                <span className={styles.pricePeriod}>{periodLabel}</span>
                            </div>

                            {/* تخفیف و صرفه‌جویی — کنار قیمت اصلیِ خط‌خورده */}
                            <p className={styles.priceMeta}>
                                <span className={styles.priceBase}>
                                    {faGrouped(tomanFromRial(product.baseAmount))} تومان
                                </span>
                                <span className={styles.discountBadge}>
                                    {faDigits(product.discountPercent)}٪ تخفیف
                                </span>
                            </p>
                            <p className={styles.priceSaving}>
                                {faGrouped(tomanFromRial(saving))} تومان سود شما
                            </p>

                            <p className={styles.durationRow}>
                                <CalendarCheck
                                    size={15}
                                    className={styles.durationIcon}
                                    aria-hidden="true"
                                />
                                مدت اشتراک: {faDigits(product.entitlementDays)} روز
                                {perDay > 0 && ` · روزی ${faGrouped(perDay)} تومان`}
                            </p>

                            <ul className={styles.features}>
                                {copy.features.map((feature) => {
                                    const Icon = FEATURE_ICONS[feature.icon]
                                    return (
                                        <li key={feature.label} className={styles.feature}>
                                            <Icon
                                                size={16}
                                                className={styles.featureIcon}
                                                aria-hidden="true"
                                            />
                                            <span>
                                                {renderFeatureLabel(
                                                    feature.label,
                                                    quota.months,
                                                )}
                                            </span>
                                        </li>
                                    )
                                })}
                            </ul>

                            {/* سهمیه‌ی هوشمند — مهم‌ترین تفاوت عددی بین پلن‌ها */}
                            <div className={styles.quotaBox}>
                                <p className={styles.quotaValue}>
                                    {faGrouped(quota.analyze)} تحلیل هوشمند
                                    <span className={styles.quotaPlus}> + </span>
                                    {faGrouped(quota.plan)} برنامه‌ریزی هوشمند
                                </p>
                                <p className={styles.quotaScope}>
                                    در {faDigits(quota.months)} دورهٔ ۳۰ روزه
                                </p>
                                {copy.note !== undefined && (
                                    <p className={styles.quotaNote}>{copy.note}</p>
                                )}
                            </div>

                            <div className={styles.cta}>
                                {/* مهمان: `/subscription` عمومی می‌ماند، پس به‌جای دکمه‌ی
                                    خریدِ همیشه‌۴۰۱، مستقیم به ورود هدایت می‌شود. */}
                                {user === null ? (
                                    <Link
                                        href="/auth/login"
                                        className="dp-btn dp-btn-premium dp-btn-block"
                                    >
                                        <Sparkles size={16} aria-hidden="true" />
                                        ورود و خرید
                                    </Link>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => void handleBuy(product.code)}
                                        disabled={blocked}
                                        className="dp-btn dp-btn-premium dp-btn-block"
                                    >
                                        {busy ? (
                                            <>
                                                <Loader2
                                                    size={16}
                                                    className={styles.spinner}
                                                    aria-hidden="true"
                                                />
                                                در حال اتصال به درگاه
                                            </>
                                        ) : (
                                            <>
                                                <Sparkles size={16} aria-hidden="true" />
                                                {copy.cta}
                                            </>
                                        )}
                                    </button>
                                )}
                            </div>
                        </section>
                    )
                })}
            </div>

            {error !== null && (
                <p role="alert" className={styles.errorText}>
                    {error}
                </p>
            )}
        </div>
    )
}