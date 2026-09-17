"use client"

// فاز ۴ — Step 7: صفحه‌ی /admin/errors — خطاهای عملیاتی (read-only)
//
// منبع داده: GET /api/admin/errors (Step 6) با فیلترهای §10:
//   code, category, severity, endpoint, userId, from, to + page/limit.
// - stack عمداً در قرارداد سرور حذف شده و DTO کلاینت هم ندارد → UI بازسازی نمی‌کند.
// - requestId فقط به‌عنوان correlation نمایش داده می‌شود (همان مقدار امن سرور).
// - هیچ دکمه/اکشن جز pagination و filter وجود ندارد.

import Link from "next/link"
import { useCallback, useMemo, useState } from "react"
import { ShieldAlert } from "lucide-react"
import { fetchAdminErrors } from "@/app/lib/admin/adminClient"
import { useAdminQuery } from "@/app/lib/admin/useAdminQuery"
import {
    buildErrorsPageVM,
    buildErrorsQueryString,
    faDigits,
    formatTimestamp,
} from "@/app/lib/admin/adminViewModels"
import { ADMIN_PAGE_DEFAULT_LIMIT } from "@/app/lib/admin/adminTypes"
import {
    AdminAccessGate,
    AdminEmpty,
    AdminErrorState,
    AdminLoading,
    AdminNavTabs,
    AdminPagination,
    SeverityChip,
} from "../AdminUi"
import styles from "../admin.module.css"

const SEVERITIES = ["", "INFO", "WARNING", "ERROR", "CRITICAL"] as const
const CATEGORIES = [
    "",
    "VALIDATION",
    "AUTHENTICATION",
    "AUTHORIZATION",
    "NOT_FOUND",
    "CONFLICT",
    "RATE_LIMIT",
    "DATABASE",
    "EXTERNAL_SERVICE",
    "BUSINESS_RULE",
    "INTERNAL",
    "UNKNOWN",
] as const

export default function AdminErrorsPage() {
    const [code, setCode] = useState("")
    const [category, setCategory] = useState<string>("")
    const [severity, setSeverity] = useState<string>("")
    const [endpoint, setEndpoint] = useState("")
    const [userId, setUserId] = useState("")
    const [page, setPage] = useState(1)

    const query = useMemo(
        () =>
            buildErrorsQueryString({
                code,
                category,
                severity,
                endpoint,
                userId,
                page,
                limit: ADMIN_PAGE_DEFAULT_LIMIT,
            }),
        [code, category, severity, endpoint, userId, page],
    )

    const fetcher = useCallback((signal: AbortSignal) => fetchAdminErrors(query, signal), [query])
    const { data, loading, error, refetch } = useAdminQuery(query, fetcher)
    const vm = buildErrorsPageVM(data, loading && data === null, error === null ? null : (error?.message ?? null))

    if (error !== null && (error.status === 401 || error.status === 403)) {
        return (
            <div className={styles.page}>
                <PageHead />
                <AdminAccessGate error={`${error.status} ${error.code}`} loading={false} />
            </div>
        )
    }

    return (
        <div className={styles.page}>
            <PageHead />

            <div className={styles.filterBar} role="search" aria-label="فیلتر خطاها">
                <input
                    type="search"
                    className={`${styles.filterInput} ${styles.filterInputSearch}`}
                    value={code}
                    onChange={(e) => {
                        setCode(e.target.value)
                        setPage(1)
                    }}
                    placeholder="کد خطا (مثلاً VALIDATION_ERROR)…"
                    aria-label="فیلتر کد خطا"
                />
                <input
                    type="text"
                    className={`${styles.filterInput} ${styles.filterInputSearch}`}
                    value={endpoint}
                    onChange={(e) => {
                        setEndpoint(e.target.value)
                        setPage(1)
                    }}
                    placeholder="endpoint (مثلاً /api/tasks)"
                    aria-label="فیلتر endpoint"
                    dir="ltr"
                />
                <input
                    type="text"
                    inputMode="numeric"
                    className={styles.filterInput}
                    value={userId}
                    onChange={(e) => {
                        setUserId(e.target.value)
                        setPage(1)
                    }}
                    placeholder="شناسه کاربر"
                    aria-label="فیلتر شناسه کاربر"
                />
                <label className={styles.filterLabel}>
                    شدت
                    <select
                        className={`${styles.filterInput} ${styles.filterSelect}`}
                        value={severity}
                        onChange={(e) => {
                            setSeverity(e.target.value)
                            setPage(1)
                        }}
                        aria-label="فیلتر شدت"
                    >
                        {SEVERITIES.map((s) => (
                            <option key={s} value={s}>
                                {s === "" ? "همه" : s}
                            </option>
                        ))}
                    </select>
                </label>
                <label className={styles.filterLabel}>
                    دسته
                    <select
                        className={`${styles.filterInput} ${styles.filterSelect}`}
                        value={category}
                        onChange={(e) => {
                            setCategory(e.target.value)
                            setPage(1)
                        }}
                        aria-label="فیلتر دسته"
                    >
                        {CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                                {c === "" ? "همه" : c}
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            {vm.status === "loading" && <AdminLoading label="در حال دریافت خطاها…" />}
            {vm.status === "error" && <AdminErrorState message={error?.message ?? "خطای ناشناخته"} onRetry={refetch} />}
            {vm.status === "empty" && <AdminEmpty message="خطایی با این فیلترها ثبت نشده است." />}

            {vm.status === "data" && (
                <section aria-label="فهرست خطاها" className={styles.section}>
                    <p className={styles.statHint}>{faDigits(vm.total)} خطا در پنجره‌ی اخیر (پنجره‌ی پیش‌فرض سرور: ۷ روز)</p>

                    <div className={styles.tableScroll}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th scope="col">شدت</th>
                                    <th scope="col">کد</th>
                                    <th scope="col">دسته</th>
                                    <th scope="col">endpoint</th>
                                    <th scope="col">کاربر</th>
                                    <th scope="col">پیام</th>
                                    <th scope="col">زمان</th>
                                    <th scope="col">correlation</th>
                                </tr>
                            </thead>
                            <tbody>
                                {vm.items.map((log) => (
                                    <tr key={log.id}>
                                        <td><SeverityChip severity={log.severity} /></td>
                                        <td className={styles.mono}>{log.errorCode}</td>
                                        <td>{log.category}</td>
                                        <td dir="ltr" className={styles.mono}>{log.endpoint}</td>
                                        <td>{log.userId === null ? "—" : faDigits(log.userId)}</td>
                                        <td className={styles.cardItemMsg}>{log.message}</td>
                                        <td>{formatTimestamp(log.createdAt)}</td>
                                        <td dir="ltr" className={styles.mono}>{log.requestId ?? "—"}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    <ul className={styles.cardList}>
                        {vm.items.map((log) => (
                            <li key={log.id} className={styles.cardItem}>
                                <div className={styles.cardItemTop}>
                                    <SeverityChip severity={log.severity} />
                                    <span className={styles.mono}>{log.errorCode}</span>
                                </div>
                                <div className={styles.cardItemMeta} dir="ltr">
                                    {log.endpoint}
                                    {log.statusCode > 0 ? ` · HTTP ${log.statusCode}` : ""}
                                    {log.userId !== null ? ` · user ${log.userId}` : ""}
                                </div>
                                <div className={styles.cardItemMsg}>{log.message}</div>
                                <div className={styles.cardItemTop}>
                                    <span className={styles.cardItemMeta}>{formatTimestamp(log.createdAt)}</span>
                                    {log.requestId !== null && (
                                        <span className={styles.mono} dir="ltr">{log.requestId}</span>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>

                    <AdminPagination
                        page={vm.page}
                        totalPages={vm.totalPages}
                        hasPrev={vm.hasPrev}
                        hasNext={vm.hasNext}
                        onPrev={() => setPage((p) => Math.max(1, p - 1))}
                        onNext={() => setPage((p) => p + 1)}
                    />
                </section>
            )}
        </div>
    )
}

function PageHead() {
    return (
        <header className={styles.pageHead}>
            <div>
                <h1 className={styles.pageTitle}>
                    <ShieldAlert size={18} aria-hidden="true" style={{ verticalAlign: "-3px" }} /> خطاهای عملیاتی
                </h1>
                <p className={styles.pageSub}>
                    گزارش read-only خطاها — بدون stack و داده‌ی حساس (redaction سرور حفظ شده است).
                </p>
            </div>
            <div className={styles.headSpacer} />
            <AdminNavTabs active="/admin/errors" />
            <Link href="/admin" className="dp-btn dp-btn-ghost">
                نمای کلی
            </Link>
        </header>
    )
}
