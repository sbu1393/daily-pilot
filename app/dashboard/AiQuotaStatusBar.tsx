"use client"

import Link from "next/link"
import { motion } from "framer-motion"

import { useAiQuota } from "@/app/hooks/useAiQuota"
import { describeQuotaDimension, type AiQuotaDimensionView } from "./aiQuotaView"
import styles from "./dashboard.module.css"

/**
 * نوار وضعیت سهمیهٔ AI — فقط اطلاع‌رسانی.
 *
 * تصمیم‌های عمدیِ این کامپوننت:
 *   • **بدون نوار پیشرفت، بدون countdown، بدون badge تشویقی.** هیچ عنصر بصری‌ای که
 *     «مصرف کن» را القا کند وجود ندارد — فقط واقعیتِ عدد.
 *   • **معنی وابسته به رنگ نیست.** هر سه حالت متنِ کامل و متفاوت دارند، پس کسی که
 *     رنگ نمی‌بیند هم همان اطلاعات را می‌گیرد.
 *   • **CTA تهاجمی ندارد.** وقتی سهمیه تمام شد فقط یک لینک آرام به صفحهٔ اشتراکِ
 *     موجود محصول می‌دهیم؛ هیچ پیام فشار یا پیشنهاد خرید جدیدی ساخته نمی‌شود.
 *   • عددها از `GET /api/ai/quota` می‌آیند؛ اینجا هیچ محاسبهٔ quota صورت نمی‌گیرد.
 */
export default function AiQuotaStatusBar() {
    const { status } = useAiQuota()

    // وضعیت نامعلوم (بارگذاری اولیه یا خطای endpoint) → چیزی نشان نمی‌دهیم.
    // بهتر است هیچ چیز نباشد تا عددِ گمراه‌کننده.
    if (!status) return null

    const views: AiQuotaDimensionView[] = [
        describeQuotaDimension("analyze", status.analyze),
        describeQuotaDimension("plan", status.plan),
    ]

    const anyExhausted = views.some((v) => v.tone === "exhausted")

    return (
        <motion.section
            className={styles.quotaPanel}
            // تغییر عدد بعد از هر عملیات AI باید بی‌صدا اعلام شود، نه اینکه
            // کاربر متوجه نشود و عدد کهنه را مبنا بگیرد.
            role="status"
            aria-live="polite"
            aria-label="وضعیت سهمیهٔ هوش مصنوعی این دوره"
        >
            <div className={styles.quotaPanelHead}>سهمیهٔ هوش مصنوعی این دوره</div>

            <ul className={styles.quotaList}>
                {views.map((view) => (
                    <li key={view.key} className={styles.quotaItem} data-tone={view.tone}>
                        {/* متن کامل، مستقل از رنگ — screen reader همین را می‌خواند. */}
                        <span className={styles.quotaText} aria-label={view.ariaLabel}>
                            {view.text}
                        </span>
                        {view.promoHint && (
                            <span className={styles.quotaPromo}>{view.promoHint}</span>
                        )}
                    </li>
                ))}
            </ul>

            {anyExhausted && (
                <Link href="/subscription" className={styles.quotaLink}>
                    مشاهدهٔ اشتراک
                </Link>
            )}
        </motion.section>
    )
}
