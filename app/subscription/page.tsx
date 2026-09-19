"use client"

// صفحه اشتراک — طراحی نمایشی (Static)؛ اتصال به درگاه زرین‌پال بعداً اضافه می‌شود.

import Link from "next/link"
import { Check, Crown } from "lucide-react"
import { faDigits } from "@/app/lib/time"

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
        <div className="max-w-5xl mx-auto px-4 py-8">
            <header className="text-center mb-10">
                <h1 className="text-2xl font-extrabold text-[var(--ink)] flex items-center justify-center gap-2">
                    <Crown className="text-amber-500" size={28} aria-hidden="true" />
                    اشتراک ویژه
                </h1>
                <p className="mt-2 text-[var(--muted)] text-sm">
                    ارتقا بده و بدون محدودیت روزت را بساز
                </p>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {plans.map((plan) => (
                    <section
                        key={plan.title}
                        className={`rounded-2xl border p-6 flex flex-col gap-4 shadow-md bg-[var(--surface)] ${
                            plan.highlight
                                ? "border-amber-400 ring-2 ring-amber-300 relative"
                                : "border-[var(--border)]"
                        }`}
                    >
                        {plan.highlight && (
                            <span className="absolute -top-3 right-4 bg-amber-400 text-white text-xs font-bold px-3 py-1 rounded-full shadow">
                                پیشنهاد ویژه
                            </span>
                        )}
                        <h2 className="text-lg font-extrabold text-[var(--ink)]">{plan.title}</h2>
                        <div>
                            <span className="text-2xl font-extrabold text-[var(--ink)]">
                                {plan.price}
                            </span>
                            <span className="block text-xs text-[var(--muted)] mt-1">
                                {plan.period}
                            </span>
                        </div>
                        <ul className="flex flex-col gap-2 text-sm text-[var(--ink-2)]">
                            {plan.features.map((feature) => (
                                <li key={feature} className="flex items-center gap-2">
                                    <Check size={16} className="text-amber-500 shrink-0" aria-hidden="true" />
                                    {feature}
                                </li>
                            ))}
                        </ul>
                        {plan.price === "۰" ? (
                            <Link
                                href="/dashboard"
                                className="mt-auto text-center bg-[var(--surface-solid)] border-2 border-[var(--border)] text-[var(--ink-2)] font-bold py-2 px-4 rounded-lg hover:border-[var(--primary)] transition"
                            >
                                پلن فعلی
                            </Link>
                        ) : (
                            <button
                                type="button"
                                onClick={handleBuy}
                                className="mt-auto bg-amber-400 hover:bg-amber-500 text-white font-bold py-2 px-4 rounded-lg shadow-md transition"
                            >
                                خرید
                            </button>
                        )}
                    </section>
                ))}
            </div>
        </div>
    )
}
