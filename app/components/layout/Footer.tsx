import Link from "next/link"
import { Mail, MessageCircle, Send } from "lucide-react"
import Logo from "../Logo"
import { getCanonicalDayKey } from "@/app/lib/canonicalDay"
import { canonicalKeyToJalali } from "@/app/components/calender/jalaliDate"
import { faDigits } from "@/app/lib/time"
import styles from "./footer.module.css"

/* ------------------------------------------------------------------ */
/* نماد اعتماد الکترونیکی (اینماد)                                     */
/*                                                                     */
/* «شناسه» و «کد» را از پنل اینماد بردار و همین‌جا جای‌گذاری کن.          */
/*                                                                     */
/* نکته: در snippet اصلی اینماد، همان Code در هر دو آدرس (href و src)   */
/* تکرار می‌شود؛ بنابراین یک بار تعریف شده تا امکان واگرایی نباشد.        */
/* ------------------------------------------------------------------ */
const ENAMAD_ID = "7839480"
const ENAMAD_CODE = "GAPGPTMASKTOKENayd6z95tcd5X0X"

const ENAMAD_URL = `https://trustseal.enamad.ir/?id=${ENAMAD_ID}&Code=${ENAMAD_CODE}`
const ENAMAD_LOGO_URL = `https://trustseal.enamad.ir/logo.aspx?id=${ENAMAD_ID}&Code=${ENAMAD_CODE}`

const TELEGRAM_URL = "https://t.me/rouzsaz"
const BALE_URL = "https://ble.ir/rouzsaz"
const SUPPORT_EMAIL = "info@rouzsaz.ir"

/** مرجع زمانیِ سالِ کپی‌رایت — تقویم شمسی برای کاربران فارسی‌زبان. */
const COPYRIGHT_TIMEZONE = "Asia/Tehran"

/**
 * برچسب سال شمسی (مثلاً «۱۴۰۵») برای خط کپی‌رایت.
 *
 * چرا با timezone؟ تبدیل «الان» به سال شمسی با timezone محلیِ سرور (که در
 * production معمولاً UTC است) در شبِ نوروز چند ساعت عقب می‌افتد؛ پس روزِ canonical
 * تهران گرفته و بعد به جلالی تبدیل می‌شود — دقیقاً با همان helperهای فاز G-02.
 *
 * تقویم جلالی فقط لایه‌ی نمایش است و هیچ‌جا ذخیره نمی‌شود (§6.3.1).
 */
function jalaliYearLabel(now: Date = new Date()): string {
    const todayKey = getCanonicalDayKey(now, COPYRIGHT_TIMEZONE)
    return faDigits(canonicalKeyToJalali(todayKey).year)
}

/**
 * فوتر عمومی سایت.
 *
 * چیدمان RTL از `dir="rtl"` روی <html> ارث می‌برد (app/layout.tsx)؛ پس در
 * گرید، ستون اول (برند) سمت راست، ستون دوم وسط و ستون سوم سمت چپ می‌نشیند.
 *
 * استایل از توکن‌های دیزاین `app/globals.css` می‌آید (هم‌راستا با لندینگ و
 * سازگار با تم روشن/تیره)؛ Tailwind در این پروژه نصب نیست.
 */
export default function Footer() {
    return (
        <footer className={styles.footer}>
            <div className={styles.inner}>
                {/* ---------- ستون راست: برند، شعار و شبکه‌های اجتماعی ---------- */}
                <div className={styles.brandColumn}>
                    <Link href="/" className={styles.brandLink} aria-label="روزساز — صفحه اصلی">
                        <Logo size={30} />
                    </Link>

                    <p className={styles.tagline}>
                        دستیار هوش مصنوعی برای برنامه‌ریزی روزانه، یادآوری و مدیریت کارها
                    </p>

                    <h2 className={styles.socialTitle}>روزساز رو دنبال کن</h2>
                    <div className={styles.socials}>
                        <a
                            href={TELEGRAM_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={styles.social}
                        >
                            <Send size={17} aria-hidden="true" />
                            <span>تلگرام</span>
                        </a>
                        <a
                            href={BALE_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={styles.social}
                        >
                            <MessageCircle size={17} aria-hidden="true" />
                            <span>بله</span>
                        </a>
                    </div>
                </div>

                {/* ---------- ستون میانی: درباره روزساز ---------- */}
                <nav className={styles.column} aria-labelledby="footer-about-title">
                    <h2 id="footer-about-title" className={styles.columnTitle}>
                        روزساز
                    </h2>
                    <ul className={styles.links}>
                        <li>
                            <Link href="/about" className={styles.link}>
                                چرا روزساز
                            </Link>
                        </li>
                        <li>
                            <Link href="/faq" className={styles.link}>
                                پرسش‌های پرتکرار
                            </Link>
                        </li>
                    </ul>
                </nav>

                {/* ---------- ستون چپ: قوانین، پشتیبانی و نماد اعتماد ---------- */}
                <nav className={styles.column} aria-labelledby="footer-legal-title">
                    <h2 id="footer-legal-title" className={styles.columnTitle}>
                        قوانین و پشتیبانی
                    </h2>
                    <ul className={styles.links}>
                        <li>
                            <Link href="/privacy" className={styles.link}>
                                سیاست حریم خصوصی
                            </Link>
                        </li>
                        <li>
                            <a href={`mailto:${SUPPORT_EMAIL}`} className={styles.link}>
                                <Mail size={15} aria-hidden="true" />
                                <span dir="ltr" className={styles.email}>
                                    {SUPPORT_EMAIL}
                                </span>
                            </a>
                        </li>
                    </ul>

                    {/* نماد اعتماد الکترونیکی — همان اسنیپت اینماد، ولی به شکل معتبر JSX
                        (`referrerpolicy` → `referrerPolicy`) تا هشدار React/lint ندهد */}
                    <div className={styles.seal}>
                        <a
                            href={ENAMAD_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            referrerPolicy="origin"
                            className={styles.sealLink}
                            aria-label="نماد اعتماد الکترونیکی روزساز"
                        >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={ENAMAD_LOGO_URL}
                                alt="اینماد روزساز"
                                width={110}
                                height={120}
                                referrerPolicy="origin"
                                className={styles.sealImg}
                            />
                        </a>
                    </div>
                </nav>
            </div>

            {/* ---------- نوار پایین ---------- */}
            <div className={styles.bottomBar}>
                <p className={styles.copyright}>
                    © {jalaliYearLabel()} تمامی حقوق برای روزساز محفوظ است.
                </p>
            </div>
        </footer>
    )
}
