"use client"

import { useRef, useState } from "react"
import { Camera, Trash2 } from "lucide-react"
import { toast } from "react-toastify"
import { motion } from "framer-motion"
import { useRouter } from "next/navigation"
import Avatar, { type AvatarUser } from "./Avatar"
import { api } from "@/app/lib/api/client"
import AnimatedModal from "./motion/AnimatedModal"
import styles from "./task/task.module.css"

/* فشرده‌سازی عکس سمت کلاینت: حداکثر ۲۵۶px و کیفیت ۰٫۸ → data-URL سبک برای ذخیره */
function compressImage(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
            reject(new Error("فرمت عکس معتبر نیست (PNG، JPG یا WebP)"))
            return
        }
        if (file.size > 5 * 1024 * 1024) {
            reject(new Error("حجم عکس باید کمتر از ۵ مگابایت باشد"))
            return
        }

        const reader = new FileReader()
        reader.onerror = () => reject(new Error("خواندن فایل ناموفق بود"))
        reader.onload = () => {
            const img = new Image()
            img.onerror = () => reject(new Error("عکس قابل خواندن نیست"))
            img.onload = () => {
                const max = 256
                const scale = Math.min(1, max / Math.max(img.width, img.height))
                const w = Math.max(1, Math.round(img.width * scale))
                const h = Math.max(1, Math.round(img.height * scale))

                const canvas = document.createElement("canvas")
                canvas.width = w
                canvas.height = h
                const ctx = canvas.getContext("2d")
                if (!ctx) {
                    reject(new Error("مرورگر از ویرایش عکس پشتیبانی نمی‌کند"))
                    return
                }
                ctx.drawImage(img, 0, 0, w, h)
                resolve(canvas.toDataURL("image/jpeg", 0.8))
            }
            img.src = String(reader.result)
        }
        reader.readAsDataURL(file)
    })
}

export default function AvatarUpload({ user }: { user: AvatarUser }) {
    const router = useRouter()
    const inputRef = useRef<HTMLInputElement | null>(null)
    const [busy, setBusy] = useState(false)
    const [confirmOpen, setConfirmOpen] = useState(false)

    const upload = async (file: File) => {
        setBusy(true)
        try {
            const dataUrl = await compressImage(file)
            await api("/api/auth/avatar", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ image: dataUrl }),
            })
            toast.success("عکس پروفایل به‌روزرسانی شد ✅")
            router.refresh()
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "آپلود ناموفق بود")
        } finally {
            setBusy(false)
            if (inputRef.current) inputRef.current.value = ""
        }
    }

    const remove = async () => {
        setBusy(true)
        try {
            await api("/api/auth/avatar", { method: "DELETE" })
            toast.success("عکس پروفایل حذف شد")
            router.refresh()
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "حذف عکس ناموفق بود")
        } finally {
            setBusy(false)
        }
    }

    return (
        <motion.div
            className="dp-avatar-upload"
            initial={{ opacity: 0, scale: .9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: .3, ease: "easeOut" }}
        >
            <Avatar user={user} size="md" />
            {busy && <div className="dp-avatar-busy">…</div>}

            <button
                type="button"
                className="dp-avatar-overlay"
                title="تغییر عکس پروفایل"
                onClick={() => inputRef.current?.click()}
                disabled={busy}
            >
                <Camera size={22} />
            </button>

            {user.image && !busy && (
                <button
                    type="button"
                    className="dp-avatar-trash"
                    title="حذف عکس پروفایل"
                    aria-label="حذف عکس پروفایل"
                    onClick={() => setConfirmOpen(true)}
                >
                    <Trash2 size={13} />
                </button>
            )}

            <input
                ref={inputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) void upload(file)
                }}
            />

            {/* تأییدیه حذف عکس پروفایل — انصراف هیچ کاری نمیکند، حذف همان DELETE موجود را می‌زند */}
            <AnimatedModal open={confirmOpen} onClose={() => setConfirmOpen(false)}>
                <div className={styles.modalHead}>
                    <h4>حذف عکس پروفایل</h4>
                    <button className={styles.closeBtn} onClick={() => setConfirmOpen(false)} aria-label="بستن">✕</button>
                </div>
                <p className={styles.hint}>آیا می‌خواهید عکس پروفایل را حذف کنید؟</p>
                <div className={styles.modalActions}>
                    <button
                        className={styles.btnPrimary}
                        onClick={() => {
                            setConfirmOpen(false)
                            void remove()
                        }}
                        disabled={busy}
                    >
                        حذف
                    </button>
                    <button className={styles.btnGhost} onClick={() => setConfirmOpen(false)} disabled={busy}>
                        انصراف
                    </button>
                </div>
            </AnimatedModal>
        </motion.div>
    )
}
