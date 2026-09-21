import Link from "next/link"
import { ArrowLeft, FileQuestion, MessageCircleQuestion } from "lucide-react"
import styles from "./not-found.module.css"

export const metadata = {
    title: "صفحه‌ی مورد نظر یافت نشد | روزساز",
    description:
        "صفحه‌ای که دنبالش بودی پیدا نشد — شاید جابه‌جا شده، یا هرگز وجود نداشته. اینجا به جای سر یا راه حل در می‌رسه کنیم.",
}

/**
 * صفحه‌ی خطای ۴۰۴ — هرگاه Next.js یک مسیر پذیرفته‌شده نبیند، این کامپوننت
 * در جای خود اجرا می‌شود (حتی اگر fallback هدر نه).
 *
 * چرا سطح اپ؟
 * - استایل روی توکن‌های دیزاین پروژه (app/globals.css) بنا شده تا با لندینگ
 *   و بقیه‌ی اپ یکدست بماند. Tailwind در این پروژه نصب نیست، پس به جای آن
 *   CSS Module نوشته شد تا واقعاً دیده شود.
 * - سبک-surround (هدر/فوتر) عمداً ندارد؛ در صفحه‌ی خطا کاربر فقط به فعلو بند
 *   چسبد، نه یه لایه‌ی داد و بیداد.
 * - تم روشن/تاره از توکن‌ها می‌آید.
 */
export default function NotFound() {
    return (
        <main className={styles.page}>
            <figure className={styles.card} aria-labelledby="nf-code">
                <span className={styles.code} aria-hidden="true">۴۰۴</span>
                <figcaption className={styles.title} id="nf-code">
                    <h1>صفحه‌ی مورد نظر پیدا نشد</h1>
                </figcaption>
                <p className={styles.lead}>
                    احتمالاً این صفحه جابه‌جا شده، نامتغیر شده یا دست‌نخورده از
                    اول وجود نداشته. هرچند، نمی‌خوای بیدار باشی؟
                </p>

                <div className={styles.quickLinks}>
                    <p className={styles.quickTitle}>از کجا بریم؟</p>
                    <div className={styles.row}>
                        <Link href="/" className={`${styles.action} ${styles.primary}`}>
                            <ArrowLeft size={16} aria-hidden="true" />
                            بازگشت به صفحه‌ی اصلی
                        </Link>
                        <Link href="/faq" className={styles.action}>
                            <FileQuestion size={16} aria-hidden="true" />
                            پرسش‌های پرتکرار
                        </Link>
                        <Link href="/contact" className={styles.action}>
                            <MessageCircleQuestion size={16} aria-hidden="true" />
                            تماس با ما
                        </Link>
                    </div>
                </div>
            </figure>
        </main>
    )
}
