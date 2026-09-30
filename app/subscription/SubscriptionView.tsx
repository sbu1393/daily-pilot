"use client"

// صفحه اشتراک — طراحی نمایشی (Static)؛ اتصال به درگاه زرین‌پال بعداً اضافه می‌شود.
//
// ظاهر: توکن‌های دیزاین سیستم در globals.css + کلاس‌های این ماژول.
// دکمه‌های «خرید» و «پلن فعلی» از primitives مشترک پروژه استفاده می‌کنند
// (dp-btn / dp-btn-premium / dp-btn-ghost / dp-btn-block) تا با بقیهٔ اپ یکدست بماند.
//
// بخش کد هدیه (PromoRedeemBox) از داشبورد به این‌جا منتقل شده تا داشبورد خلوت
// بماند؛ `user` از سرور می‌آید و فقط برای کاربر احراز‌شده رندر می‌شود.

import Link from "next/link"
import { ArrowRight, Check, Crown, Sparkles } from "lucide-react"
import { faDigits } from "@/app/lib/time"
import PromoRedeemBox from "./PromoRedeemBox"
import styles from "./subscription.module.css"

interface PlanCard {
    title: string
    price: string
    period: string
    features: string[]
    highlight?: boolean
}

const plans: PlanCard[] = [
    {
        title: "رایگان",
        price: "۰",
        period: "همیشه",
        features: [
            "تا ۱۰ کار روزانه",
            "برنامه‌ریزی هوشمند پایه",
            "تقویم شمسی",
        ],
    },
    {
        title: "اشتراک ۱ ماهه",
        price: `${faDigits(30000)} تومان`,
        period: "۳۰ روز",
        features: [
            "کارهای نامحدود روزانه",
            "برنامه‌ریزی هوشمند پیشرفته",
            "تحلیل و اولویت‌بندی AI",
            "پشتیبانی اولویت‌دار",
        ],
        highlight: true,
    },
    {
        title: "اشتراک ۲ ماهه",
        price: `${faDigits(50000)} تومان`,
        period: "۶۰ روز",
        features: [
            "تمام امکانات پلن ۱ ماهه",
            "صرفه‌جویی ۱۰ هزار تومان",
            "پشتیبانی اولویت‌دار",
        ],
    },
]

export default function SubscriptionView({ user }: { user: { id: number } | null }) {
    const handleBuy = () => {
        alert("درگاه پرداخت در حال آماده‌سازی است")
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
                {plans.map((plan) => (
                    <section
                        key={plan.title}
                        className={
                            plan.highlight ? `${styles.card} ${styles.cardFeatured}` : styles.card
                        }
                    >
                        {plan.highlight && (
                            <span className={styles.badge}>
                                <Sparkles size={12} aria-hidden="true" />
                                پیشنهادی
                            </span>
                        )}

                        <h2 className={styles.cardTitle}>{plan.title}</h2>

                        <div className={styles.priceRow}>
                            <span className={styles.priceValue}>{plan.price}</span>
                            <span className={styles.pricePeriod}>{plan.period}</span>
                        </div>

                        <ul className={styles.features}>
                            {plan.features.map((feature) => (
                                <li key={feature} className={styles.feature}>
                                    <Check
                                        size={16}
                                        className={plan.highlight ? styles.checkGold : styles.check}
                                        aria-hidden="true"
                                    />
                                    <span>{feature}</span>
                                </li>
                            ))}
                        </ul>

                        <div className={styles.cta}>
                            {plan.price === "۰" ? (
                                <Link
                                    href="/dashboard"
                                    className="dp-btn dp-btn-ghost dp-btn-block"
                                >
                                    پلن فعلی
                                </Link>
                            ) : (
                                <button
                                    type="button"
                                    onClick={handleBuy}
                                    className="dp-btn dp-btn-premium dp-btn-block"
                                >
                                    <Sparkles size={16} aria-hidden="true" />
                                    خرید
                                </button>
                            )}
                        </div>
                    </section>
                ))}
            </div>
        </div>
    )
}
