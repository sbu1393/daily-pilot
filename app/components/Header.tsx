"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import Logo from "./Logo"
import Avatar, { type AvatarUser } from "./Avatar"

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
        try {
            await fetch("/api/auth/logout", { method: "POST" })
        } catch {
            /* حتی اگر درخواست خطا بدهد، کاربر به صفحه ورود برمی‌گردد */
        } finally {
            setBusy(false)
            router.push("/auth/login")
            router.refresh()
        }
    }

    return (
        <header className="app-header">
            <div className="header-inner">
                <Link href="/dashboard" className="dp-link-reset">
                    <Logo />
                </Link>

                <div className="header-actions">
                    <Link href="/dashboard" className="dp-header-link">
                        📅 برنامه امروز
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
                                <span className="header-user-name">
                                    {user.firstName || user.username}
                                </span>
                            </button>

                            {menuOpen && (
                                <div className="header-menu" role="menu">
                                    <Link
                                        href="/dashboard/settings"
                                        className="header-menu-item"
                                        onClick={() => setMenuOpen(false)}
                                    >
                                        ⚙️ تنظیمات و حساب کاربری
                                    </Link>
                                    <button
                                        type="button"
                                        className="header-menu-item header-menu-logout"
                                        onClick={logout}
                                        disabled={busy}
                                    >
                                        {busy ? "…" : "🚪 خروج از حساب"}
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