import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeft, CalendarCheck, Compass, ListTodo, Sparkles, Wand2 } from "lucide-react"
import Header from "@/app/components/Header"
import Footer from "@/app/components/layout/Footer"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import type { AvatarUser } from "@/app/components/Avatar"
import styles from "@/app/components/layout/infoPage.module.css"

/**
 * صفحهٔ «چرا روزساز؟»
 * ---------------------------------------------------------------
 * مسیر `/about` همان چیزی است که فوتر از قبل به آن لینک می‌دهد؛ این صفحه آن
 * لینکِ از پیش موجود را واقعی می‌کند و در کنار صفحهٔ `/faq` قرار می‌گیرد.
 *
 * این صفحه FAQ نیست: توضیح می‌دهد روزساز چه مسئله‌ای را حل می‌کند و مراحل
 * استفاده از آن چیست. لحن عمداً بدون ادعای آماری یا تبلیغاتی است — فقط
 * چیزی که در خودِ محصول پیاده شده.
 *
 * Server Component: محتوا ایستاست؛ تنها تعامل لازم (رفتن به برنامه) با
 * `Link` است و نیازی به جاواوایپریشن ندارد.
 */
export const metadata: Metadata = {
    title: "چرا روزساز؟ | روزساز",
    description:
        "روزسان چیست، برای چه کسی ساخته شده و چطور با ثبت کار، دسته‌بندی و برنامه‌ریزی روزانه، روز منظم‌تری داشته باشی.",
}

/** مراحل استفاده — داده در همین فایل است چون فقط همین صفحه مصرفش می‌کند. */
const STEPS = [
    {
        title: "کارهایت را ثبت کن",
        text: "هر کار را با عنوان روشن و روزِ مورد نظر وارد کن. لازم نیست از همان اول زمان دقیق بدهی.",
    },
    {
        title: "کارها را دسته‌بندی کن",
        text: "برای هر کار یک دسته انتخاب کن — از دسته‌های آماده یا یک دستهٔ سفارشی با نام و آیکن خودت.",
    },
    {
        title: "زمان هر کار را مشخص کن",
        text: "برای هر کار زمان تقریبی می‌دهی تا بدانی انجامش چقدر طول می‌کشد. این عدد پایهٔ برنامه‌ریزی است.",
    },
    {
        title: "برنامهٔ روزانه را بررسی کن",
        text: "با دکمهٔ «ایجاد برنامه»، روزساز کارهای بازِ آن روز را با توجه به بودجهٔ زمانی‌ات بین روز پخش می‌کند. پیش‌نویس را می‌بینی و خودت تأیید می‌کنی.",
    },
    {
        title: "وضعیت کارها را به‌روز نگه دار",
        text: "هنگام انجام هر کار، آن را تمام کن و زمان واقعی صرف‌شده را ثبت کن تا فاصلهٔ تخمین و واقعیت روشن بماند.",
    },
]

async function getLandingUser(): Promise<AvatarUser | null> {
    try {
        return await getCurrentUser()
    } catch {
        return null
    }
}

export default async function AboutPage() {
    const user = await getLandingUser()

    return (
        <div className={styles.page}>
            <Header user={user} />

            <main className={styles.inner}>
                {/* ---------- Hero ---------- */}
                <section className={styles.hero}>
                    <span className={styles.eyebrow}>
                        <Compass size={14} aria-hidden="true" />
                        دربارهٔ محصول
                    </span>
                    <h1 className={styles.heroTitle}>چرا روزساز؟</h1>
                    <p className={styles.heroLead}>
                        روزرسان برای وقتی ساخته شده که کارهایت زیادند اما روز شلوغ، آشفته و بدون
                        ترتیب پیش می‌رود. ایده ساده است: کارهایت را یک‌جا جمع کن و برای هر روز، زمان
                        و ترتیبِ مشخص بگیر.
                    </p>
                </section>

                {/* ---------- روزساز چیست؟ ---------- */}
                <section className={styles.card} aria-labelledby="about-what">
                    <h2 className={styles.sectionTitle} id="about-what">
                        <Sparkles aria-hidden="true" />
                        روزساز چیست؟
                    </h2>
                    <p className={styles.sectionBody}>
                        روزساز یک دستیار برنامه‌ریزی روزانه است. کارهایت را ثبت می‌کنی و
                        دسته‌بندی می‌کنی، برای هر کار زمان تقریبی می‌گذاری و بعد روزساز نگاه
                        می‌کند که در یک روز چه کارهایی باز مانده‌اند و با توجه به وقتی که در
                        دسترس داری، بینشان تقسیم می‌کند.
                    </p>
                    <p className={styles.sectionBody}>
                        نکتهٔ اصلی این است که روزساز خودش تصمیم نهایی را نمی‌گیرد. برنامه را
                        می‌سازد، اما این تو هستی که آن را می‌بینی، تأیید می‌کنی و اگر خواستی
                        تغییرش می‌دهی. اولویت و امتیاز هر کار هم پیشنهاد هوش مصنوعی است و
                        در همان قالبی که خودت انتخاب کرده‌ای باقی می‌ماند.
                    </p>
                </section>

                {/* ---------- چطور استفاده کنیم ---------- */}
                <section className={styles.card} aria-labelledby="about-how">
                    <h2 className={styles.sectionTitle} id="about-how">
                        <ListTodo aria-hidden="true" />
                        چطور از روزساز استفاده کنیم؟
                    </h2>
                    <ol className={styles.steps}>
                        {STEPS.map((step, index) => (
                            <li className={styles.step} key={step.title}>
                                <span className={styles.stepNumber} aria-hidden="true">
                                    {index + 1}
                                </span>
                                <div className={styles.stepBody}>
                                    <h3 className={styles.stepTitle}>{step.title}</h3>
                                    <p className={styles.stepText}>{step.text}</p>
                                </div>
                            </li>
                        ))}
                    </ol>
                </section>

                {/* ---------- برای یک روز منظم‌تر ---------- */}
                <section className={styles.card} aria-labelledby="about-regular">
                    <h2 className={styles.sectionTitle} id="about-regular">
                        <CalendarCheck aria-hidden="true" />
                        برای یک روز منظم‌تر
                    </h2>
                    <p className={styles.sectionBody}>
                        مشکل رایج این نیست که کارها کم باشند؛ این است که در یک لحظه ندانیم
                        الان کدام‌ها مانده‌اند و کدام‌ها را باید بسپاریم. روزساز کارهای هر روز را
                        کنار هم می‌گذارد و نشان می‌دهد از وقتی که داری، چند دقیقه سهم هر کار
                        گرفته شده است.
                    </p>
                    <p className={styles.sectionBody}>
                        نتیجه این است که به‌جای حدس زدن، می‌بینی. می‌دانی کدام کار عقب افتاده،
                        کدام یک هنوز برنامه‌ریزی نشده و وقتت نسبت به کارهایت چه وضعیتی دارد.
                        اگر کاری را در روز انجام ندادی، فردا به‌عنوان کار عقب‌افتاده به تو
                        نشان داده می‌شود تا خودت تصمیم بگیری منتقل شود یا نه.
                    </p>
                </section>

                {/* ---------- CTA ---------- */}
                <section className={styles.cta}>
                    <h2 className={styles.ctaTitle}>از کجا شروع کنم؟</h2>
                    <p className={styles.ctaText}>
                        کافی است اولین کارت را ثبت کنی. دسته‌بندی و برنامه‌ریزی بعد از آن
                        قدم بعدی هستند، نه پیش‌نیازِ شروع.
                    </p>
                    <div className={styles.ctaActions}>
                        <Link href={user ? "/dashboard" : "/auth/register"} className={styles.primaryBtn}>
                            <Wand2 size={17} aria-hidden="true" />
                            {user ? "ساخت اولین کار" : "ساخت حساب و شروع"}
                        </Link>
                        <Link href="/faq" className={styles.ghostBtn}>
                            <ArrowLeft size={17} aria-hidden="true" />
                            پرسش‌های متداول
                        </Link>
                    </div>
                </section>
            </main>

            <Footer />
        </div>
    )
}
