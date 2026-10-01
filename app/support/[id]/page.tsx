"use client"

import { useCallback, useMemo, useState } from "react"
import { useParams } from "next/navigation"
import { toast } from "react-toastify"

import { useTicketQuery } from "@/app/hooks/useTicketQuery"
import {
    fetchTicket,
    sendTicketMessage,
    updateTicket,
} from "@/app/lib/tickets/ticketClient"
import {
    TICKET_BODY_MAX,
    TICKET_CATEGORY_LABELS,
    TICKET_CATEGORY_OPTIONS,
    TICKET_MESSAGE_PAGE_LIMIT,
    TICKET_PRIORITY_LABELS,
    TICKET_USER_PRIORITY_OPTIONS,
    buildMessageThreadLabel,
    buildTicketMessagePayload,
    buildTicketMessages,
    buildTicketMessagesQuery,
    buildTicketPagination,
    buildUserTicketUpdatePayload,
    canReplyToTicket,
    formatTicketTime,
    isRetryableTicketError,
    ticketCategoryLabel,
    ticketErrorMessage,
    ticketPriorityLabel,
    ticketStatusHint,
    ticketStatusLabel,
} from "@/app/lib/tickets/ticketViewModels"
import type { TicketCategoryKey, TicketPriority } from "@/app/lib/tickets/ticketTypes"
import {
    BackToTicketsLink,
    PriorityChip,
    StatusChip,
    TicketErrorBox,
    TicketLoading,
    TicketPager,
} from "../TicketParts"
import styles from "../support.module.css"

/*
 * T5 — /support/[id] — جزئیات تیکت + گفتگو
 *
 * منابع داده: GET /api/tickets/[id] و POST /api/tickets/[id]/messages و
 * PATCH /api/tickets/[id].
 *
 * چه چیزهایی **در UI** نیست و عمداً نیست:
 *   • کنترل وضعیت (status) — کاربر اجازهٔ تغییر آن را ندارد.
 *   • گزینهٔ URGENT — از `TICKET_USER_PRIORITY_OPTIONS` (مشتق از T2) می‌آید.
 *   • هر فیلد مالکیت/نقش.
 *
 * قفل‌کردن composer روی تیکت بسته **صرفاً قابلیت‌پذیری** است (presentation)؛
 * تصمیم نهایی در سرویس است و پاسخ `TICKET_CLOSED` هم هرچه شود درست نمایش داده
 * می‌شود.
 *
 * صفحه‌بندی گفتگو (R1): `messagesPage` یک state محلی است که به query واقعیِ
 * endpoint تبدیل می‌شود — همان الگوی فهرست تیکت‌ها. `data.ticket.messages` فقط
 * پیام‌های همین صفحه است؛ `data.messagePage` می‌گوید صفحهٔ بعدی هست یا نه.
 */

export default function SupportTicketDetailPage() {
    const params = useParams<{ id: string }>()
    const rawId = params?.id ?? ""

    const [draft, setDraft] = useState("")
    const [sending, setSending] = useState(false)
    const [savingSettings, setSavingSettings] = useState(false)
    const [actionError, setActionError] = useState<string | null>(null)
    const [canRetry, setCanRetry] = useState(false)
    const [messagesPage, setMessagesPage] = useState(1)

    const query = useMemo(
        () => buildTicketMessagesQuery({ page: messagesPage, limit: TICKET_MESSAGE_PAGE_LIMIT }),
        [messagesPage],
    )

    const fetcher = useCallback(
        (signal: AbortSignal) => fetchTicket(Number(rawId), query, signal),
        [rawId, query],
    )
    const { data, loading, error, refetch } = useTicketQuery(`ticket:${rawId}?${query}`, fetcher)

    const send = async (e: React.FormEvent) => {
        e.preventDefault()
        if (sending) return
        setActionError(null)
        setSending(true)
        try {
            await sendTicketMessage(Number(rawId), buildTicketMessagePayload(draft))
            setDraft("")
            toast.success("پیام شما ثبت شد")
            refetch()
        } catch (err) {
            const message = ticketErrorMessage(err)
            setActionError(message)
            setCanRetry(isRetryableTicketError(err))
            toast.error(message)
        } finally {
            setSending(false)
        }
    }

    const saveSettings = async (next: { priority?: TicketPriority; category?: TicketCategoryKey | null }) => {
        if (savingSettings) return
        setActionError(null)
        setSavingSettings(true)
        try {
            await updateTicket(Number(rawId), buildUserTicketUpdatePayload(next))
            toast.success("تیکت به‌روزرسانی شد")
            refetch()
        } catch (err) {
            const message = ticketErrorMessage(err)
            setActionError(message)
            setCanRetry(isRetryableTicketError(err))
            toast.error(message)
        } finally {
            setSavingSettings(false)
        }
    }

    if (loading && data === null) return <TicketLoading label="در حال دریافت تیکت…" />

    if (error !== null) {
        return (
            <div className={styles.page}>
                <header className={styles.pageHead}>
                    <div className={styles.headSpacer} />
                    <BackToTicketsLink />
                </header>
                <TicketErrorBox
                    message={ticketErrorMessage(error)}
                    onRetry={isRetryableTicketError(error) ? refetch : undefined}
                />
            </div>
        )
    }

    if (data === null) return null

    const ticket = data.ticket
    const messages = buildTicketMessages(ticket.messages)
    const replyable = canReplyToTicket(ticket.status)
    const pagination = buildTicketPagination(
        data.messagePage.page,
        data.messagePage.limit,
        data.messagePage.total,
        data.messagePage.hasMore,
    )

    return (
        <div className={styles.page}>
            <header className={styles.pageHead}>
                <div>
                    <h1 className={styles.pageTitle}>{ticket.subject}</h1>
                    <p className={styles.pageSub}>{ticketStatusHint(ticket.status, "user")}</p>
                </div>
                <div className={styles.headSpacer} />
                <BackToTicketsLink />
            </header>

            <section className={styles.card} aria-label="مشخصات تیکت">
                <div className={styles.chipRow}>
                    <StatusChip status={ticket.status} label={ticketStatusLabel(ticket.status)} />
                    <PriorityChip priority={ticket.priority} label={ticketPriorityLabel(ticket.priority)} />
                    <span className={styles.chip}>{ticketCategoryLabel(ticket.category)}</span>
                </div>
                <p className={styles.hint}>ثبت‌شده: {formatTicketTime(ticket.createdAt) ?? "—"}</p>
            </section>

            {actionError !== null && (
                <div className={styles.alert} role="alert">
                    {actionError}
                    {canRetry && (
                        <button
                            type="button"
                            className="dp-btn dp-btn-ghost"
                            onClick={refetch}
                            style={{ marginInlineStart: 8 }}
                        >
                            تازه‌سازی
                        </button>
                    )}
                </div>
            )}

            <section className={styles.card} aria-label="گفتگو">
                <p className={styles.hint}>
                    {buildMessageThreadLabel(
                        data.messagePage.page,
                        data.messagePage.limit,
                        data.messagePage.total,
                    )}
                </p>
                <div className={styles.thread}>
                    {messages.map((message) => (
                        <article
                            key={message.id}
                            className={`${styles.bubble} ${message.isStaff ? styles.bubbleStaff : styles.bubbleUser}`}
                        >
                            <div className={styles.bubbleHead}>
                                <strong>{message.authorLabel}</strong>
                                <span>{message.timeLabel ?? ""}</span>
                            </div>
                            <p className={styles.bubbleBody}>{message.body}</p>
                        </article>
                    ))}
                </div>                    <TicketPager
                        page={pagination.page}
                        pageInfo={`صفحه‌ی ${pagination.page} از ${pagination.totalPages}`}
                        hasPrev={pagination.hasPrev}
                        hasNext={pagination.hasNext}
                        onPrev={() => setMessagesPage((p) => Math.max(1, p - 1))}
                        onNext={() => setMessagesPage((p) => p + 1)}
                    />

                    {replyable ? (
                    <form className={`${styles.composer} ${styles.card}`} onSubmit={send} noValidate>
                        <label className="dp-label" htmlFor="ticket-reply">
                            پاسخ شما
                        </label>
                        <textarea
                            id="ticket-reply"
                            className="dp-input"
                            value={draft}
                            maxLength={TICKET_BODY_MAX}
                            placeholder="پاسخ خود را بنویسید…"
                            onChange={(e) => setDraft(e.target.value)}
                            disabled={sending}
                        />
                        <button type="submit" className="dp-btn dp-btn-primary" disabled={sending || draft.trim().length === 0}>
                            {sending ? "در حال ارسال…" : "ارسال پیام"}
                        </button>
                    </form>
                ) : (
                    <p className={styles.closedNotice}>
                        این تیکت بسته شده است و امکان ارسال پیام تازه وجود ندارد.
                    </p>
                )}
            </section>

            <section className={styles.card} aria-label="ویرایش تیکت">
                <p className={styles.hint}>
                    می‌توانید دسته‌بندی و اولویت تیکت خودتان را تغییر دهید. تغییر وضعیت تیکت در اختیار
                    پشتیبانی است.
                </p>
                <div className={styles.formGrid}>
                    <div className="dp-form-group">
                        <label className="dp-label" htmlFor="ticket-edit-priority">
                            اولویت
                        </label>
                        <select
                            id="ticket-edit-priority"
                            className="dp-input"
                            value={ticket.priority}
                            disabled={savingSettings}
                            onChange={(e) => {
                                void saveSettings({ priority: e.target.value as TicketPriority })
                            }}
                        >
                            {/* فقط واژگان کاربر. اگر پشتیبانی قبلاً URGENT گذاشته باشد،
                                فقط برای نمایش و غیرقابل‌انتخاب نگه داشته می‌شود. */}
                            {ticket.priority === "URGENT" && (
                                <option value="URGENT" disabled>
                                    {TICKET_PRIORITY_LABELS.URGENT}
                                </option>
                            )}
                            {TICKET_USER_PRIORITY_OPTIONS.map((option) => (
                                <option key={option} value={option}>
                                    {TICKET_PRIORITY_LABELS[option]}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="dp-form-group">
                        <label className="dp-label" htmlFor="ticket-edit-category">
                            دسته‌بندی
                        </label>
                        <select
                            id="ticket-edit-category"
                            className="dp-input"
                            value={ticket.category ?? ""}
                            disabled={savingSettings}
                            onChange={(e) => {
                                const value = e.target.value
                                void saveSettings({ category: value === "" ? null : (value as TicketCategoryKey) })
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
                </div>
            </section>
        </div>
    )
}
