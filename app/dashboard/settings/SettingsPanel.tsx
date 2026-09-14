"use client"

import { useState } from "react"
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
import { api } from "@/app/lib/api/client"
import moment from "moment-jalaali"
import { faDigits } from "@/app/lib/time"
import InstallCard from "@/app/components/pwa/InstallCard"
import styles from "./settings.module.css"
import { AlarmClock, BellRing, LaptopMinimalCheck, LibraryBig, LockKeyholeOpen, MonitorCog, Moon, Palette, Settings, SunMedium, UserRound } from "lucide-react"

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

/* ===== لایه‌ی نمایش تاریخ تولد (جلالی) — فقط presentation، مقدار ذخیرهشده میلادی می‌ماند ===== */
const J_MONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"]

function gregorianToJalaliParts(gregorian: string): { jy: number; jm: number; jd: number } | null {
    const m = moment(gregorian, "YYYY-MM-DD")
    if (!gregorian || !m.isValid()) return null
    return { jy: m.jYear(), jm: m.jMonth() + 1, jd: m.jDate() }
}

function jalaliPartsToGregorian(jy: number, jm: number, jd: number): string {
    const pad = (n: number) => String(n).padStart(2, "0")
    return moment(`${jy}-${pad(jm)}-${pad(jd)}`, "jYYYY-jM-jD").format("YYYY-MM-DD")
}

function jalaliDaysInMonth(jy: number, jm: number): number {
    return moment.jDaysInMonth(jy, jm - 1) // moment ماه را صفر-مبنا می‌گیرد
}

type JalaliParts = { jy: number | null; jm: number | null; jd: number | null }

const pad2 = (n: number) => String(n).padStart(2, "0")
const HOURS_12 = Array.from({ length: 12 }, (_, i) => i + 1)
const MINUTES_60 = Array.from({ length: 60 }, (_, i) => i)

/* ===== لایه‌ی نمایش زمان یادآور (صبح/شب) — فقط presentation، مقدار ذخیرهشده HH:MM می‌ماند ===== */
type DayPeriod = "am" | "pm"

function parseReminderTime(value: string): { h12: number; minute: number; period: DayPeriod } {
    const m = /^(\d{1,2}):(\d{2})$/.exec(value ?? "")
    const h24 = m ? Math.min(23, Math.max(0, Number(m[1]))) : 9
    const minute = m ? Math.min(59, Math.max(0, Number(m[2]))) : 0
    return { h12: h24 % 12 || 12, minute, period: h24 < 12 ? "am" : "pm" }
}

function reminderTimeToHHMM(h12: number, minute: number, period: DayPeriod): string {
    const h24 = period === "am" ? (h12 === 12 ? 0 : h12) : h12 === 12 ? 12 : h12 + 12
    return `${pad2(h24)}:${pad2(minute)}`
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
    const [birthJalali, setBirthJalali] = useState<JalaliParts>(() => {
        const p = gregorianToJalaliParts(toDateInput(user.birthDate))
        return { jy: p?.jy ?? null, jm: p?.jm ?? null, jd: p?.jd ?? null }
    })
    const jYearNow = moment().jYear()
    const jDayCount =
        birthJalali.jy != null && birthJalali.jm != null
            ? jalaliDaysInMonth(birthJalali.jy, birthJalali.jm)
            : 31
    const reminder = parseReminderTime(settings.reminderTime)
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
            await api("/api/auth/profile", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...data, birthDate }),
            })
            toast.success("حساب کاربری ذخیره شد")
            reset({ ...data, birthDate })
            router.refresh()
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "ذخیره‌سازی با خطا مواجه شد")
        } finally {
            setSaving(false)
        }
    }

    /* انتخاب جلالی → فقط وقتی هر سه بخش کامل شد، مقدار میلادی معادل برای ذخیره ساخته می‌شود */
    const onBirthJalaliChange = (part: keyof JalaliParts, raw: string) => {
        const value = raw === "" ? null : Number(raw)
        const next: JalaliParts = { ...birthJalali, [part]: value }
        if (next.jy != null && next.jm != null) {
            const days = jalaliDaysInMonth(next.jy, next.jm)
            if (next.jd != null && next.jd > days) next.jd = days
        }
        setBirthJalali(next)
        setBirthDate(
            next.jy != null && next.jm != null && next.jd != null
                ? jalaliPartsToGregorian(next.jy, next.jm, next.jd)
                : "",
        )
    }

    const clearBirthDate = () => {
        setBirthJalali({ jy: null, jm: null, jd: null })
        setBirthDate("")
    }

    /* صبح/شب → HH:MM (ذخیرهسازی بدون تغییر) */
    const setReminderPart = (part: "h12" | "minute" | "period", value: number | DayPeriod) => {
        const next = { ...reminder, [part]: value } as typeof reminder
        update({ reminderTime: reminderTimeToHHMM(next.h12, next.minute, next.period) })
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
            await api("/api/auth/change-password", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    currentPassword: passwordForm.currentPassword,
                    newPassword: passwordForm.newPassword,
                    newPasswordConfirm: passwordForm.confirmPassword,
                }),
            })
            setPasswordSuccess("رمز عبور با موفقیت تغییر یافت ✅")
            setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" })
            toast.success("رمز عبور با موفقیت تغییر یافت ✅")
        } catch (error) {
            setPasswordError(error instanceof Error ? error.message : "خطا در ارتباط با سرور")
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
                        <UserRound /> حساب کاربری
                    </button>
                    <button
                        type="button"
                        className={`${styles.navItem} ${tab === "preferences" ? styles.navItemActive : ""}`}
                        onClick={() => setTab("preferences")}
                    >
                        <Settings /> تنظیمات
                    </button>
                    <button
                        type="button"

                        className={`${styles.navItem} ${tab === "install" ? styles.navItemActive : ""}`}
                        onClick={() => setTab("install")}
                    >
                        <LaptopMinimalCheck /> نصب برنامه
                    </button>
                    <button
                        type="button"

                        className={`${styles.navItem} ${tab === "info" ? styles.navItemActive : ""}`}
                        onClick={() => setTab("info")}
                    >
                        <LibraryBig /> اطلاعات
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
                                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                    <select
                                        className="dp-input"
                                        aria-label="روز"
                                        value={birthJalali.jd ?? ""}
                                        onChange={(e) => onBirthJalaliChange("jd", e.target.value)}
                                        style={{ flex: "1 1 0", minWidth: "4.5rem" }}
                                    >
                                        <option value="">روز</option>
                                        {Array.from({ length: jDayCount }, (_, i) => i + 1).map((d) => (
                                            <option key={d} value={d}>{faDigits(d)}</option>
                                        ))}
                                    </select>
                                    <select
                                        className="dp-input"
                                        aria-label="ماه"
                                        value={birthJalali.jm ?? ""}
                                        onChange={(e) => onBirthJalaliChange("jm", e.target.value)}
                                        style={{ flex: "1 1 0", minWidth: "6rem" }}
                                    >
                                        <option value="">ماه</option>
                                        {J_MONTHS.map((name, i) => (
                                            <option key={i + 1} value={i + 1}>{name}</option>
                                        ))}
                                    </select>
                                    <select
                                        className="dp-input"
                                        aria-label="سال"
                                        value={birthJalali.jy ?? ""}
                                        onChange={(e) => onBirthJalaliChange("jy", e.target.value)}
                                        style={{ flex: "1 1 0", minWidth: "5rem" }}
                                    >
                                        <option value="">سال</option>
                                        {Array.from({ length: jYearNow - 1300 + 1 }, (_, i) => jYearNow - i).map((y) => (
                                            <option key={y} value={y}>{faDigits(y)}</option>
                                        ))}
                                    </select>
                                    {birthDate && (
                                        <button type="button" className="dp-btn dp-btn-ghost" onClick={clearBirthDate}>
                                            پاک کردن
                                        </button>
                                    )}
                                </div>
                            </div>

                            <button type="submit" className="dp-btn dp-btn-primary" disabled={saving}>
                                {saving ? "در حال ذخیره..." : "ذخیره تغییرات"}
                            </button>
                        </form>

                        {/* بخش تغییر رمز عبور */}
                        <div className={styles.card} style={{ marginTop: 8 }}>
                            <h3 className={styles.cardTitle}><LockKeyholeOpen />{" "} تغییر رمز عبور</h3>
                            <p className={styles.muted}>
                                اگر پسورد فعلی‌تان را به یاد دارید، می‌توانید آن را تغییر دهید.
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
                            <h3 className={styles.cardTitle}><Palette /> تم برنامه</h3>
                            <div className={styles.themeRow}>
                                {([
                                    { key: "light", label: "روشن", icon: <SunMedium /> },
                                    { key: "dark", label: "تیره", icon: <Moon /> },
                                    { key: "system", label: "سیستم", icon: <MonitorCog /> },
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
                                    <h3 className={styles.cardTitle}><BellRing /> صدای اعلان</h3>
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
                                    <h3 className={styles.cardTitle}><AlarmClock /> یادآور روزانه</h3>
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
                                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                        <select
                                            className="dp-input"
                                            aria-label="ساعت"
                                            value={reminder.h12}
                                            onChange={(e) => setReminderPart("h12", Number(e.target.value))}
                                        >
                                            {HOURS_12.map((h) => (
                                                <option key={h} value={h}>{faDigits(h)}</option>
                                            ))}
                                        </select>
                                        <select
                                            className="dp-input"
                                            aria-label="دقیقه"
                                            value={reminder.minute}
                                            onChange={(e) => setReminderPart("minute", Number(e.target.value))}
                                        >
                                            {MINUTES_60.map((m) => (
                                                <option key={m} value={m}>{faDigits(pad2(m))}</option>
                                            ))}
                                        </select>
                                        <select
                                            className="dp-input"
                                            aria-label="صبح یا شب"
                                            value={reminder.period}
                                            onChange={(e) => setReminderPart("period", e.target.value as DayPeriod)}
                                        >
                                            <option value="am">صبح</option>
                                            <option value="pm">شب</option>
                                        </select>
                                    </div>
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
                            روزچین را مثل یک اپ واقعی روی گوشی یا کامپیوترت نصب کن.
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
                                <h3 className={styles.cardTitle}>درباره روزچین</h3>
                                <p className={styles.text}>
                                    روزچین یک برنامه‌ی هوشمند برنامه‌ریزی روزانه هست که با کمک هوش مصنوعی
                                    به شما کمک می‌کنه کارهای روزانه‌ خودتون رو اولویت‌ بندی کنین، برای هر کار زمان
                                واقع‌بینانه‌ای تخصیص بدین و عادت‌های بهتری بسازین.
                                </p>
                                <p className={styles.text}>
                                    موتور برنامه‌ریزی ما با در نظر گرفتن بودجه‌ی زمانی روز، اهمیت هر کار و
                                    تخمین زمان آن، برنامه‌ای متعادل میسازه که هم واقع‌بینانه باشه و هم
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
        const subject = encodeURIComponent("بازخورد کاربر روزچین")
        const body = encodeURIComponent(`${message.trim()}\\n\\n— از طرف: ${email.trim() || "کاربر ناشناس"}`)
        window.location.href = `mailto:Roozchin@gmail.com?subject=${subject}&body=${body}`
        toast.success("برنامه‌ی ایمیل شما باز می‌شود؛ فقط کافی است ارسال را بزنید")
    }

    return (
        <div className={styles.card}>
            <h3 className={styles.cardTitle}>انتقادات و پیشنهادات</h3>
            <p className={styles.muted}>
                نظر شما برای بهتر شدن روزچین ارزشمند است. پیام خود را بنویسید تا از طریق ایمیل برای ما ارسال شود.
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