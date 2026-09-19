"use client"

import { useEffect, useRef, useState } from "react"
import { toast } from "react-toastify"

/**
 * ثبت Service Worker برای PWA شدن برنامه + جریان به‌روزرسانی.
 * در محیط‌های غیر امن (http) یا مرورگرهای قدیمی بی‌صدا رد می‌شود.
 *
 * چرخه‌ی به‌روزرسانی (PWA update flow):
 *  ۱. `registration.update()` — بررسی دوره‌ای/در مراجعه‌ی مجدد برای پیدا کردن نسخه‌ی جدید sw.js.
 *  ۲. وقتی worker جدید «waiting» شد → toast فارسی با دکمه‌ی «به‌روزرسانی»
 *     (postMessage SKIP_WAITING → worker فعال می‌شود).
 *  ۳. `controllerchange` → یک‌بار reload صفحه تا UI با اسکریپت جدید رندر شود
 *     (با گارد ضد-حلقه).
 */
export default function PwaRegister() {
    const [reg, setReg] = useState<ServiceWorkerRegistration | null>(null)
    const notifiedRef = useRef(false)
    // گارد ضد-حلقه: بعد از skipWaiting، controllerchange ممکن است چندبار fire شود.
    const reloadingRef = useRef(false)

    useEffect(() => {
        if (!("serviceWorker" in navigator)) return
        if (window.location.protocol !== "https:" && window.location.hostname !== "localhost") return

        let interval: ReturnType<typeof setInterval> | undefined
        let onVisibility: (() => void) | undefined
        let onControllerChange: (() => void) | undefined

        navigator.serviceWorker
            .register("/sw.js", { scope: "/" })
            .then((registration) => {
                setReg(registration)

                // ۱) بررسی نسخه‌ی جدید: در مراجعه‌ی مجدد + هر ۱۵ دقیقه
                const check = () => {
                    void registration.update().catch(() => {
                        /* آفلاین/خطای شبکه — دفعه‌ی بعد */
                    })
                }
                check()
                interval = setInterval(check, 15 * 60 * 1000)
                onVisibility = () => {
                    if (document.visibilityState === "visible") check()
                }
                document.addEventListener("visibilitychange", onVisibility)

                // ۲) worker در انتظار → toast با اکشن به‌روزرسانی (یک‌بار در هر نشست)
                const notifyWaiting = () => {
                    if (!registration.waiting || notifiedRef.current) return
                    notifiedRef.current = true
                    // react-toastify v11: اکشن به‌صورت JSX داخل خود toast (بدون استایل جدید؛
                    // فقط کلاس‌های سراسری dp-btn + چیدمان کوچک inline)
                    toast.info(
                        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                            <span>نسخه‌ی جدید روزساز آماده است 🎉</span>
                            <button
                                type="button"
                                className="dp-btn dp-btn-primary"
                                style={{ padding: ".25rem .75rem", fontSize: ".85rem" }}
                                onClick={() => {
                                    reloadingRef.current = true // خودمان reload می‌کنیم؛ گارد را از قبل ببند
                                    registration.waiting?.postMessage({ type: "SKIP_WAITING" })
                                }}
                            >
                                به‌روزرسانی
                            </button>
                        </div>,
                        {
                            closeOnClick: false,
                            autoClose: false, // تا زمانی که کاربر تصمیم بگیرد باز بماند
                            toastId: "pwa-update", // از تکرار toast جلوگیری می‌کند
                        },
                    )
                }
                notifyWaiting()
                registration.addEventListener("updatefound", () => {
                    const installing = registration.installing
                    installing?.addEventListener("statechange", () => {
                        // «installed» با controller موجود = نسخه‌ی جدید در انتظار فعال‌سازی
                        if (installing.state === "installed" && navigator.serviceWorker.controller) {
                            notifyWaiting()
                        }
                    })
                })

                // ۳) کنترل‌گر عوض شد (بعد از SKIP_WAITING + claim) → یک‌بار reload
                onControllerChange = () => {
                    if (reloadingRef.current) return
                    reloadingRef.current = true
                    window.location.reload()
                }
                navigator.serviceWorker.addEventListener("controllerchange", onControllerChange)
            })
            .catch(() => {
                /* ثبت سرویس‌کاربر ممکن نیست — مشکلی نیست */
            })

        return () => {
            if (interval) clearInterval(interval)
            if (onVisibility) document.removeEventListener("visibilitychange", onVisibility)
            if (onControllerChange) {
                navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange)
            }
        }
    }, [])

    // «به‌روزرسانی» بدون reload دستی هم کار می‌کند (skipWaiting + claim در sw.js فعال است)؛
    // این fallback فقط اگر controllerchange در مرورگر قدیمی fire نشد.
    useEffect(() => {
        if (!reg?.waiting || !reloadingRef.current) return
        const t = setTimeout(() => {
            if (navigator.serviceWorker.controller) window.location.reload()
        }, 3000)
        return () => clearTimeout(t)
    }, [reg])

    return null
}
