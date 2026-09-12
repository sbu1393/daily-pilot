"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
// rebase: UI نسخه‌ی remote (lucide + logo.png) حفظ شد؛ importهای H2 پروژه باقی ماندند
import { toast } from "react-toastify"
import { CalendarDays, DoorOpen, Settings } from "lucide-react"
import Avatar, { type AvatarUser } from "./Avatar"
import { clearOfflineForLogout } from "@/app/lib/offline"
import { faDigits } from "@/app/lib/time"

export default function Header({ user }: { user: AvatarUser | null }) {
    const router = useRouter()
    const [busy, setBusy] = useState(false)
    const [menuOpen, setMenuOpen] = useState(false)
    const menuRef = useRef<HTMLDivElement | null>(null)

    // بستن منو با کلیک بیرون از آن
    useEffect(() => {
        if (!menuOpen) return
        const handler = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setMenuOpen(false)
            }
        }
        document.addEventListener("mousedown", handler)
        return () => document.removeEventListener("mousedown", handler)
    }, [menuOpen])

    const logout = async () => {
        if (busy) return
        setBusy(true)

        // H2: قبل از پاک شدن کوکی نشست، صف آفلاین را (بهترین تلاش) سینک و کش محلی روزها را
        // پاک می‌کنیم تا داده‌ی حساب قبلی روی دستگاه باقی نماند و صف در حساب دیگری POST نشود.
        let pending = 0
        try {
            const flushed = await clearOfflineForLogout()
            pending = flushed.pending
        } catch {
            /* پاک‌سازی ناموفق → خروج باید همچنان انجام شود */
        }

        try {
            await fetch("/api/auth/logout", { method: "POST" })
        } catch {
            /* حتی اگر درخواست خطا بدهد، کاربر به صفحه ورود برمی‌گردد */
        } finally {
            setBusy(false)
            if (pending > 0) {
                toast.info(
                    `${faDigits(pending)} کار آفلاین سینک‌نشده در حساب خودت محفوظ ماند و بعد از ورود دوباره سینک می‌شود`,
                )
            }
            router.push("/auth/login")
            router.refresh()
        }
    }

    return (
        <header className="app-header">
            <div className="header-inner">
                <Link href="/" className="dp-link-reset" style={{ flexShrink: 0 }}>
                <img
                    src="/logo.png"
                    alt="روزچین"
                    style={{
                        height: "100%",
                        width: "100%",
                        objectFit: "contain",
                        objectPosition: "50% 47%",
                        display: "block",
                    }}
                />
                </Link>

                <div className="header-actions">
                    <Link href="/dashboard" className="dp-header-link">
                    <CalendarDays />{" "}برنامه امروز
                    </Link>

                    {user && (
                        <div className="header-user" ref={menuRef}>
                            <button
                                type="button"
                                className="header-user-btn"
                                onClick={() => setMenuOpen((v) => !v)}
                                aria-haspopup="menu"
                                aria-expanded={menuOpen}
                            >
                                <Avatar user={user} size="sm" />
                                {/* <span className="header-user-name">
                                    {user.firstName || user.username}
                                </span> */}
                            </button>

                            {menuOpen && (
                                <div className="header-menu" role="menu">
                                    <Link
                                        href="/dashboard/settings"
                                        className="header-menu-item"
                                        onClick={() => setMenuOpen(false)}
                                    >
                                        <Settings />تنظیمات و حساب کاربری
                                    </Link>
                                    <button
                                        type="button"
                                        className="header-menu-item header-menu-logout"
                                        onClick={logout}
                                        disabled={busy}
                                    >
                                        {busy ? "…" : <><DoorOpen/> خروج از حساب</>}

                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {!user && (
                        <Link href="/auth/login" className="dp-header-link">
                            ورود
                        </Link>
                    )}
                </div>
            </div>
        </header>
    )
}