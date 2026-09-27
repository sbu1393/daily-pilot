import type { Metadata } from "next"
import { HelpCircle } from "lucide-react"
import Header from "@/app/components/Header"
import Footer from "@/app/components/layout/Footer"
import FaqAccordion from "@/app/components/faq/FaqAccordion"
import { FAQ_ITEMS } from "@/app/lib/faqContent"
import { faDigits } from "@/app/lib/time"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import type { AvatarUser } from "@/app/components/Avatar"
import styles from "@/app/components/layout/infoPage.module.css"

/**
 * صفحهٔ «پرسش‌های متداول»
 * ---------------------------------------------------------------
 * مسیر `/faq` همان چیزی است که فوتر از قبل به آن لینک می‌دهد؛ پس این صفحه
 * آن لینکِ از پیش موجود را واقعی می‌کند و convention مسیرهای انگلیسیِ پروژه
 * (`/dashboard`, `/subscription`, `/auth/login`) حفظ می‌شود.
 *
 * چرا Server Component؟ محتوا ایستاست و به داده‌ای نیاز ندارد ⇒ بدون
 * جاواوایپریشن در بارگذاری اول. تنها بخش تعاملی، آکاردئون است که خودش یک
 * Client Component کوچک است.
 *
 * metadata جداگانه (نه inherited) تا هر صفحه title/description خودش را داشته
 * باشد — همان الگوی `not-found.tsx`.
 */
export const metadata: Metadata = {
    title: "پرسش‌های متداول | روزساز",
    description:
        "راهنمای کار با روزساز: ثبت و ویرایش کار، دسته‌بندی و دستهٔ سفارشی، برنامه‌ریزی روزانه، یادآوری و کار کردن در حالت آفلاین.",
}

async function getLandingUser(): Promise<AvatarUser | null> {
    try {
        return await getCurrentUser()
    } catch {
        return null
    }
}

export default async function FaqPage() {
    const user = await getLandingUser()

    return (
        <div className={styles.page}>
            <Header user={user} />

            <main className={styles.inner}>
                <section className={styles.hero}>
                    <span className={styles.eyebrow}>
                        <HelpCircle size={14} aria-hidden="true" />
                        راهنمای استفاده
                    </span>
                    <h1 className={styles.heroTitle}>پرسش‌های متداول</h1>
                    <p className={styles.heroLead}>
                        پاسخ کوتاه و کاربردی به {faDigits(FAQ_ITEMS.length)} پرسش پرتکرار
                        دربارهٔ ثبت کار، دسته‌بندی، برنامه‌ریزی روزانه و کار کردن با روزساز.
                    </p>
                </section>

                <div className={styles.card}>
                    <FaqAccordion />
                </div>
            </main>

            <Footer />
        </div>
    )
}
