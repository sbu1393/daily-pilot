"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "react-toastify"
import { Send } from "lucide-react"

import {
    TICKET_CATEGORY_LABELS,
    TICKET_BODY_MAX,
    TICKET_PRIORITY_LABELS,
    TICKET_SUBJECT_MAX,
    TICKET_CATEGORY_OPTIONS,
    TICKET_USER_PRIORITY_OPTIONS,
    buildCreateTicketPayload,
    ticketErrorMessage,
} from "@/app/lib/tickets/ticketViewModels"
import {
    createTicketSchema,
    ticketCategorySchema,
    ticketUserPrioritySchema,
} from "@/app/schema/ticketSchema"
import { createTicket } from "@/app/lib/tickets/ticketClient"
import { BackToTicketsLink } from "../TicketParts"
import styles from "../support.module.css"

/*
 * T5 — /support/new — فرم ایجاد تیکت
 *
 * الگوی فرم‌های مخزن: `react-hook-form` + `zodResolver` + `FormInput`-style markup
 * + `toast` (همان ترکیب `app/auth/register/page.tsx` و `SettingsPanel.tsx`).
 *
 * نکتهٔ کلیدی: schema فرم **از schema فاز T2 مشتق شده** (`createTicketSchema.extend`)،
 * پس قواعد فرم همان قواعد API است و نمی‌توانند واگرا شوند — ولی source of truth
 * همچنان همان API است و فرم فقط تجربهٔ بهتر می‌دهد.
 *
 * امنیت: `buildCreateTicketPayload` allowlist است، پس `userId`/`status`/`closedAt`/
 * `isStaff`/`role` هرگز در body نمی‌روند. اولویت‌ها از
 * `TICKET_USER_PRIORITY_OPTIONS` (مشتق از `ticketUserPrioritySchema`) می‌آیند،
 * یعنی گزینهٔ `URGENT` اصلاً در فرم وجود ندارد.
 */

// `""` یعنی «انتخاب نشده» — بقیهٔ قواعد عیناً از T2 می‌آید.
const createTicketFormSchema = createTicketSchema.extend({
    category: z.union([z.literal(""), ticketCategorySchema]),
    priority: z.union([z.literal(""), ticketUserPrioritySchema]),
})

type CreateTicketForm = z.infer<typeof createTicketFormSchema>

export default function NewTicketPage() {
    const router = useRouter()
    const [submitError, setSubmitError] = useState<string | null>(null)

    const {
        register,
        handleSubmit,
        formState: { errors, isSubmitting },
    } = useForm<CreateTicketForm>({
        resolver: zodResolver(createTicketFormSchema),
        defaultValues: { subject: "", body: "", category: "", priority: "" },
    })

    const onSubmit = handleSubmit(async (values) => {
        setSubmitError(null)
        try {
            // id از پاسخ واقعی API می‌آید؛ هرگز تولید نمی‌شود.
            const created = await createTicket(buildCreateTicketPayload(values))
            toast.success("تیکت شما ثبت شد")
            router.push(`/support/${created.id}`)
        } catch (error) {
            const message = ticketErrorMessage(error)
            setSubmitError(message)
            toast.error(message)
        }
    })

    return (
        <div className={styles.page}>
            <header className={styles.pageHead}>
                <div>
                    <h1 className={styles.pageTitle}>تیکت جدید</h1>
                    <p className={styles.pageSub}>
                        مشکل یا پرسش‌تان را بنویسید؛ پاسخ در همین صفحه ثبت می‌شود.
                    </p>
                </div>
                <div className={styles.headSpacer} />
                <BackToTicketsLink />
            </header>

            <form className={`${styles.card} ${styles.formGrid}`} onSubmit={onSubmit} noValidate>
                {submitError !== null && (
                    <div className={styles.alert} role="alert">
                        {submitError}
                    </div>
                )}

                <div className="dp-form-group">
                    <label className="dp-label" htmlFor="ticket-subject">
                        موضوع
                    </label>
                    <input
                        id="ticket-subject"
                        type="text"
                        className={`dp-input ${errors.subject ? "dp-input-error" : ""}`}
                        placeholder="کوتاه و روشن بنویسید"
                        aria-invalid={errors.subject ? true : undefined}
                        {...register("subject")}
                    />
                    {errors.subject && (
                        <p className="dp-error-text">{errors.subject.message}</p>
                    )}
                    <span className={styles.counter}>
                        حداکثر {TICKET_SUBJECT_MAX} کاراکتر
                    </span>
                </div>

                <div className="dp-form-group">
                    <label className="dp-label" htmlFor="ticket-body">
                        شرح مشکل
                    </label>
                    <textarea
                        id="ticket-body"
                        className={`dp-input ${styles.composer} ${errors.body ? "dp-input-error" : ""}`}
                        placeholder="چه اتفاقی افتاده و انتظار داشتید چه شود؟"
                        aria-invalid={errors.body ? true : undefined}
                        {...register("body")}
                    />
                    {errors.body && <p className="dp-error-text">{errors.body.message}</p>}
                    <span className={styles.counter}>حداکثر {TICKET_BODY_MAX} کاراکتر</span>
                </div>

                <div className="dp-form-group">
                    <label className="dp-label" htmlFor="ticket-category">
                        دسته‌بندی (اختیاری)
                    </label>
                    <select
                        id="ticket-category"
                        className={`dp-input ${errors.category ? "dp-input-error" : ""}`}
                        {...register("category")}
                    >
                        <option value="">بدون دسته‌بندی</option>
                        {TICKET_CATEGORY_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                                {TICKET_CATEGORY_LABELS[option]}
                            </option>
                        ))}
                    </select>
                    {errors.category && <p className="dp-error-text">{errors.category.message}</p>}
                </div>

                <div className="dp-form-group">
                    <label className="dp-label" htmlFor="ticket-priority">
                        اولویت (اختیاری)
                    </label>
                    <select
                        id="ticket-priority"
                        className={`dp-input ${errors.priority ? "dp-input-error" : ""}`}
                        {...register("priority")}
                    >
                        <option value="">پیش‌فرض</option>
                        {TICKET_USER_PRIORITY_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                                {TICKET_PRIORITY_LABELS[option]}
                            </option>
                        ))}
                    </select>
                    {errors.priority && <p className="dp-error-text">{errors.priority.message}</p>}
                    <p className={styles.hint}>
                        اولویت فوری را تیم پشتیبانی تعیین می‌کند.
                    </p>
                </div>

                <button type="submit" className="dp-btn dp-btn-primary dp-btn-block" disabled={isSubmitting}>
                    <Send size={16} aria-hidden="true" />
                    {isSubmitting ? "در حال ثبت…" : "ثبت تیکت"}
                </button>
            </form>
        </div>
    )
}
