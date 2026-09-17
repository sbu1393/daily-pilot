"use client"

// فاز ۴ — Step 7: اجزای نمایشی کوچک مشترک صفحات Admin
//
// فقط چیدمان/حالت‌ها؛ هیچ منطق داده یا امنیتی اینجا نیست.
// منطق تصمیم در adminViewModels.ts (pure) است و تست‌ها همان را پوشش می‌دهند.

import Link from "next/link"
import { ChevronLeft, ChevronRight, Inbox, Loader2, ShieldAlert, WifiOff } from "lucide-react"
import styles from "./admin.module.css"
import { accessMessage, faDigits, resolveAccessStatus, severityTone } from "@/app/lib/admin/adminViewModels"
import type { AdminAccessStatus } from "@/app/lib/admin/adminViewModels"

// ---------- هدر صفحه + تب‌های ناوبری ----------

const NAV_TABS = [
    { href: "/admin", label: "نمای کلی" },
    { href: "/admin/users", label: "کاربران" },
    { href: "/admin/errors", label: "خطاها" },
] as const

export function AdminNavTabs({ active }: { active: "/admin" | "/admin/users" | "/admin/errors" }) {
    return (
        <nav className={styles.navTabs} aria-label="ناوبری بخش مدیریت">
            {NAV_TABS.map((tab) => (
                <Link
                    key={tab.href}
                    href={tab.href}
                    className={`${styles.navTab} ${active === tab.href ? styles.navTabActive : ""}`}
                    aria-current={active === tab.href ? "page" : undefined}
                >
                    {tab.label}
                </Link>
            ))}
        </nav>
    )
}

// ---------- کارت آمار ----------

export function AdminStatCard({
    label,
    value,
    hint,
    icon,
}: {
    label: string
    value: string
    hint?: string
    icon?: React.ReactNode
}) {
    return (
        <div className={styles.statCard}>
            <div className={styles.statHead}>
                {icon}
                {label}
            </div>
            <div className={styles.statValue}>{value}</div>
            {hint !== undefined && <div className={styles.statHint}>{hint}</div>}
        </div>
    )
}

// ---------- دروازه‌ی دسترسی (فقط UX — امنیت server-side است) ----------

export function AdminAccessGate({ error, loading }: { error: string | null; loading: boolean }) {
    const status: AdminAccessStatus = resolveAccessStatus(error, loading)
    if (status === "allowed" || status === "checking") return null

    const isAuth = status === "unauthenticated"
    return (
        <div className={`${styles.stateBox} ${styles.stateBoxError}`} role="alert">
            <ShieldAlert size={22} aria-hidden="true" />
            <div className={styles.stateTitle}>{accessMessage(status)}</div>
            <Link href={isAuth ? "/auth/login" : "/dashboard"} className="dp-btn dp-btn-primary">
                {isAuth ? "ورود به حساب" : "بازگشت به داشبورد"}
            </Link>
        </div>
    )
}

// ---------- حالت‌های loading / empty / error ----------

export function AdminLoading({ label = "در حال بارگذاری…" }: { label?: string }) {
    return (
        <div className={styles.stateBox} role="status" aria-live="polite" aria-busy="true">
            <Loader2 size={20} className={styles.spin} aria-hidden="true" />
            {label}
            <span className={`${styles.skeleton} ${styles.skeletonWide}`} />
        </div>
    )
}

export function AdminEmpty({ message }: { message: string }) {
    return (
        <div className={styles.stateBox} role="status">
            <Inbox size={20} aria-hidden="true" />
            {message}
        </div>
    )
}

export function AdminErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
    return (
        <div className={`${styles.stateBox} ${styles.stateBoxError}`} role="alert">
            <WifiOff size={20} aria-hidden="true" />
            <div className={styles.stateTitle}>خطا در دریافت داده</div>
            <div>{message}</div>
            {onRetry !== undefined && (
                <button type="button" className="dp-btn dp-btn-ghost" onClick={onRetry}>
                    تلاش دوباره
                </button>
            )}
        </div>
    )
}

// ---------- pagination ----------

export function AdminPagination({
    page,
    totalPages,
    hasPrev,
    hasNext,
    onPrev,
    onNext,
}: {
    page: number
    totalPages: number
    hasPrev: boolean
    hasNext: boolean
    onPrev: () => void
    onNext: () => void
}) {
    return (
        <nav className={styles.pagination} aria-label="صفحه‌بندی">
            <button type="button" className={styles.pageBtn} onClick={onPrev} disabled={!hasPrev}>
                <ChevronRight size={14} aria-hidden="true" /> قبلی
            </button>
            <span className={styles.pageInfo}>
                صفحه‌ی {faDigits(page)} از {faDigits(totalPages)}
            </span>
            <button type="button" className={styles.pageBtn} onClick={onNext} disabled={!hasNext}>
                بعدی <ChevronLeft size={14} aria-hidden="true" />
            </button>
        </nav>
    )
}

// ---------- نوار فیلتر کاربران (جستجو/طرح/نقش) ----------

export function UsersFilterBar({
    search,
    onSearchChange,
    plan,
    onPlanChange,
    role,
    onRoleChange,
}: {
    search: string
    onSearchChange: (v: string) => void
    plan: string
    onPlanChange: (v: string) => void
    role: string
    onRoleChange: (v: string) => void
}) {
    return (
        <div className={styles.filterBar} role="search">
            <input
                type="search"
                className={`${styles.filterInput} ${styles.filterInputSearch}`}
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="جستجو: شناسه، ایمیل یا نام کاربری…"
                aria-label="جستجوی کاربر"
            />
            <label className={styles.filterLabel}>
                طرح
                <select
                    className={`${styles.filterInput} ${styles.filterSelect}`}
                    value={plan}
                    onChange={(e) => onPlanChange(e.target.value)}
                    aria-label="فیلتر طرح"
                >
                    <option value="">همه</option>
                    <option value="FREE">رایگان</option>
                    <option value="PRO">حرفه‌ای</option>
                </select>
            </label>
            <label className={styles.filterLabel}>
                نقش
                <select
                    className={`${styles.filterInput} ${styles.filterSelect}`}
                    value={role}
                    onChange={(e) => onRoleChange(e.target.value)}
                    aria-label="فیلتر نقش"
                >
                    <option value="">همه</option>
                    <option value="USER">کاربر</option>
                    <option value="ADMIN">مدیر</option>
                </select>
            </label>
        </div>
    )
}

// ---------- chipها ----------

export function SeverityChip({ severity }: { severity: string }) {
    const tone = severityTone(severity)
    const cls =
        tone === "critical"
            ? styles.chipCritical
            : tone === "error"
              ? styles.chipError
              : tone === "warning"
                ? styles.chipWarning
                : tone === "info"
                  ? styles.chipInfo
                  : ""
    return (
        <span className={`${styles.chip} ${cls}`}>
            <span aria-hidden="true">●</span> {severity}
        </span>
    )
}
