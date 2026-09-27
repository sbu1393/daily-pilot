"use client"

// صفحه اشتراک — طراحی نمایشی (Static)؛ اتصال به درگاه زرین‌پال بعداً اضافه می‌شود.
//
// ظاهر: توکن‌های دیزاین سیستم در globals.css + کلاس‌های این ماژول.
// دکمه‌های «خرید» و «پلن فعلی» از primitives مشترک پروژه استفاده می‌کنند
// (dp-btn / dp-btn-premium / dp-btn-ghost / dp-btn-block) تا با بقیهٔ اپ یکدست بماند.

import Link from "next/link"
import { Check, Crown, Sparkles } from "lucide-react"
import { faDigits } from "@/app/lib/time"
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

export default function SubscriptionPage() {
    const handleBuy = () => {
        alert("درگاه پرداخت در حال آماده‌سازی است")
    }

    return (
        <div className={styles.page}>
            <header className={styles.head}>
                <h1 className={styles.title}>
                    <Crown className={styles.titleIcon} size={28} aria-hidden="true" />
                    اشتراک ویژه
                </h1>
                <p className={styles.subtitle}>
                    ارتقا بده و بدون محدودیت روزت را بساز
                </p>
            </header>

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
