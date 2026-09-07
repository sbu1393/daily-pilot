"use client"

import { useEffect, useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "react-toastify"
import { useRouter } from "next/navigation"
import { AnimatePresence, motion } from "framer-motion"
import Avatar from "@/app/components/Avatar"
import AvatarUpload from "@/app/components/AvatarUpload"
import FormInput from "@/app/components/FormInput"
import { profileSchema } from "@/app/schema/formSchema"
import { useSettings } from "@/app/contexts/SettingsContext"
import InstallCard from "@/app/components/pwa/InstallCard"
import styles from "./settings.module.css"

type ProfileInput = z.infer<typeof profileSchema>

type UserData = {
    id: number
    username: string
    email: string
    firstName: string | null
    lastName: string | null
    image: string | null
    birthDate: string | Date | null
    phone: string | null
}

// تاریخ را برای input[type=date] به قالب YYYY-MM-DD تبدیل می‌کند
function toDateInput(value: string | Date | null | undefined): string {
    if (!value) return ""
    if (value instanceof Date) return value.toISOString().slice(0, 10)
    return String(value).slice(0, 10)
}

type Tab = "account" | "preferences" | "install" | "info"

/* انیمیشن ورود محتوای هر تب */
const tabMotion = {
    initial: { opacity: 0, y: 14 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -10, transition: { duration: .15 } },
    transition: { duration: .28, ease: "easeOut" as const },
}

type InfoTab = "about" | "feedback" | "privacy"

export default function SettingsPanel({ user }: { user: UserData }) {
    const router = useRouter()
    const { settings, update, playBeep, requestNotificationPermission } = useSettings()
    const [tab, setTab] = useState<Tab>("account")
    const [infoTab, setInfoTab] = useState<InfoTab>("about")
    const [saving, setSaving] = useState(false)
    const [birthDate, setBirthDate] = useState<string>(toDateInput(user.birthDate))
    // بخش تغییر رمز عبور
    const [passwordForm, setPasswordForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" })
    const [passwordLoading, setPasswordLoading] = useState(false)
    const [passwordError, setPasswordError] = useState<string | null>(null)
    const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null)

    const {
        register,
        handleSubmit,
        formState: { errors },
        reset,
    } = useForm<ProfileInput>({
        resolver: zodResolver(profileSchema),
        defaultValues: {
            username: user.username,
            firstName: user.firstName ?? "",
            lastName: user.lastName ?? "",
            phone: user.phone ?? "",
            birthDate: toDateInput(user.birthDate),
        },
    })

    const onSaveProfile = async (data: ProfileInput) => {
        try {
            setSaving(true)
            const res = await fetch("/api/auth/profile", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...data, birthDate }),
            })
            const result = await res.json()
            if (!res.ok) {
                toast.error(result.message || "ذخیره‌سازی با خطا مواجه شد")
                return
            }
            toast.success(result.message || "حساب کاربری ذخیره شد")
            reset({ ...data, birthDate })
            router.refresh()
        } catch {
            toast.error("ذخیره‌سازی با خطا مواجه شد")
        } finally {
            setSaving(false)
        }
    }

    const onToggleReminder = async (enabled: boolean) => {
        update({ reminderEnabled: enabled })
        if (enabled) {
            const granted = await requestNotificationPermission()
            toast.info(
                granted
                    ? "یادآور فعال شد؛ در زمان تعیین‌شده به شما اطلاع می‌دهیم"
                    : "برای دریافت یادآور، اجازه‌ی اعلان را در مرورگر بدهید",
            )
        }
    }

    const changePassword = async (e: React.FormEvent) => {
        e.preventDefault()
        setPasswordError(null)
        setPasswordSuccess(null)
        if (passwordForm.currentPassword === passwordForm.newPassword) {
            setPasswordError("رمز عبور جدید باید با فعلی متفاوت باشد")
            return
        }
        if (passwordForm.newPassword !== passwordForm.confirmPassword) {
            setPasswordError("رمز عبور جدید و تکرار آن یکسان نیست")
            return
        }
        setPasswordLoading(true)
        try {
            const res = await fetch("/api/auth/change-password", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    currentPassword: passwordForm.currentPassword,
                    newPassword: passwordForm.newPassword,
                    newPasswordConfirm: passwordForm.confirmPassword,
                }),
            })
            const json = await res.json()
            if (!res.ok) {
                setPasswordError(json.message || "خطا در تغییر رمز عبور")
                return
            }
            setPasswordSuccess(json.message || "رمز عبور تغییر یافت ✅")
            setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" })
            toast.success(json.message || "رمز عبور تغییر یافت ✅")
        } catch {
            setPasswordError("خطا در ارتباط با سرور")
        } finally {
            setPasswordLoading(false)
        }
    }

    return (
        <div className={styles.wrap}>
            <div className={styles.sidebar}>
                <div className={styles.sidebarUser}>
                    <Avatar user={user} size="lg" />
                    <div className={styles.sidebarUserInfo}>
                        <strong>{user.firstName || user.username}</strong>
                        <span>{user.email}</span>
                    </div>
                </div>

                <nav className={styles.nav}>
                    <button
                        type="button"
                        className={`${styles.navItem} ${tab === "account" ? styles.navItemActive : ""}`}
                        onClick={() => setTab("account")}
                    >
                        👤 حساب کاربری
                    </button>
                    <button
                        type="button"
                        className={`${styles.navItem} ${tab === "preferences" ? styles.navItemActive : ""}`}
                        onClick={() => setTab("preferences")}
                    >
                        ⚙️ تنظیمات
                    </button>
                    <button
                        type="button"

                        className={`${styles.navItem} ${tab === "install" ? styles.navItemActive : ""}`}
                        onClick={() => setTab("install")}
                    >
                        📲 نصب برنامه
                    </button>
                    <button
                        type="button"

                        className={`${styles.navItem} ${tab === "info" ? styles.navItemActive : ""}`}
                        onClick={() => setTab("info")}
                    >
                        📚 اطلاعات
                    </button>
                </nav>
            </div>

            <div className={styles.content}>
                <AnimatePresence mode="wait" initial={false}>
                {/* ===== حساب کاربری ===== */}
                {tab === "account" && (
                    <motion.section key="account" className={styles.section} {...tabMotion}>
                        <h2 className={styles.title}>حساب کاربری</h2>
                        <p className={styles.subtitle}>اطلاعات شخصی خود را مدیریت کنید.</p>

                        <form onSubmit={handleSubmit(onSaveProfile)} className="dp-form">
                            <div className={styles.avatarRow}>
                                <AvatarUpload user={user} />
                                <div>
                                    <strong>{user.username}</strong>
                                    <p className={styles.muted}>
                                        روی دایره بزنید تا عکس پروفایل آپلود شود — عکس به‌صورت خودکار فشرده می‌شود.
                                    </p>
                                </div>
                            </div>

                            <FormInput
                                formItem={{ name: "username", type: "text", label: "نام کاربری", placeholder: "نام کاربری" }}
                                register={register}
                                errors={errors}
                            />

                            <FormInput
                                formItem={{ name: "firstName", type: "text", label: "نام", placeholder: "مثلاً علی" }}
                                register={register}
                                errors={errors}
                            />

                            <FormInput
                                formItem={{ name: "lastName", type: "text", label: "نام خانوادگی", placeholder: "مثلاً محمدی" }}
                                register={register}
                                errors={errors}
                            />

                            <FormInput
                                formItem={{ name: "phone", type: "tel", label: "شماره تماس", placeholder: "مثلاً 0912xxxxxxx" }}
                                register={register}
                                errors={errors}
                            />

                            <div className="dp-field">
                                <label className="dp-field-label">تاریخ تولد</label>
                                <input
                                    type="date"
                                    value={birthDate}
                                    onChange={(e) => setBirthDate(e.target.value)}
                                    className="dp-input"
                                />
                            </div>

                            <button type="submit" className="dp-btn dp-btn-primary" disabled={saving}>
                                {saving ? "در حال ذخیره..." : "ذخیره تغییرات"}
                            </button>
                        </form>

                        {/* بخش تغییر رمز عبور */}
                        <div className={styles.card} style={{ marginTop: 8 }}>
                            <h3 className={styles.cardTitle}>🔐 تغییر رمز عبور</h3>
                            <p className={styles.muted}>
                                اگر پسورد فعلی‌تان را به یاد دارید، می‌توانید آن را تغییر دهید. کسانی که از روش‌های دیگر
                                (مثل ایمیل یا شبکه‌های اجتماعی) وارد شده‌اند، می‌توانند این بخش را供給 کنند.
                            </p>
                            {passwordSuccess && (
                                <div className={styles.passwordSuccess}>{passwordSuccess}</div>
                            )}
                            {passwordError && (
                                <div className={styles.passwordError}>{passwordError}</div>
                            )}
                            {!passwordSuccess && (
                                <form className="dp-form" onSubmit={changePassword}>
                                    <div className="dp-field">
                                        <label className="dp-field-label">رمز عبور فعلی</label>
                                        <input
                                            type="password"
                                            className="dp-input"
                                            placeholder="رمز عبور فعلی را وارد کنید"
                                            value={passwordForm.currentPassword}
                                            onChange={(e) => setPasswordForm(f => ({ ...f, currentPassword: e.target.value }))}
                                        />
                                    </div>
                                    <div className="dp-field">
                                        <label className="dp-field-label">رمز عبور جدید</label>
                                        <input
                                            type="password"
                                            className="dp-input"
                                            placeholder="رمز عبور جدید را وارد کنید"
                                            value={passwordForm.newPassword}
                                            onChange={(e) => setPasswordForm(f => ({ ...f, newPassword: e.target.value }))}
                                        />
                                    </div>
                                    <div className="dp-field">
                                        <label className="dp-field-label">تکرار رمز عبور جدید</label>
                                        <input
                                            type="password"
                                            className="dp-input"
                                            placeholder="رمز عبور جدید را دوباره وارد کنید"
                                            value={passwordForm.confirmPassword}
                                            onChange={(e) => setPasswordForm(f => ({ ...f, confirmPassword: e.target.value }))}
                                        />
                                    </div>
                                    <button
                                        type="submit"
                                        className="dp-btn dp-btn-primary dp-btn-block"
                                        disabled={passwordLoading}
                                    >
                                        {passwordLoading ? "در حال تغییر..." : "تغییر رمز عبور"}
                                    </button>
                                </form>
                            )}
                        </div>
                    </motion.section>
                )}

                {/* ===== تنظیمات ===== */}
                {tab === "preferences" && (
                    <motion.section key="preferences" className={styles.section} {...tabMotion}>
                        <h2 className={styles.title}>تنظیمات</h2>
                        <p className={styles.subtitle}>ظاهر و رفتار برنامه را مطابق سلیقه‌تان تنظیم کنید.</p>

                        <div className={styles.card}>
                            <h3 className={styles.cardTitle}>🎨 تم برنامه</h3>
                            <div className={styles.themeRow}>
                                {([
                                    { key: "light", label: "روشن", icon: "☀️" },
                                    { key: "dark", label: "تیره", icon: "🌙" },
                                    { key: "system", label: "سیستم", icon: "🖥️" },
                                ] as const).map((opt) => (
                                    <button
                                        key={opt.key}
                                        type="button"
                                        className={`${styles.themeOption} ${settings.theme === opt.key ? styles.themeOptionActive : ""}`}
                                        onClick={() => update({ theme: opt.key })}
                                    >
                                        <span className={styles.themeIcon}>{opt.icon}</span>
                                        {opt.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className={styles.card}>
                            <div className={styles.toggleRow}>
                                <div>
                                    <h3 className={styles.cardTitle}>🔔 صدای اعلان</h3>
                                    <p className={styles.muted}>پخش بوق کوتاه هنگام یادآور و اعلان‌ها</p>
                                </div>
                                <button
                                    type="button"
                                    className={`${styles.switch} ${settings.sound ? styles.switchOn : ""}`}
                                    role="switch"
                                    aria-checked={settings.sound}
                                    onClick={() => update({ sound: !settings.sound })}
                                >
                                    <span className={styles.switchKnob} />
                                </button>
                            </div>
                            <button type="button" className="dp-btn dp-btn-ghost" onClick={playBeep}>
                                ▶️ تست صدا
                            </button>
                        </div>

                        <div className={styles.card}>
                            <div className={styles.toggleRow}>
                                <div>
                                    <h3 className={styles.cardTitle}>⏰ یادآور روزانه</h3>
                                    <p className={styles.muted}>در زمان مشخص، یادآوری برنامه‌ریزی روزانه دریافت کنید</p>
                                </div>
                                <button
                                    type="button"
                                    className={`${styles.switch} ${settings.reminderEnabled ? styles.switchOn : ""}`}
                                    role="switch"
                                    aria-checked={settings.reminderEnabled}
                                    onClick={() => onToggleReminder(!settings.reminderEnabled)}
                                >
                                    <span className={styles.switchKnob} />
                                </button>
                            </div>
                            {settings.reminderEnabled && (
                                <div className={styles.reminderRow}>
                                    <label className="dp-field-label">زمان یادآور</label>
                                    <input
                                        type="time"
                                        value={settings.reminderTime}
                                        onChange={(e) => update({ reminderTime: e.target.value })}
                                        className="dp-input"
                                    />
                                </div>
                            )}
                        </div>
                    </motion.section>
                )}


                {/* ===== نصب برنامه (PWA) ===== */}
                {tab === "install" && (
                    <motion.section key="install" className={styles.section} {...tabMotion}>
                        <h2 className={styles.title}>نصب برنامه</h2>
                        <p className={styles.subtitle}>
                            Daily Pilot را مثل یک اپ واقعی روی گوشی یا کامپیوترت نصب کن.
                        </p>
                        <InstallCard />
                    </motion.section>
                )}


                {/* ===== اطلاعات ===== */}
                {tab === "info" && (
                    <motion.section key="info" className={styles.section} {...tabMotion}>
                        <h2 className={styles.title}>اطلاعات</h2>
                        <p className={styles.subtitle}>درباره ما، بازخورد شما و حریم خصوصی.</p>

                        <div className={styles.infoTabs}>
                            {([
                                { key: "about", label: "درباره ما" },
                                { key: "feedback", label: "انتقادات و پیشنهادات" },
                                { key: "privacy", label: "حریم خصوصی" },
                            ] as const).map((t) => (
                                <button
                                    key={t.key}
                                    type="button"
                                    className={`${styles.infoTab} ${infoTab === t.key ? styles.infoTabActive : ""}`}
                                    onClick={() => setInfoTab(t.key)}
                                >
                                    {t.label}
                                </button>
                            ))}
                        </div>

                        {infoTab === "about" && (
                            <div className={styles.card}>
                                <h3 className={styles.cardTitle}>درباره Daily Pilot</h3>
                                <p className={styles.text}>
                                    Daily Pilot یک برنامه‌ی هوشمند برنامه‌ریزی روزانه است که با کمک هوش مصنوعی
                                    به شما کمک می‌کند کارهای روزانه‌تان را اولویت‌بندی کنید، برای هر کار زمان
                                    واقع‌بینانه‌ای تخصیص دهید و عادت‌های بهتری بسازید.
                                </p>
                                <p className={styles.text}>
                                    موتور برنامه‌ریزی ما با در نظر گرفتن بودجه‌ی زمانی روز، اهمیت هر کار و
                                    تخمین زمان آن، برنامه‌ای متعادل می‌سازد که هم واقع‌بینانه باشد و هم
                                    به‌سادگی قابل انجام.
                                </p>
                                <p className={styles.text}>ساخته‌شده با ❤️ برای روزهای بهتر.</p>
                            </div>
                        )}

                        {infoTab === "feedback" && (
                            <FeedbackForm />
                        )}

                        {infoTab === "privacy" && (
                            <div className={styles.card}>
                                <h3 className={styles.cardTitle}>سیاست حفظ حریم خصوصی</h3>
                                <p className={styles.text}>
                                    اطلاعات حساب شما (نام، ایمیل و تنظیمات) فقط برای ارائه‌ی سرویس برنامه‌ریزی
                                    استفاده می‌شود و هرگز به اشخاص ثالث فروخته یا واگذار نمی‌شود.
                                </p>
                                <p className={styles.text}>
                                    وظایف روزانه و برنامه‌های شما خصوصی نگه داشته می‌شوند و تنها خودتان به آن‌ها
                                    دسترسی دارید.
                                </p>
                                <p className={styles.text}>
                                    تنظیمات ظاهر و صدا به‌صورت محلی در مرورگر شما ذخیره می‌شوند و به سرور ارسال
                                    نمی‌شوند.
                                </p>
                                <p className={styles.text}>
                                    برای هرگونه سؤال درباره‌ی حریم خصوصی، از طریق بخش «انتقادات و پیشنهادات»
                                    با ما در تماس باشید.
                                </p>
                            </div>
                        )}
                    </motion.section>
                )}
                </AnimatePresence>
            </div>
        </div>
    )
}

function FeedbackForm() {
    const [message, setMessage] = useState("")
    const [email, setEmail] = useState("")

    const submit = () => {
        if (!message.trim()) {
            toast.error("لطفاً متن پیام را بنویسید")
            return
        }
        const subject = encodeURIComponent("بازخورد کاربر Daily Pilot")
        const body = encodeURIComponent(`${message.trim()}\\n\\n— از طرف: ${email.trim() || "کاربر ناشناس"}`)
        window.location.href = `mailto:support@dailypilot.app?subject=${subject}&body=${body}`
        toast.success("برنامه‌ی ایمیل شما باز می‌شود؛ فقط کافی است ارسال را بزنید")
    }

    return (
        <div className={styles.card}>
            <h3 className={styles.cardTitle}>انتقادات و پیشنهادات</h3>
            <p className={styles.muted}>
                نظر شما برای بهتر شدن Daily Pilot ارزشمند است. پیام خود را بنویسید تا از طریق ایمیل برای ما ارسال شود.
            </p>
            <div className="dp-form">
                <div className="dp-field">
                    <label className="dp-field-label">ایمیل شما (اختیاری)</label>
                    <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="example@email.com"
                        className="dp-input"
                    />
                </div>
                <div className="dp-field">
                    <label className="dp-field-label">پیام شما</label>
                    <textarea
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        rows={5}
                        placeholder="نظر، پیشنهاد یا انتقاد خود را بنویسید..."
                        className="dp-input"
                    />
                </div>
                <button type="button" className="dp-btn dp-btn-primary" onClick={submit}>
                    ارسال بازخورد
                </button>
            </div>
        </div>
    )
}