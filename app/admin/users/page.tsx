"use client"

// فاز ۴ — Step 7: صفحه‌ی /admin/users — فهرست کاربران (read-only)
//
// منبع داده: GET /api/admin/users (Step 6).
// - ordering را UI override نمی‌کند: پیش‌فرض API «id DESC» پذیرفته می‌شود.
// - limit هرگز بیشتر از 100 ارسال نمی‌شود (clamp در buildUsersQueryString).
// - email فقط به‌صورت emailMasked (خروجی سرور) نمایش داده می‌شود — هیچ unmask نیست.
// - فقط لینک به /admin/users/[id]؛ هیچ دکمه/فرم تغییر وضعیت وجود ندارد.

import Link from "next/link"
import { useCallback, useMemo, useState } from "react"
import { ChevronLeft, Search, UserRound } from "lucide-react"
import { fetchAdminUsers } from "@/app/lib/admin/adminClient"
import { useAdminQuery } from "@/app/lib/admin/useAdminQuery"
import {
    buildUsersPageVM,
    buildUsersQueryString,
    faDigits,
    formatTimestamp,
    planLabel,
    roleLabel,
} from "@/app/lib/admin/adminViewModels"
import { ADMIN_PAGE_DEFAULT_LIMIT } from "@/app/lib/admin/adminTypes"
import {
    AdminAccessGate,
    AdminEmpty,
    AdminErrorState,
    AdminLoading,
    AdminNavTabs,
    AdminPagination,
    UsersFilterBar,
} from "../AdminUi"
import styles from "../admin.module.css"

type PlanFilter = "" | "FREE" | "PRO"
type RoleFilter = "" | "USER" | "ADMIN"

export default function AdminUsersPage() {
    const [search, setSearch] = useState("")
    const [plan, setPlan] = useState<PlanFilter>("")
    const [role, setRole] = useState<RoleFilter>("")
    const [page, setPage] = useState(1)

    const query = useMemo(
        () => buildUsersQueryString({ q: search, plan, role, page, limit: ADMIN_PAGE_DEFAULT_LIMIT }),
        [search, plan, role, page],
    )

    const fetcher = useCallback((signal: AbortSignal) => fetchAdminUsers(query, signal), [query])
    const { data, loading, error, refetch } = useAdminQuery(query === "" ? "users:idle" : query, fetcher, {
        enabled: true,
    })
    const vm = buildUsersPageVM(data, loading && data === null, error === null ? null : errorMessage(error))

    if (error !== null && (error.status === 401 || error.status === 403)) {
        return (
            <div className={styles.page}>
                <PageHead />
                <UsersFilterBar
                    search={search}
                    onSearchChange={setSearch}
                    plan={plan}
                    onPlanChange={(v) => setPlan(v as PlanFilter)}
                    role={role}
                    onRoleChange={(v) => setRole(v as RoleFilter)}
                />
                <AdminAccessGate error={`${error.status} ${error.code}`} loading={false} />
            </div>
        )
    }

    return (
        <div className={styles.page}>
            <PageHead />
            <UsersFilterBar
                search={search}
                onSearchChange={setSearch}
                plan={plan}
                onPlanChange={(v) => setPlan(v as PlanFilter)}
                role={role}
                onRoleChange={(v) => setRole(v as RoleFilter)}
            />

            {vm.status === "loading" && <AdminLoading label="در حال دریافت فهرست کاربران…" />}
            {vm.status === "error" && <AdminErrorState message={error?.message ?? "خطای ناشناخته"} onRetry={refetch} />}
            {vm.status === "empty" && <AdminEmpty message="کاربری با این مشخصات پیدا نشد." />}

            {vm.status === "data" && (
                <section aria-label="فهرست کاربران" className={styles.section}>
                    {/* جدول — دسکتاپ */}
                    <div className={styles.tableScroll}>
                        <table className={styles.table}>
                            <caption className={styles.statHint}>
                                {faDigits(vm.total)} کاربر — مرتب‌سازی پیش‌فرض سرور (id نزولی)
                            </caption>
                            <thead>
                                <tr>
                                    <th scope="col">شناسه</th>
                                    <th scope="col">نام کاربری</th>
                                    <th scope="col">ایمیل (ماسک‌شده)</th>
                                    <th scope="col">نقش</th>
                                    <th scope="col">طرح</th>
                                    <th scope="col">آخرین فعالیت</th>
                                    <th scope="col"><span className="sr-only">جزئیات</span></th>
                                </tr>
                            </thead>
                            <tbody>
                                {vm.items.map((user) => (
                                    <tr key={user.id}>
                                        <td>{faDigits(user.id)}</td>
                                        <td>
                                            <Link href={`/admin/users/${user.id}`} className={styles.rowLink}>
                                                <UserRound size={13} aria-hidden="true" /> {user.username}
                                            </Link>
                                        </td>
                                        <td dir="ltr" className={styles.mono}>{user.emailMasked}</td>
                                        <td>
                                            <span className={`${styles.chip} ${user.role === "ADMIN" ? styles.chipRoleAdmin : ""}`}>
                                                {roleLabel(user.role)}
                                            </span>
                                        </td>
                                        <td>
                                            <span className={`${styles.chip} ${user.plan === "PRO" ? styles.chipPlanPro : ""}`}>
                                                {planLabel(user.plan)}
                                            </span>
                                        </td>
                                        <td>{formatTimestamp(user.lastSeenAt)}</td>
                                        <td>
                                            <Link href={`/admin/users/${user.id}`} className={styles.rowLink} aria-label={`جزئیات کاربر ${user.username}`}>
                                                جزئیات <ChevronLeft size={13} aria-hidden="true" />
                                            </Link>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {/* کارت‌ها — موبایل */}
                    <ul className={styles.cardList}>
                        {vm.items.map((user) => (
                            <li key={user.id} className={styles.cardItem}>
                                <div className={styles.cardItemTop}>
                                    <span className={styles.cardItemTitle}>{user.username}</span>
                                    <span dir="ltr" className={styles.mono}>{user.emailMasked}</span>
                                </div>
                                <div className={styles.cardItemTop}>
                                    <span className={`${styles.chip} ${user.role === "ADMIN" ? styles.chipRoleAdmin : ""}`}>
                                        {roleLabel(user.role)}
                                    </span>
                                    <span className={`${styles.chip} ${user.plan === "PRO" ? styles.chipPlanPro : ""}`}>
                                        {planLabel(user.plan)}
                                    </span>
                                </div>
                                <div className={styles.cardItemMeta}>
                                    شناسه {faDigits(user.id)} — آخرین فعالیت: {formatTimestamp(user.lastSeenAt)}
                                </div>
                                <Link href={`/admin/users/${user.id}`} className={styles.rowLink} aria-label={`جزئیات کاربر ${user.username}`}>
                                    مشاهده جزئیات <ChevronLeft size={13} aria-hidden="true" />
                                </Link>
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

function errorMessage(error: { message: string } | null): string | null {
    return error === null ? null : error.message
}

function PageHead() {
    return (
        <header className={styles.pageHead}>
            <div>
                <h1 className={styles.pageTitle}>کاربران</h1>
                <p className={styles.pageSub}>فهرست read-only کاربران — جستجو بر اساس شناسه/ایمیل دقیق/پیشوند نام کاربری.</p>
            </div>
            <div className={styles.headSpacer} />
            <AdminNavTabs active="/admin/users" />
        </header>
    )
}
