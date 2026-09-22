"use client"

import { useEffect, useState } from "react"
import { toast } from "react-toastify"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { api } from "@/app/lib/api/client"
import { formatReminderLabel, getLocalReminderParts, reminderInstantFromLocal } from "@/app/lib/reminder"
import AnimatedModal from "../motion/AnimatedModal"
import TaskReminderField, { defaultReminderDraft, type ReminderDraft } from "./TaskReminderField"
import { type TaskItem } from "./taskTypes"
import styles from "./task.module.css"

type Props = {
    task: TaskItem | null
    onClose: () => void
    onDone: () => void
}

/**
 * ویرایش یادآوری per-task برای یک Task موجود.
 * فقط فیلد `reminderAt` را تغییر می‌دهد (PATCH /api/tasks/[id]) — بدون endpoint جدید.
 * خاموش‌کردن یادآوری → reminderAt = null تا یادآوری قدیمی دوباره trigger نشود.
 */
export default function EditTaskModal({ task, onClose, onDone }: Props) {
    const { timezone } = useCalendar()
    const [draft, setDraft] = useState<ReminderDraft>(() => defaultReminderDraft(""))
    const [busy, setBusy] = useState(false)

    useEffect(() => {
        if (!task) return
        if (task.reminderAt) {
            const parts = getLocalReminderParts(task.reminderAt, timezone)
            setDraft({
                enabled: true,
                canonicalKey: parts?.canonicalKey ?? task.dayKey,
                hour: parts?.hour ?? 9,
                minute: parts?.minute ?? 0,
            })
        } else {
            setDraft(defaultReminderDraft(task.dayKey))
        }
    }, [task, timezone])

    useEffect(() => {
        if (!task) return
        const h = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose()
        }
        window.addEventListener("keydown", h)
        return () => window.removeEventListener("keydown", h)
    }, [task, onClose])

    if (!task) return null

    const submit = async () => {
        setBusy(true)
        try {
            const reminderAt = draft.enabled
                ? reminderInstantFromLocal(draft.canonicalKey, draft.hour, draft.minute, timezone).toISOString()
                : null
            await api(`/api/tasks/${task.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reminderAt }),
            })
            onClose()
            onDone()
            toast.success(
                reminderAt ? "یادآوری تسک ذخیره شد ✅" : "یادآوری تسک خاموش شد",
            )
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "خطا در ذخیره‌ی یادآوری")
        } finally {
            setBusy(false)
        }
    }

    return (
        <AnimatedModal open={task !== null} onClose={onClose}>
            <div className={styles.modalHead}>
                <h4>یادآوری تسک</h4>
                <button className={styles.closeBtn} onClick={onClose} aria-label="بستن">✕</button>
            </div>
            <p className={styles.taskTitle}>«{task.title}»</p>
            {task.reminderAt && (
                <p className={styles.hint}>
                    یادآوری فعلی: {formatReminderLabel(task.reminderAt, timezone)}
                </p>
            )}
            <TaskReminderField value={draft} onChange={setDraft} disabled={busy} />
            <div className={styles.modalActions}>
                <button className={styles.btnPrimary} onClick={submit} disabled={busy}>
                    {busy ? "در حال ذخیره…" : "ذخیره‌ی یادآوری"}
                </button>
                <button className={styles.btnGhost} onClick={onClose} disabled={busy}>
                    انصراف
                </button>
            </div>
        </AnimatedModal>
    )
}
