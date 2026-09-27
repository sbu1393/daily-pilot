"use client"

import { useEffect, useState } from "react"
import { api } from "@/app/lib/api/client"
import { toast } from "react-toastify"
import AnimatedModal from "../motion/AnimatedModal"
import CategoryPicker from "./CategoryPicker"
import {
    draftFromSelection,
    EMPTY_CATEGORY_DRAFT,
    validateCategoryDraft,
    type CategoryDraft,
} from "./categoryForm"
import {
    CATEGORY_REQUIRED_MESSAGE,
    CUSTOM_CATEGORY_ICON_REQUIRED_MESSAGE,
    CUSTOM_CATEGORY_LABEL_MESSAGE,
} from "@/app/lib/categories"
import { type TaskItem } from "./taskTypes"
import styles from "./task.module.css"
import { Pencil } from "lucide-react"

type Props = {
    task: TaskItem | null
    onClose: () => void
    onSaved: () => void
}

/**
 * EditTaskModal — ویرایش عنوان و دستهٔ یک کار موجود.
 *
 * دسته دقیقاً همان دو حالت Create را دارد، ولی **populate** می‌شود: یک تسک با
 * دستهٔ custom در حالت custom باز می‌شود، نامش پر است و آیکنش از
 * `categoryIcon` انتخاب‌شده دیده می‌شود؛ یک تسک preset همان preset را نشان
 * می‌دهد (`draftFromSelection`).
 *
 * فقط `title` و `category` فرستاده می‌شوند؛ تغییر دسته فرادادهٔ کاربر است و
 * طبق قرارداد موجود هیچ اثری بر برنامه‌ریزی، AI یا روزهای درگیر ندارد.
 */
export default function EditTaskModal({ task, onClose, onSaved }: Props) {
    const [title, setTitle] = useState("")
    const [draft, setDraft] = useState<CategoryDraft>(EMPTY_CATEGORY_DRAFT)
    const [errorField, setErrorField] = useState<
        "title" | "category" | "customLabel" | "customIcon" | null
    >(null)
    const [loading, setLoading] = useState(false)

    // هر بار که مودال روی یک تسک (یا هیچ تسکی) باز می‌شود، فرم از دادهٔ خودِ تسک
    // پر می‌شود — نه از state قبلیِ فرم.
    useEffect(() => {
        if (!task) return
        setTitle(task.title)
        setDraft(draftFromSelection(task.category, task.categoryIcon))
        setErrorField(null)
    }, [task])

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
        const trimmedTitle = title.trim()
        if (trimmedTitle.length < 3) {
            setErrorField("title")
            toast.error("عنوان باید حداقل ۳ حرف باشد")
            return
        }
        const selection = validateCategoryDraft(draft)
        if (!selection.ok) {
            setErrorField(selection.field)
            toast.error(selection.message)
            return
        }

        setLoading(true)
        try {
            // دسته و آیکن یک واحد فراداده‌اند و با هم فرستاده می‌شوند؛ برای
            // preset آیکن اصلاً ارسال نمی‌شود (در واژگان canonical است).
            await api(`/api/tasks/${task.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    title: trimmedTitle,
                    category: selection.selection.category,
                    ...(selection.selection.categoryIcon
                        ? { categoryIcon: selection.selection.categoryIcon }
                        : {}),
                }),
            })
            onClose()
            onSaved()
            toast.success("تغییرات ذخیره شد ✅")
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "خطا در ویرایش کار")
        } finally {
            setLoading(false)
        }
    }

    return (
        <AnimatedModal open onClose={onClose}>
            <div className={styles.modalHead}>
                <Pencil aria-hidden="true" />
                <h4>ویرایش کار</h4>
                <button className={styles.closeBtn} onClick={onClose} aria-label="بسته">
                    ✕
                </button>
            </div>
            <p className={styles.hint}>
                روز <b>{task.dayKey}</b> — تغییر دسته‌بندی فقط برچسب کار را عوض می‌کند و
                روی زمان‌بندی اثری ندارد.
            </p>

            <input
                autoFocus
                className={styles.input}
                placeholder="عنوان کار"
                value={title}
                maxLength={200}
                onChange={(e) => {
                    setTitle(e.target.value)
                    setErrorField(null)
                }}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && !loading) submit()
                }}
            />
            {errorField === "title" && (
                <p className={styles.categoryError} role="alert">
                    عنوان باید حداقل ۳ حرف باشد
                </p>
            )}

            <CategoryPicker
                value={draft}
                onChange={(next) => {
                    setDraft(next)
                    setErrorField(null)
                }}
                error={errorField === "category" ? CATEGORY_REQUIRED_MESSAGE : null}
                customLabelError={
                    errorField === "customLabel" ? CUSTOM_CATEGORY_LABEL_MESSAGE : null
                }
                customIconError={
                    errorField === "customIcon" ? CUSTOM_CATEGORY_ICON_REQUIRED_MESSAGE : null
                }
                disabled={loading}
            />

            <div className={styles.modalActions}>
                <button className={styles.btnPrimary} onClick={submit} disabled={loading}>
                    {loading ? "⏳ در حال ذخیره…" : "ذخیرهٔ تغییرات"}
                </button>
                <button className={styles.btnGhost} onClick={onClose} disabled={loading}>
                    انصراف
                </button>
            </div>
        </AnimatedModal>
    )
}
