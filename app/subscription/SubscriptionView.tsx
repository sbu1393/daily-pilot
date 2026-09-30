"use client"

// صفحه اشتراک — سه محصول اشتراکی، همه از کاتالوگ سروری.
//
// نکته‌ی اصلی: هیچ عددی (قیمت پایه، تخفیف، قیمت نهایی، مدت) در این فایل hard-code نشده —
// همه از `BILLING_PRODUCTS` در `app/lib/billing/products.ts` می‌آیند، همان ماژولی که سرور
// مبلغ و مدت را از آن snapshot می‌کند. پس آنچه کاربر می‌بیند و آنچه درگاه می‌گیرد از یک منبع.
//
// واحد: کاتالوگ ریال (IRR) است؛ فقط برای نمایش به تومان تبدیل می‌شود (`tomanFromRial`) که
// یک تبدیل نمایشی است و هیچ نقشی در مبلغ پرداختی ندارد.
//
// خرید: `POST /api/billing/checkout` با بدنه‌ی `{ productCode }` و یک هدر `Idempotency-Key`
// تازه برای هر تلاش (کلید شامل کد محصول است تا replay با محصول دیگر اشتباه نشود). بعد از
// موفقیت، کاربر به `redirectUrl` درگاه هدایت می‌شود.
//
// بخش کد هدیه (PromoRedeemBox) دست‌نخورده باقی مانده است.

import { useState } from "react"
import Link from "next/link"
import { ArrowRight, Check, Crown, Loader2, Sparkles } from "lucide-react"

import { api, ApiClientError } from "@/app/lib/api/client"
import { BILLING_PRODUCTS, tomanFromRial, type ProductCode } from "@/app/lib/billing/products"
import { faDigits } from "@/app/lib/time"
import PromoRedeemBox from "./PromoRedeemBox"
import styles from "./subscription.module.css"

interface ProductCopy {
    title: string
    features: string[]
}

/**
 * متن و ویژگی‌های نمایشی هر محصول. عمداً فقط «متن» است: هر عددی (قیمت/تخفیف/مدت) از
 * کاتالوگ می‌آید تا UI و بیلینگ هرگز دو نسخه‌ی متفاوت از حقیقت نداشته باشند.
 *
 * عمداً هیچ محصولی «پیشنهادی/برنده» برجسته نمی‌شود (نه badge و نه استایل ویژه): تصمیم
 * تجاریِ برجسته‌کردن یک گزینه باید آگاهانه و جدا از منطق قیمت باشد.
 */
const COPY: Record<ProductCode, ProductCopy> = {
    PRO_1M: {
        title: "اشتراک ماهانه",
        features: [
            "کارهای نامحدود روزانه",
            "برنامه‌ریزی هوشمند پیشرفته",
            "تحلیل و اولویت‌بندی AI",
            "پشتیبانی اولویت‌دار",
        ],
    },
    PRO_2M: {
        title: "اشتراک دوماهه",
        features: [
            "تمام امکانات اشتراک ماهانه",
            "پشتیبانی اولویت‌دار",
            "بهره‌ی کامل از دوره‌ی دوم",
        ],
    },
    PRO_3M: {
        title: "اشتراک سه‌ماهه",
        features: [
            "تمام امکانات اشتراک ماهانه",
            "بیشترین مدت با همان تخفیف",
            "پشتیبانی اولویت‌دار",
        ],
    },
}

const FREE_PLAN = {
    title: "رایگان",
    price: "۰",
    period: "همیشه",
    features: ["تا ۱۰ کار روزانه", "برنامه‌ریزی هوشمند پایه", "تقویم شمسی"],
}

/** پاسخ checkout — فقط همان چیزهایی که route مجاز به برگرداندن است. */
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
                    // کلید تازه در هر تلاش؛ کد محصول داخل کلید هست تا اگر کاربر محصول عوض
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
                {/* مسیر برگشت — این صفحه `layout.tsx` ندارد، پس نه `Header` و نه
                    `AppShell` روی آن رندر نمی‌شود و بدون این دکمه تنها راه خروج،
                    لینکِ «پلن فعلی» داخل کارت پلن است که برچسبش ناوبری را توصیف
                    نمی‌کند. مقصد عمداً ثابت است (`/dashboard`): کاربر از داشبورد،
                    نوار سهمیه یا مودال سهمیه می‌آید، و صفحه ممکن است مستقیم در PWA
                    هم باز شود — پس به حدس‌زدن از `history` نیازی نیست. */}
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
                {/* پلن رایگان — محصول قابل خرید نیست و از کاتالوگ نمی‌آید (قیمت همیشه صفر). */}
                <section className={styles.card}>
                    <h2 className={styles.cardTitle}>{FREE_PLAN.title}</h2>

                    <div className={styles.priceRow}>
                        <span className={styles.priceValue}>{FREE_PLAN.price}</span>
                        <span className={styles.pricePeriod}>{FREE_PLAN.period}</span>
                    </div>

                    <ul className={styles.features}>
                        {FREE_PLAN.features.map((feature) => (
                            <li key={feature} className={styles.feature}>
                                <Check size={16} className={styles.check} aria-hidden="true" />
                                <span>{feature}</span>
                            </li>
                        ))}
                    </ul>

                    <div className={styles.cta}>
                        <Link href="/dashboard" className="dp-btn dp-btn-ghost dp-btn-block">
                            پلن فعلی
                        </Link>
                    </div>
                </section>

                {/* سه محصول اشتراکی — همه‌ی اعداد از کاتالوگ، بدون hard-code */}
                {BILLING_PRODUCTS.map((product) => {
                    const copy = COPY[product.code]
                    const busy = pending === product.code
                    const blocked = pending !== null && !busy
                    const saving = product.baseAmount - product.amount

                    return (
                        <section key={product.code} className={styles.card}>
                            <h2 className={styles.cardTitle}>{copy.title}</h2>

                            <div className={styles.priceRow}>
                                <span className={styles.priceValue}>
                                    {faDigits(tomanFromRial(product.amount))}
                                    <span className={styles.priceUnit}> تومان</span>
                                </span>
                            </div>

                            {/* قیمت پایه (خط‌خورده) + درصد تخفیف — فقط نمایشی؛
                                مبلغ قابل پرداخت همان `product.amount` است. */}
                            <p className={styles.priceMeta}>
                                <span className={styles.priceBase}>
                                    {faDigits(tomanFromRial(product.baseAmount))} تومان
                                </span>
                                <span className={styles.discountBadge}>
                                    {faDigits(product.discountPercent)}٪ تخفیف
                                </span>
                                <span className={styles.priceSaving}>
                                    سود شما {faDigits(tomanFromRial(saving))} تومان
                                </span>
                            </p>

                            <p className={styles.pricePeriod}>
                                مدت اشتراک: {faDigits(product.entitlementDays)} روز
                            </p>

                            <ul className={styles.features}>
                                {copy.features.map((feature) => (
                                    <li key={feature} className={styles.feature}>
                                        <Check
                                            size={16}
                                            className={styles.check}
                                            aria-hidden="true"
                                        />
                                        <span>{feature}</span>
                                    </li>
                                ))}
                            </ul>

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
                                                خرید
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