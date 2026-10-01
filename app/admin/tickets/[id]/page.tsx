"use client"

import { useCallback, useMemo, useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"

import {
    fetchAdminTicket,
    replyAdminTicket,
    toAdminErrorMessage,
    updateAdminTicket,
} from "@/app/lib/admin/adminClient"
import { useAdminQuery } from "@/app/lib/admin/useAdminQuery"
import { faDigits, formatTimestamp } from "@/app/lib/admin/adminViewModels"
import {
    TICKET_BODY_MAX,
    TICKET_CATEGORY_LABELS,
    TICKET_CATEGORY_OPTIONS,
    TICKET_MESSAGE_PAGE_LIMIT,
    TICKET_PRIORITY_LABELS,
    TICKET_STATUS_LABELS,
    TICKET_STATUS_OPTIONS,
    TICKET_STAFF_PRIORITY_OPTIONS,
    buildMessageThreadLabel,
    buildStaffTicketUpdatePayload,
    buildTicketMessages,
    buildTicketMessagesQuery,
    buildTicketPagination,
    ticketCategoryLabel,
    ticketPriorityLabel,
    ticketStatusHint,
    ticketStatusLabel,
} from "@/app/lib/tickets/ticketViewModels"
import type { TicketCategoryKey, TicketPriority, TicketStatus } from "@/app/lib/tickets/ticketTypes"
import {
    AdminAccessGate,
    AdminEmpty,
    AdminErrorState,
    AdminLoading,
    AdminNavTabs,
    AdminPagination,
} from "../../AdminUi"
import styles from "../../admin.module.css"

/*
 * T5 — /admin/tickets/[id] — جزئیات تیکت برای کارمند
 *
 * منابع داده (همه از مسیر admin):
 *   GET  /api/admin/tickets/[id]
 *   PATCH /api/admin/tickets/[id]
 *   POST /api/admin/tickets/[id]/messages
 *
 * دربارهٔ گذار وضعیت: اینجا **هیچ قاعده‌ای دربارهٔ اینکه کدام status مجاز است
 * نوشته نشده**. کنترل‌ها همیشه همهٔ گزینه‌ها را نشان می‌دهند و اگر API گذار را
 * رد کند (`TICKET_INVALID_TRANSITION` → ۴۰۹) پیامش نمایش داده می‌شود. قاعده در
 * سرویس است، نه در UI — تنها استثنا غیرفعال‌کردن دکمهٔ ارسال هنگام درخواست
 * در حال اجراست (جلوگیری از double submit) و پنهان‌کردن composer روی تیکت
 * بسته که صرفاً presentation است.
 *
 * صفحه‌بندی گفتگو (R1): `messagesPage` یک state محلی است که به query واقعی
 * endpoint تبدیل می‌شود (همان الگوی صف تیکت‌ها). شمارشِ «n پیام در این تیکت» از
 * `messagePage.total` می‌آید (کلِ گفتگو)، نه از طولِ آرایهٔ پیام‌های همین صفحه.
 */

export default function AdminTicketDetailPage() {
    const params = useParams<{ id: string }>()
    const ticketId = params?.id ?? ""

    const [draft, setDraft] = useState("")
    const [busy, setBusy] = useState<"reply" | "save" | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [actionError, setActionError] = useState<string | null>(null)
    const [messagesPage, setMessagesPage] = useState(1)

    const query = useMemo(
        () => buildTicketMessagesQuery({ page: messagesPage, limit: TICKET_MESSAGE_PAGE_LIMIT }),
        [messagesPage],
    )

    const fetcher = useCallback(
        (signal: AbortSignal) => fetchAdminTicket(ticketId, query, signal),
        [ticketId, query],
    )
    const { data, loading, error, refetch } = useAdminQuery(`admin-ticket:${ticketId}?${query}`, fetcher)

    const reply = async (e: React.FormEvent) => {
        e.preventDefault()
        if (busy !== null) return
        setNotice(null)
        setActionError(null)
        setBusy("reply")
        try {
            await replyAdminTicket(ticketId, draft.trim())
            setDraft("")
            setNotice("پاسخ شما ثبت شد")
            refetch()
        } catch (err) {
            setActionError(toAdminErrorMessage(err))
        } finally {
            setBusy(null)
        }
    }

    const save = async (next: {
        status?: TicketStatus
        priority?: TicketPriority
        category?: TicketCategoryKey | null
    }) => {
        if (busy !== null) return
        setNotice(null)
        setActionError(null)
        setBusy("save")
        try {
            await updateAdminTicket(ticketId, buildStaffTicketUpdatePayload(next))
            setNotice("تیکت به‌روزرسانی شد")
            refetch()
        } catch (err) {
            setActionError(toAdminErrorMessage(err))
        } finally {
            setBusy(null)
        }
    }

    if (error !== null && (error.status === 401 || error.status === 403)) {
        return (
            <div className={styles.page}>
                <PageHead />
                <AdminAccessGate error={`${error.status} ${error.code}`} loading={false} />
            </div>
        )
    }

    const ticket = data?.ticket ?? null
    const messages = ticket !== null ? buildTicketMessages(ticket.messages) : []
    const pagination = buildTicketPagination(
        data?.messagePage.page ?? messagesPage,
        data?.messagePage.limit ?? TICKET_MESSAGE_PAGE_LIMIT,
        data?.messagePage.total ?? 0,
        data?.messagePage.hasMore ?? false,
    )

    return (
        <div className={styles.page}>
            <PageHead />

            <Link href="/admin/tickets" className={styles.statHint}>
                ← بازگشت به صف تیکت‌ها
            </Link>

            {loading && data === null && <AdminLoading label="در حال دریافت تیکت…" />}
            {error !== null && (
                <AdminErrorState message={toAdminErrorMessage(error)} onRetry={refetch} />
            )}
            {/* «بدون پیام» فقط وقتی درست است که کلِ گفتگو خالی باشد، نه وقتی که
                صفحهٔ جاری خالی است (R1: هر دو حالت ممکن‌اند). */}
            {data !== null && ticket !== null && data.messagePage.total === 0 && (
                <AdminEmpty message="برای این تیکت هنوز پیامی ثبت نشده است." />
            )}

            {data !== null && ticket !== null && (
                <>
                    <section className={styles.section} aria-label="مشخصات تیکت">
                        <dl className={styles.defList}>
                            <dt>موضوع</dt>
                            <dd>{ticket.subject}</dd>
                            <dt>کاربر</dt>
                            <dd className={styles.mono} dir="ltr">
                                {ticket.userId}
                            </dd>
                            <dt>وضعیت</dt>
                            <dd>
                                {ticketStatusLabel(ticket.status)} — {ticketStatusHint(ticket.status, "staff")}
                            </dd>
                            <dt>اولویت</dt>
                            <dd>{ticketPriorityLabel(ticket.priority)}</dd>
                            <dt>دسته‌بندی</dt>
                            <dd>{ticketCategoryLabel(ticket.category)}</dd>
                            <dt>ثبت‌شده</dt>
                            <dd>{formatTimestamp(ticket.createdAt)}</dd>
                            {ticket.closedAt !== null && (
                                <>
                                    <dt>بسته‌شده</dt>
                                    <dd>{formatTimestamp(ticket.closedAt)}</dd>
                                </>
                            )}
                        </dl>
                    </section>

                    {notice !== null && <p className={styles.statHint}>{notice}</p>}
                    {actionError !== null && (
                        <div className={`${styles.stateBox} ${styles.stateBoxError}`} role="alert">
                            {actionError}
                        </div>
                    )}

                    <section className={styles.section} aria-label="مدیریت تیکت">
                        <div className={styles.filterBar}>
                            <label className={styles.filterLabel} htmlFor="admin-ticket-status">
                                وضعیت
                            </label>
                            <select
                                id="admin-ticket-status"
                                className={styles.filterSelect}
                                value={ticket.status}
                                disabled={busy !== null}
                                onChange={(e) => void save({ status: e.target.value as TicketStatus })}
                            >
                                {TICKET_STATUS_OPTIONS.map((option) => (
                                    <option key={option} value={option}>
                                        {TICKET_STATUS_LABELS[option]}
                                    </option>
                                ))}
                            </select>

                            <label className={styles.filterLabel} htmlFor="admin-ticket-priority">
                                اولویت
                            </label>
                            <select
                                id="admin-ticket-priority"
                                className={styles.filterSelect}
                                value={ticket.priority}
                                disabled={busy !== null}
                                onChange={(e) => void save({ priority: e.target.value as TicketPriority })}
                            >
                                {/* کارمند کل واژگان اولویت را می‌بیند، شامل URGENT */}
                                {TICKET_STAFF_PRIORITY_OPTIONS.map((option) => (
                                    <option key={option} value={option}>
                                        {TICKET_PRIORITY_LABELS[option]}
                                    </option>
                                ))}
                            </select>

                            <label className={styles.filterLabel} htmlFor="admin-ticket-category">
                                دسته‌بندی
                            </label>
                            <select
                                id="admin-ticket-category"
                                className={styles.filterSelect}
                                value={ticket.category ?? ""}
                                disabled={busy !== null}
                                onChange={(e) => {
                                    const value = e.target.value
                                    void save({ category: value === "" ? null : (value as TicketCategoryKey) })
                                }}
                            >
                                <option value="">بدون دسته‌بندی</option>
                                {TICKET_CATEGORY_OPTIONS.map((option) => (
                                    <option key={option} value={option}>
                                        {TICKET_CATEGORY_LABELS[option]}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <p className={styles.statHint}>
                            {faDigits(data.messagePage.total)} پیام در این تیکت
                        </p>
                    </section>

                    <section className={styles.section} aria-label="گفتگو">
                        <p className={styles.statHint}>
                            {buildMessageThreadLabel(
                                data.messagePage.page,
                                data.messagePage.limit,
                                data.messagePage.total,
                            )}
                        </p>
                        <ul className={styles.cardList}>
                            {messages.map((message) => (
                                <li key={message.id} className={styles.cardItem}>
                                    <div className={styles.cardItemTop}>
                                        <span className={styles.cardItemTitle}>
                                            {message.authorLabel}
                                        </span>
                                        <span className={styles.cardItemMeta}>{message.timeLabel ?? ""}</span>
                                    </div>
                                    <div className={styles.cardItemMsg}>{message.body}</div>
                                </li>
                            ))}
                        </ul>

                        <AdminPagination
                            page={pagination.page}
                            totalPages={pagination.totalPages}
                            hasPrev={pagination.hasPrev}
                            hasNext={pagination.hasNext}
                            onPrev={() => setMessagesPage((p) => Math.max(1, p - 1))}
                            onNext={() => setMessagesPage((p) => p + 1)}
                        />

                        {ticket.status === "CLOSED" ? (
                            <p className={styles.statHint}>
                                این تیکت بسته شده است؛ ارسال پیام در API رد می‌شود.
                            </p>
                        ) : (
                            <form className={styles.filterBar} onSubmit={reply}>
                                <label className={styles.filterLabel} htmlFor="admin-ticket-reply">
                                    پاسخ کارمند
                                </label>
                                <textarea
                                    id="admin-ticket-reply"
                                    className={styles.filterInput}
                                    maxLength={TICKET_BODY_MAX}
                                    rows={3}
                                    value={draft}
                                    onChange={(e) => setDraft(e.target.value)}
                                />
                                <button
                                    type="submit"
                                    className="dp-btn dp-btn-primary"
                                    disabled={busy !== null || draft.trim().length === 0}
                                >
                                    {busy === "reply" ? "در حال ارسال…" : "ارسال پاسخ"}
                                </button>
                            </form>
                        )}
                    </section>
                </>
            )}
        </div>
    )
}

function PageHead() {
    return (
        <header className={styles.pageHead}>
            <div>
                <h1 className={styles.pageTitle}>جزئیات تیکت</h1>
                <p className={styles.pageSub}>
                    پاسخ کارمند با نقش `ADMIN` ثبت می‌شود و تاریخچهٔ گفتگو حفظ می‌شود.
                </p>
            </div>
            <div className={styles.headSpacer} />
            <AdminNavTabs active="/admin/tickets" />
        </header>
    )
}
