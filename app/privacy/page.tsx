import type { Metadata } from "next"
import Link from "next/link"
import { Mail, ShieldCheck } from "lucide-react"
import Header from "@/app/components/Header"
import Footer from "@/app/components/layout/Footer"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import type { AvatarUser } from "@/app/components/Avatar"
import styles from "@/app/components/privacy/privacy.module.css"
import {
    BRAND,
    CONTACT_LINKS,
    LAST_UPDATED,
    PRIVACY_SECTIONS,
    SUPPORT_EMAIL,
    type PrivacyBlock,
} from "@/app/lib/privacyContent"

/**
 * صفحهٔ «سیاست حریم خصوصی» (/privacy)
 * ------------------------------------------------------------------
 * فوتر از قبل به این مسیر لینک می‌دهد ولی صفحه وجود نداشت (۴۰۴). این صفحه
 * آن لینک را واقعی می‌کند و در کنار صفحه‌های `/faq` و `/about` می‌نشیند.
 *
 * محتوا از `app/lib/privacyContent.ts` می‌آید — همان ماژولی که متن خلاصه‌ی
 * تب «حریم خصوصی» در تنظیمات هم از آن می‌خواند. آن فایل عمداً خالص و بدون
 * React است تا در محیط node (که این پروژه jsdom ندارد) مستقیم تست شود؛
 * به همین دلیل رندر بلوک‌ها این‌جا و با یک تابع کوچک انجام می‌شود.
 *
 * لحن عمداً بدون ادعای حقوقی یا فنیِ تأییدنشده است — فقط چیزی که در
 * پیاده‌سازی فعلی وجود دارد.
 *
 * Server Component: محتوا ایستاست و هیچ تعاملی ندارد.
 */
export const metadata: Metadata = {
    title: `سیاست حریم خصوصی | ${BRAND}`,
    description: `این صفحه توضیح می‌دهد ${BRAND} چه اطلاعاتی نگه می‌دارد، چرا آن را نگه می‌دارد و چه سرویس‌های شخص ثالثی در ارائهٔ سرویس نقش دارند.`,
}

/** رندر یک بلوک محتوا (پاراگراف یا فهرست). کلید `i` از index می‌آید. */
function renderBlock(block: PrivacyBlock, key: string) {
    if (block.kind === "p") {
        return (
            <p key={key} className={styles.paragraph}>
                {block.text}
            </p>
        )
    }
    return (
        <ul key={key} className={styles.list}>
            {block.items.map((item) => (
                <li key={item}>{item}</li>
            ))}
        </ul>
    )
}

/**
 * کاربر اختیاری است — اگر جلسه خوانده نشد صفحه نباید خطا بدهد (همان الگوی
 * صفحه‌های `/faq` و `/about`).
 */
async function getLandingUser(): Promise<AvatarUser | null> {
    try {
        return await getCurrentUser()
    } catch {
        return null
    }
}

export default async function PrivacyPage() {
    const user = await getLandingUser()

    // بخش تماس جدا رندر می‌شود تا لینک‌های واقعی و قابل کلیک باشند؛
    // بقیهٔ متن کاملاً از ماژول محتوا می‌آید.
    const sections = PRIVACY_SECTIONS.filter((section) => section.id !== "contact")

    return (
        <div className={styles.page}>
            <Header user={user} />

            <main className={styles.inner}>
                <header className={styles.hero}>
                    <span className={styles.eyebrow}>
                        <ShieldCheck size={15} aria-hidden="true" />
                        سیاست حریم خصوصی
                    </span>
                    <h1 className={styles.heroTitle}>سیاست حریم خصوصی {BRAND}</h1>
                    <p className={styles.heroLead}>
                        این متن دقیقاً بر اساس سرویسی نوشته شده که امروز در دسترس است؛
                        می‌گوید چه داده‌ای نگه داشته می‌شود، چرا، و چه کسی ممکن است
                        به آن دسترسی داشته باشد.
                    </p>
                    <p className={styles.footNote}>آخرین به‌روزرسانی: {LAST_UPDATED}</p>
                </header>

                <nav className={styles.toc} aria-label="فهرست مطالب سیاست">
                    <h2 className={styles.tocTitle}>در این صفحه</h2>
                    <ul className={styles.tocGrid}>
                        {PRIVACY_SECTIONS.map((section) => (
                            <li key={section.id}>
                                <a href={`#${section.id}`} className={styles.tocLink}>
                                    {section.title}
                                </a>
                            </li>
                        ))}
                    </ul>
                </nav>

                {sections.map((section) => (
                    <section
                        key={section.id}
                        id={section.id}
                        className={styles.section}
                        aria-labelledby={`${section.id}-title`}
                    >
                        <h2 id={`${section.id}-title`} className={styles.sectionTitle}>
                            {section.title}
                        </h2>
                        {section.blocks.map((block, i) => renderBlock(block, `${section.id}-${i}`))}
                    </section>
                ))}

                {/* ---------- تماس با ما ---------- */}
                <section
                    id="contact"
                    className={styles.section}
                    aria-labelledby="contact-title"
                >
                    <h2 id="contact-title" className={styles.sectionTitle}>
                        تماس با ما
                    </h2>
                    <p className={styles.paragraph}>
                        برای هر سؤال، درخواست یا گزارشی دربارهٔ داده‌هایتان از این راه‌ها
                        با ما در تماس باشید. برای پیگیری درخواست‌های مربوط به حریم خصوصی،
                        لطفاً از ایمیل استفاده کنید تا پاسخ قابل پیگیری بماند.
                    </p>
                    <div className={styles.contactCard}>
                        <ul className={styles.contactList}>
                            <li>
                                <a href={`mailto:${SUPPORT_EMAIL}`} className={styles.contactLink}>
                                    <Mail size={15} aria-hidden="true" />
                                    <span dir="ltr">{SUPPORT_EMAIL}</span>
                                </a>
                            </li>
                            {CONTACT_LINKS.map((link) => (
                                <li key={link.href}>
                                    <a
                                        href={link.href}
                                        className={styles.contactLink}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        {link.label}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </div>
                </section>

                <p className={styles.footNote}>
                    برای آشنایی با خود سرویس،{" "}
                    <Link href="/about">چرا روزشاز؟</Link> و{" "}
                    <Link href="/faq">پرسش‌های متداول</Link> را ببینید.
                </p>
            </main>

            <Footer />
        </div>
    )
}
