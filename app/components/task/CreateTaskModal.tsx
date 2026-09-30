"use client"

import { useEffect, useState } from "react"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { enqueueTask, isOffline } from "@/app/lib/offline"
import { canonicalKeyToLocalMidnight } from "@/app/lib/canonicalDay"
import { api } from "@/app/lib/api/client"
import { TASK_TITLE_MAX_LENGTH } from "@/app/lib/taskTitle"
import { toast } from "react-toastify"
import AnimatedModal from "../motion/AnimatedModal"
import styles from "./task.module.css"
import { formatCanonicalToJalali } from "../../lib/time"
import { NotebookPen, Unplug } from "lucide-react"
import {
    CATEGORY_REQUIRED_MESSAGE,
    CUSTOM_CATEGORY_ICON_REQUIRED_MESSAGE,
    CUSTOM_CATEGORY_LABEL_MESSAGE,
} from "@/app/lib/categories"
import {
    buildCreateTaskBody,
    validateCreateForm,
} from "./createTaskForm"
import CategoryPicker from "./CategoryPicker"
import {
    EMPTY_CATEGORY_DRAFT,
    type CategoryDraft,
} from "./categoryForm"


type Props = {
    open: boolean
    onClose: () => void
    onCreated: () => void
}

export default function CreateTaskModal({ open, onClose, onCreated }: Props) {
    const { selectedDate, timezone } = useCalendar()
    const [text, setText] = useState("")
    // دسته‌بندی اجباری است و **هیچ پیش‌فرضی ندارد** — تا وقتی کاربر خودش انتخاب
    // نکرده، draft خالی است و submit مسدود می‌شود. draft می‌تواند preset یا
    // custom (نام + آیکن) باشد؛ اعتبارسنجی در لایهٔ pure انجام می‌شود.
    const [categoryDraft, setCategoryDraft] = useState<CategoryDraft>(EMPTY_CATEGORY_DRAFT)
    // فیلدی که آخرین خطا به آن مربوط بوده تا پیام دقیقاً کنار همان فیلد بنشیند
    const [categoryErrorField, setCategoryErrorField] = useState<
        "category" | "customLabel" | "customIcon" | null
    >(null)
    const [loading, setLoading] = useState(false)
    const [offline, setOffline] = useState(false)

    // بستن/باز شدن دوباره: پیام خطا نباید از قبل باقی بماند
    useEffect(() => {
        if (open) setCategoryErrorField(null)
    }, [open])

    useEffect(() => {
        if (!open) return
        const h = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose()
        }
        window.addEventListener("keydown", h)
        return () => window.removeEventListener("keydown", h)
    }, [open, onClose])

    /* تشخیص وضعیت شبکه هنگام باز شدن مودال */
    useEffect(() => {
        if (!open) return
        setOffline(isOffline())
        const sync = () => setOffline(isOffline())
        window.addEventListener("online", sync)
        window.addEventListener("offline", sync)
        return () => {
            window.removeEventListener("online", sync)
            window.removeEventListener("offline", sync)
        }
    }, [open])

    /* ذخیره در صف آفلاین — تحلیل AI بعد از سینک انجام می‌شود */
    // C1: قرارداد ساخت = title + scheduledDate (ISO نیمه‌شب محلی روز انتخابی)؛ dayKey سمت سرور ساخته می‌شود (§6.2.2.1)
    const saveOffline = (value: string, selection: { category: string; categoryIcon: string | null }) => {
        enqueueTask({
            title: value,
            category: selection.category,
            categoryIcon: selection.categoryIcon,
            dayKey: selectedDate,
            scheduledDate: canonicalKeyToLocalMidnight(selectedDate, timezone).toISOString(),
        })
        toast.info(`${<Unplug />} آفلاین هستی — کار ذخیره شد و بعد از اتصال سینک می‌شود`)
        setText("")
        setCategoryDraft(EMPTY_CATEGORY_DRAFT)
        onClose()
        onCreated()
    }

    const submit = async () => {
        // یک دروازهٔ واحد: اگر عنوان یا دسته معتبر نباشد، هیچ درخواستی ارسال
        // نمی‌شود. سرور هم جداگانه (و مستقل) همین قاعده را در schema و سرویس
        // اعمال می‌کند، پس UI فقط لایهٔ اول است.
        const validation = validateCreateForm(text, null, categoryDraft)
        if (!validation.ok) {
            if (validation.field !== "title") setCategoryErrorField(validation.field)
            toast.error(validation.message)
            return
        }
        const selection = validation.category
        const value = text.trim()

        if (isOffline()) {
            saveOffline(value, selection)
            return
        }

        setLoading(true)
        try {
            await api("/api/tasks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(
                    buildCreateTaskBody(
                        value,
                        canonicalKeyToLocalMidnight(selectedDate, timezone).toISOString(),
                        selection.category,
                        selection.categoryIcon,
                    ),
                ),
            })

            setText("")
            setCategoryDraft(EMPTY_CATEGORY_DRAFT)
            setCategoryErrorField(null)
            onClose()
            onCreated()
            toast.success("کار ساخته شد و زمان‌بندی شد ✅")
        } catch (e) {
            /* خطای شبکه حین ارسال → ذخیره در صف آفلاین */
            if (e instanceof TypeError) {
                saveOffline(value, selection)
            } else {
                toast.error(e instanceof Error ? e.message : "خطا در ایجاد کار")
            }
        } finally {
            setLoading(false)
        }
    }

    return (
        <AnimatedModal open={open} onClose={onClose}>
            <div className={styles.modalHead}>
                <NotebookPen />
                <h4>کار جدید</h4>
                <button className={styles.closeBtn} onClick={onClose} aria-label="بستن">✕</button>
            </div>
            {offline && (
                <div className="dp-queued-chip" style={{ justifyContent: "center" }}>
                    <Unplug /> آفلاین — کار محلی ذخیره و بعداً سینک می‌شود
                </div>
            )}
            <p className={styles.hint}>
                برای روز <b>{formatCanonicalToJalali(selectedDate)}</b>
                — دسته‌بندی را خودت انتخاب کن و کار بدون تحلیل ساخته میشه
                بعداً با «تحلیل مجدد» می‌تونی اولویت، امتیاز، دلیل و زمان تخمینی را با هوش مصنوعی تعیین کنی.
            </p>

            <input
                autoFocus
                className={styles.input}
                placeholder="مثلاً: آماده کردن گزارش مشتری"
                value={text}
                maxLength={TASK_TITLE_MAX_LENGTH}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && !loading) submit()
                }}
            />
            <CategoryPicker
                value={categoryDraft}
                onChange={(draft) => {
                    setCategoryDraft(draft)
                    setCategoryErrorField(null)
                }}
                error={categoryErrorField === "category" ? CATEGORY_REQUIRED_MESSAGE : null}
                customLabelError={
                    categoryErrorField === "customLabel" ? CUSTOM_CATEGORY_LABEL_MESSAGE : null
                }
                customIconError={
                    categoryErrorField === "customIcon" ? CUSTOM_CATEGORY_ICON_REQUIRED_MESSAGE : null
                }
                disabled={loading}
            />
            <div className={styles.modalActions}>
                <button className={styles.btnPrimary} onClick={submit} disabled={loading}>
                    {loading ? "⏳ در حال ساخت…" : "ایجاد کار"}
                </button>
                <button className={styles.btnGhost} onClick={onClose} disabled={loading}>
                    انصراف
                </button>
            </div>
        </AnimatedModal>
    )
}
