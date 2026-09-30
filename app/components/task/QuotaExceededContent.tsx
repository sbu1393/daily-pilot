"use client"

import Link from "next/link"

import styles from "./task.module.css"

// QuotaExceededContent — محتوای مشترکِ «سهمیهٔ هوش مصنوعی تمام شد».
//
// عمداً یک **content** است، نه مودال: تا بتوان آن را داخل همان AnimatedModalای
// که بالاتر باز است (مثل ReanalyzeModal) رندر کرد و هیچ مودال تو‌در‌تویی نساخت.
// پوستهٔ مودال جداگانه در QuotaExceededModal است.
//
// متن ثابت و مستقل از پیام سرور است؛ تصمیم‌گیری بر اساس code انجام می‌شود، نه متن.

export const QUOTA_EXCEEDED_MESSAGE =
    "سهمیه هوش مصنوعی شما برای این ماه به پایان رسیده است. برای دریافت سهمیه بیشتر، حساب کاربری خود را به حساب ویژه ارتقا دهید."

export default function QuotaExceededContent({ onClose }: { onClose: () => void }) {
    return (
        <div role="dialog" aria-modal="true" aria-label="سهمیه هوش مصنوعی شما تمام شده است">
            <div className={styles.modalHead}>
                <h4>سهمیه هوش مصنوعی شما تمام شده است</h4>
                <button className={styles.closeBtn} onClick={onClose} aria-label="بستن">
                    ✕
                </button>
            </div>

            <p className={styles.hint}>{QUOTA_EXCEEDED_MESSAGE}</p>

            <div className={styles.modalActions}>
                <Link href="/subscription" className={styles.btnPrimary}>
                    ارتقا به حساب ویژه
                </Link>
                <button className={styles.btnGhost} onClick={onClose}>
                    بستن
                </button>
            </div>
        </div>
    )
}
