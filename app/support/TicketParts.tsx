"use client"

import Link from "next/link"
import { Inbox, Loader2, WifiOff } from "lucide-react"
import styles from "./support.module.css"
import type { TicketPriority, TicketStatus } from "@/app/lib/tickets/ticketTypes"

/*
 * اجزای نمایشیِ کوچک صفحات پشتیبانی (کاربر).
 *
 * فقط چیدمان و حالت‌ها — هیچ منطق داده و هیچ تصمیم امنیتی.
 * معادل‌های مدیریتی این‌ها از قبل در `app/admin/AdminUi.tsx` وجود دارند و برای
 * صفحات /admin استفاده می‌شوند؛ اینجا نسخهٔ هم‌سبک با ماژول CSS بخش کاربر است.
 */

const STATUS_CLASS: Record<TicketStatus, string> = {
    OPEN: styles.chipOpen,
    PENDING: styles.chipPending,
    CLOSED: styles.chipClosed,
}

export function StatusChip({ status, label }: { status: TicketStatus; label: string }) {
    return <span className={`${styles.chip} ${STATUS_CLASS[status]}`}>{label}</span>
}

export function PriorityChip({ priority, label }: { priority: TicketPriority; label: string }) {
    return (
        <span className={`${styles.chip} ${priority === "URGENT" ? styles.chipUrgent : ""}`}>
            اولویت: {label}
        </span>
    )
}

export function TicketLoading({ label = "در حال بارگذاری…" }: { label?: string }) {
    return (
        <div className={styles.stateBox} role="status" aria-live="polite" aria-busy="true">
            <Loader2 size={20} aria-hidden="true" />
            {label}
        </div>
    )
}

export function TicketEmpty({ message }: { message: string }) {
    return (
        <div className={styles.stateBox} role="status">
            <Inbox size={20} aria-hidden="true" />
            {message}
        </div>
    )
}

export function TicketErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
    return (
        <div className={`${styles.stateBox} ${styles.stateBoxError}`} role="alert">
            <WifiOff size={20} aria-hidden="true" />
            <div className={styles.stateTitle}>خطا در دریافت اطلاعات</div>
            <div>{message}</div>
            {onRetry !== undefined && (
                <button type="button" className="dp-btn dp-btn-ghost" onClick={onRetry}>
                    تلاش دوباره
                </button>
            )}
        </div>
    )
}

/** صفحه‌بندی سمت کاربر؛ دکمه‌ها همان `dp-btn` سراسری را می‌گیرند. */
export function TicketPager({
    page,
    pageInfo,
    hasPrev,
    hasNext,
    onPrev,
    onNext,
}: {
    page: number
    pageInfo: string
    hasPrev: boolean
    hasNext: boolean
    onPrev: () => void
    onNext: () => void
}) {
    return (
        <nav className={styles.pagination} aria-label="صفحه‌بندی تیکت‌ها">
            <button type="button" className="dp-btn dp-btn-ghost" onClick={onPrev} disabled={!hasPrev || page <= 1}>
                قبلی
            </button>
            <span className={styles.pageInfo}>{pageInfo}</span>
            <button type="button" className="dp-btn dp-btn-ghost" onClick={onNext} disabled={!hasNext}>
                بعدی
            </button>
        </nav>
    )
}

/** لینک بازگشت — تنها مسیر navigation فهرست ↔ جزئیات. */
export function BackToTicketsLink() {
    return (
        <Link href="/support" className={styles.backLink}>
            ← بازگشت به تیکت‌های من
        </Link>
    )
}
