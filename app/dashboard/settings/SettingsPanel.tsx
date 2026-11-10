"use client"

import { useEffect, useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { toast } from "react-toastify"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { AnimatePresence, motion } from "framer-motion"
import Avatar from "@/app/components/Avatar"
import AvatarUpload from "@/app/components/AvatarUpload"
import FormInput from "@/app/components/FormInput"
import AnimatedModal from "@/app/components/motion/AnimatedModal"
import { profileSchema } from "@/app/schema/formSchema"
import { useSettings } from "@/app/contexts/SettingsContext"
import { ensureOfflineScope, setOfflineUserId } from "@/app/lib/offline"
import { api } from "@/app/lib/api/client"
import {
    ensurePushSubscription,
    fetchReminderSchedule,
    hasNotificationPermission,
    removePushSubscription,
    sendTestNotification,
    syncReminderSchedule,
    type PushFailureReason,
} from "@/app/lib/pushSubscription"
import {
    isNativeLocalNotificationPlatform,
    requestLocalNotificationPermission,
} from "@/app/lib/native/local-notifications"
import {
    enableNativeDailyReminder,
    isDailyReminderLaterToday,
} from "@/app/lib/native/daily-reminder"
import moment from "moment-jalaali"
import { faDigits } from "@/app/lib/time"
import { SETTINGS_PRIVACY_PARAGRAPHS } from "@/app/lib/privacyContent"
import { DEFAULT_TIMEZONE, timezoneOptionsWith } from "@/app/lib/timezones"
import InstallCard from "@/app/components/pwa/InstallCard"
import styles from "./settings.module.css"
import taskStyles from "@/app/components/task/task.module.css"
import { AlarmClock, BellRing, Download, LaptopMinimalCheck, LibraryBig, LifeBuoy, Loader2, LockKeyholeOpen, MonitorCog, Moon, Palette, Send, Settings, SunMedium, Trash2, UserRound } from "lucide-react"

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
    timezone: string | null
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

/* پیام‌های فارسی خطاهای Push — بدون افشای جزئیات فنی به کاربر.
 * هر پیام روشن می‌کند که یادآور همان‌جا هم بیکار نمانده: تا وقتی برنامه باز است،
 * تایمر صفحه یادآور را نشان می‌دهد (تخریب تدریجی، نه شکست کامل). */
const PUSH_REASON_LABEL: Record<PushFailureReason, string> = {
    UNSUPPORTED: "مرورگر این دستگاه از اعلان پس‌زمینه پشتیبانی نمی‌کند؛ یادآور فقط وقتی برنامه باز است کار می‌کند",
    NOT_CONFIGURED: "اعلان پس‌زمینه روی سرور فعال نشده است؛ یادآور فقط وقتی برنامه باز است کار می‌کند",
    PERMISSION_DENIED: "برای دریافت یادآور، اجازه‌ی اعلان را در مرورگر بدهید",
    NO_REGISTRATION: "برنامه روی این دستگاه کامل نصب نشده است؛ یادآور فقط وقتی برنامه باز است کار می‌کند",
    SUBSCRIBE_FAILED: "ثبت اعلان روی این دستگاه ناموفق بود؛ یادآور فقط وقتی برنامه باز است کار می‌کند",
    SERVER_REJECTED: "سرور اشتراک اعلان را نپذیرفت؛ یادآور فقط وقتی برنامه باز است کار می‌کند",
    RATE_LIMITED: "تعداد تلاش‌ها زیاد بود؛ چند دقیقه بعد امتحان کن",
}

/* انیمیشن ورود محتوای هر تب */
const tabMotion = {
    initial: { opacity: 0, y: 14 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -10, transition: { duration: .15 } },
    transition: { duration: .28, ease: "easeOut" as const },
}

export default function SettingsPanel({ user }: { user: UserData }) {
    const router = useRouter()
    const { settings, update, playBeep, requestNotificationPermission } = useSettings()
    const [tab, setTab] = useState<Tab>("account")
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
    const timezoneOptions = timezoneOptionsWith(user.timezone)
    // دکمه‌ی اعلان آزمایشی — وضعیت مستقل تا بقیهٔ دکمه‌ها را قفل نکند.
    const [testNotificationLoading, setTestNotificationLoading] = useState(false)
    // خروجی داده‌ها و Danger Zone — هرکدام وضعیت بارگذاری جدا دارند.
    const [exportLoading, setExportLoading] = useState(false)
    const [deleteOpen, setDeleteOpen] = useState(false)
    const [deletePassword, setDeletePassword] = useState("")
    const [deleteLoading, setDeleteLoading] = useState(false)
    // گارد هم‌گام‌سازی یک‌بارهٔ اشتراک Push
    const pushSyncedRef = useRef(false)
    /*
     * سرور منبع حقیقت یادآور است:
     * - `reminderHydratedRef` تا وقتی اسنپ‌شات سرور نرسیده، همگام‌سازی را متوقف
     *   می‌کند تا با مقدار localStorage (که فقط cache است) سرور را بازنویسی نکنیم.
     * - `serverReminderSnapshotRef` آخرین وضعیت شناخته‌شدهٔ سرور است؛ اگر بعد از
     *   hydration مقدار تغییر نکرده باشد، POST تکراری فرستاده نمی‌شود.
     * - `reminderUserEditedRef` جلوی بازنویسیِ انتخاب کاربر را می‌گیرد اگر او
     *   قبل از رسیدن پاسخ GET سوییچ را عوض کرده باشد.
     */
    const reminderHydratedRef = useRef(false)
    const reminderUserEditedRef = useRef(false)
    const serverReminderSnapshotRef = useRef<string | null>(null)
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
            timezone: user.timezone ?? DEFAULT_TIMEZONE,
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
        reminderUserEditedRef.current = true
        const next = { ...reminder, [part]: value } as typeof reminder
        update({ reminderTime: reminderTimeToHHMM(next.h12, next.minute, next.period) })
    }

    /*
     * هم‌گام‌سازی خودکار اشتراک Push: اگر یادآور فعال و مجوز داده شده باشد،
     * با باز شدن صفحه‌ی تنظیمات اشتراک این دستگاه دوباره ثبت می‌شود (بدون prompt).
     * این کار endpointهای چرخیده/باطل‌شده را تازه می‌کند.
     *
     * روی Android native این کار انجام نمی‌شود: یادآور آنجا با اعلان محلی
     * زمان‌بندی می‌شود و ساختن PushSubscription برای همان دستگاه یعنی cron هم
     * Push بفرستد ⇒ دو اعلان برای یک یادآور.
     */
    useEffect(() => {
        if (pushSyncedRef.current) return
        if (!settings.reminderEnabled) return

        const isNative = isNativeLocalNotificationPlatform()
        if (!isNative && !hasNotificationPermission()) return
        if (isNative) return

        pushSyncedRef.current = true
        void ensurePushSubscription({ requestPermission: false })
    }, [settings.reminderEnabled])

    /*
     * Hydration از سرور (منبع حقیقت) — فقط یک‌بار هنگام mount.
     *
     * localStorage قبلاً تنها منبع بود؛ نتیجه: سوییچ روی دستگاه دوم با واقعیت
     * سرور (که cron بر اساسش Push می‌فرستد) یکی نبود. اکنون ابتدا اسنپ‌شات سرور
     * خوانده و روی state اعمال می‌شود. اگر سرور در دسترس نباشد (`null`)، همان
     * مقدار cache باقی می‌ماند و اولین تغییر کاربر آن را برای سرور می‌فرستد.
     */
    useEffect(() => {
        let cancelled = false

        void (async () => {
            /*
             * اول scope نشست را قطعی می‌کنیم. `SettingsContext` تنظیمات را با
             * کلید user-scoped می‌خواند؛ اگر اسنپ‌شات سرور پیش از مشخص‌شدن scope
             * اعمال شود، effect بعدی ممکن است مقدار localStorage (anon/حساب قبلی)
             * را روی آن بنویسد. `ensureOfflineScope` با سایر فراخوانی‌ها dedupe
             * می‌شود، پس درخواست اضافی نمی‌سازد.
             */
            await ensureOfflineScope()
            if (cancelled) return

            const snapshot = await fetchReminderSchedule()
            if (cancelled) return

            reminderHydratedRef.current = true
            if (!snapshot) return

            serverReminderSnapshotRef.current = `${snapshot.enabled}|${snapshot.time}`

            // اگر کاربر پیش از رسیدن پاسخ چیزی را عوض کرده، انتخاب او را نمی‌بلعیم.
            if (reminderUserEditedRef.current) return

            update({ reminderEnabled: snapshot.enabled, reminderTime: snapshot.time })
        })()

        return () => {
            cancelled = true
        }
    }, [update])

    /*
     * آینه‌کردن برنامه‌ی یادآور روی سرور با یک تأخیر کوچک (debounce):
     * تریگر cron سرور از همین مقدار استفاده می‌کند. تغییر سریع دقیقه‌ها
     * (اسکرول select) بنابراین یک درخواست می‌فرستد، نه ده‌تا.
     *
     * عمداً دیگر به مجوز اعلان وابسته نیست: «انتخاب ساعت» و «اجازهٔ نمایش اعلان»
     * دو موضوع جدا هستند. اگر مجوز نبود، Push ارسال نمی‌شود ولی سرور باید بداند
     * کاربر چه ساعتی را می‌خواهد تا روی دستگاه دیگری که مجوز دارد کار کند.
     *
     * روی Android native هم نگه داشته می‌شود: دستگاه‌های دیگرِ همان حساب
     * (مرورگر) باید همچنان از مسیر Web Push یادآور بگیرند.
     */
    useEffect(() => {
        // تا اسنپ‌شات سرور نرسیده، مقدار localStorage را به‌عنوان حقیقت نفرست.
        if (!reminderHydratedRef.current) return

        const current = `${settings.reminderEnabled}|${settings.reminderTime}`
        if (current === serverReminderSnapshotRef.current) return

        const timer = setTimeout(async () => {
            const result = await syncReminderSchedule({
                enabled: settings.reminderEnabled,
                time: settings.reminderTime,
            })
            if (result.ok) serverReminderSnapshotRef.current = current
        }, 800)

        return () => clearTimeout(timer)
    }, [settings.reminderEnabled, settings.reminderTime])

    /*
     * یادآور دو لایه دارد:
     *  ۱. تایمر صفحه (مرورگر) — وقتی برنامه باز است.
     *  ۲. Web Push (مرورگر) یا اعلان محلی نیتیو (Android) — وقتی برنامه بسته است.
     *
     * ترتیب روی Android **عمداً برعکس مرورگر** است: اول مجوز نیتیو کامل
     * می‌شود، تازه بعد `reminderEnabled=true` می‌شود. اگر برعکس بود، effect
     * نیتیو با مجوزِ هنوز «prompt» اجرا می‌شد، `schedule()` صدا زده نمی‌شد و
     * آن شکست بی‌صدا می‌ماند — یعنی یادآور روشن بود ولی هیچ آلارمی وجود نداشت.
     * مسیر مرورگر و ترتیبش دست‌نخورده می‌ماند.
     */
    const onToggleReminder = async (enabled: boolean) => {
        reminderUserEditedRef.current = true
        const isNative = isNativeLocalNotificationPlatform()

        if (!enabled) {
            // خاموش شدن یادآور = لغو اعلان محلی (خود `SettingsContext` با شناسه‌ی
            // پایدار) + لغو اشتراک Push این دستگاه + آینه‌ی سرور.
            // `removePushSubscription` روی دستگاهی که Push ندارد خودش no-op است و
            // اگر اشتراکی از قبل در DB مانده باشد پاکش می‌کند، پس فراخوانی‌اش
            // در هر دو حالت بی‌خطر و مفید است. آینه‌ی سرور را effect debounce‌شده
            // انجام می‌دهد (برای روشن/خاموش یکسان).
            update({ reminderEnabled: false })
            void removePushSubscription()
            return
        }

        /*
         * Android: مجوز از پل نیتیو گرفته می‌شود نه از `Notification` مرورگر
         * (که در WebView اصلاً وجود ندارد و همیشه false برمی‌گرداند).
         * `enableNativeDailyReminder` خودش ترتیب «مجوز ← فعال‌سازی» را تضمین
         * می‌کند و زمان‌بندی واقعی را به `SettingsContext` می‌سپارد تا شناسه‌ی
         * اعلان از یک جا (scope نشست) بیاید.
         */
        if (isNative) {
            const outcome = await enableNativeDailyReminder({
                requestPermission: requestLocalNotificationPermission,
                setEnabled: (on) => update({ reminderEnabled: on }),
            })

            if (!outcome.ok) {
                toast.info(PUSH_REASON_LABEL.PERMISSION_DENIED)
                return
            }

            toast.info(
                isDailyReminderLaterToday(new Date(), settings.reminderTime)
                    ? "یادآور فعال شد؛ حتی وقتی برنامه بسته است هم یادآوری می‌شوی"
                    : "یادآور فعال شد؛ چون ساعت امروز گذشته بود، اولین یادآور فردا در همان ساعت است",
            )
            return
        }

        /* مرورگر — ترتیب و رفتار این مسیر عیناً قبلاً می‌ماند. */
        update({ reminderEnabled: true })

        if (!(await requestNotificationPermission())) {
            toast.info(PUSH_REASON_LABEL.PERMISSION_DENIED)
            return
        }

        const result = await ensurePushSubscription({ requestPermission: true })
        toast.info(
            result.ok
                ? "یادآور فعال شد؛ حتی وقتی برنامه بسته است هم برایت اعلان می‌فرستیم"
                : PUSH_REASON_LABEL[result.reason],
        )
    }

    /*
     * اعلان آزمایشی: endpoint سرور به همان دستگاه‌های همین کاربر Push می‌فرستد.
     * این دکمه «انتخاب ساعت» را تغییر نمی‌دهد و اشتراکی نمی‌سازد؛ فقط مسیر
     * انتها-به-انتها (مجوز ← اشتراک ← سرور ← Push) را تأیید می‌کند.
     */
    const onSendTestNotification = async () => {
        if (testNotificationLoading) return
        setTestNotificationLoading(true)
        try {
            const result = await sendTestNotification()

            if (!result.ok) {
                toast.error(PUSH_REASON_LABEL[result.reason])
                return
            }

            if (result.sent === 0) {
                toast.info(
                    "دستگاهی برای ارسال پیدا نشد؛ ابتدا یادآور روزانه را روشن کن و اجازهٔ اعلان را بده",
                )
                return
            }

            toast.success(
                result.failed > 0
                    ? `اعلان آزمایشی ارسال شد (${faDigits(result.sent)} موفق، ${faDigits(result.failed)} ناموفق)`
                    : `اعلان آزمایشی برای ${faDigits(result.sent)} دستگاه ارسال شد ✅`,
            )
        } catch {
            // sendTestNotification خودش خطاها را ساختاریافته برمی‌گرداند؛ این
            // شاخه فقط برای خطاهای غیرمنتظره (مثلاً قطع کامل شبکه) است.
            toast.error("ارسال اعلان آزمایشی ناموفق بود؛ کمی بعد دوباره تلاش کن")
        } finally {
            setTestNotificationLoading(false)
        }
    }

    /*
     * دریافت نسخه پشتیبان: چون پاسخ `Content-Disposition: attachment` است،
     * از fetch + Blob استفاده می‌کنیم تا خطاهای HTTP (401/429/500) هم به
     * Toast تبدیل شوند؛ ناوبری مستقیم به لینک در خطا صفحهٔ JSON نشان می‌داد.
     */
    const onExportData = async () => {
        if (exportLoading) return
        setExportLoading(true)
        try {
            const response = await fetch("/api/user/export", {
                method: "GET",
                headers: { Accept: "application/json" },
                cache: "no-store",
            })

            if (!response.ok) {
                const payload = (await response.json().catch(() => null)) as
                    | { error?: { message?: string }; message?: string }
                    | null
                toast.error(
                    payload?.error?.message ??
                        payload?.message ??
                        "دریافت نسخه پشتیبان ناموفق بود",
                )
                return
            }

            const blob = await response.blob()
            const objectUrl = URL.createObjectURL(blob)
            const link = document.createElement("a")
            link.href = objectUrl
            link.download = "roozsaz-data.json"
            document.body.appendChild(link)
            link.click()
            link.remove()
            URL.revokeObjectURL(objectUrl)
            toast.success("نسخه پشتیبان با موفقیت دانلود شد ✅")
        } catch {
            toast.error("دریافت نسخه پشتیبان ناموفق بود؛ اتصال را بررسی کن")
        } finally {
            setExportLoading(false)
        }
    }

    /*
     * حذف حساب: تأیید دوم با رمز عبور. دکمه تا ورود رمز غیرفعال است و
     * مودال در حین درخواست بسته نمی‌شود تا کاربر دوباره ارسال نکند.
     */
    const onDeleteAccount = async () => {
        if (!deletePassword || deleteLoading) return
        setDeleteLoading(true)
        try {
            await api("/api/user/delete-account", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password: deletePassword }),
            })
            toast.success("حساب کاربری حذف شد")
            setDeleteOpen(false)
            setDeletePassword("")
            // پاک‌کردن scope محلی تا تنظیمات/کش حساب حذف‌شده روی دستگاه نماند.
            setOfflineUserId(null)
            // Reload کامل: وضعیت احراز هویت و کش‌های کلاینت باید از صفر ساخته شوند.
            window.location.assign("/")
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "حذف حساب کاربری ناموفق بود")
        } finally {
            setDeleteLoading(false)
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
            const message = error instanceof Error ? error.message : "خطا در ارتباط با سرور"
            setPasswordError(message)
            toast.error(message)
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

                <nav className={styles.nav} aria-label="بخش‌های تنظیمات">
                    <button
                        type="button"
                        className={`${styles.navItem} ${tab === "account" ? styles.navItemActive : ""}`}
                        onClick={() => setTab("account")}
                        aria-current={tab === "account" ? "page" : undefined}
                    >
                        <UserRound /> حساب کاربری
                    </button>
                    <button
                        type="button"
                        className={`${styles.navItem} ${tab === "preferences" ? styles.navItemActive : ""}`}
                        onClick={() => setTab("preferences")}
                        aria-current={tab === "preferences" ? "page" : undefined}
                    >
                        <Settings /> تنظیمات برنامه
                    </button>
                    <button
                        type="button"

                        className={`${styles.navItem} ${tab === "install" ? styles.navItemActive : ""}`}
                        onClick={() => setTab("install")}
                        aria-current={tab === "install" ? "page" : undefined}
                    >
                        <LaptopMinimalCheck /> نصب برنامه
                    </button>
                    <button
                        type="button"

                        className={`${styles.navItem} ${tab === "info" ? styles.navItemActive : ""}`}
                        onClick={() => setTab("info")}
                        aria-current={tab === "info" ? "page" : undefined}
                    >
                        <LibraryBig /> درباره و پشتیبانی
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

                            {/* اعداد فارسی فقط برای نام و نام خانوادگی — یوزرنیم/ایمیل/تلفن عمداً مستثنی‌اند */}
                            <div className="fa-digits">
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
                            </div>

                            <FormInput
                                formItem={{ name: "phone", type: "tel", label: "شماره تماس", placeholder: "مثلاً 0912xxxxxxx" }}
                                register={register}
                                errors={errors}
                            />

                            {/*
                             * منطقه زمانی: یادآور سروری (cron) ساعت را با همین
                             * مقدار تفسیر می‌کند. مقدار پیش‌فرض DB `Asia/Tehran`
                             * است؛ کاربرانی که خارج از ایران‌اند می‌توانند آن را
                             * اصلاح کنند تا یادآور در ساعت محلی خودشان برسد.
                             */}
                            <div className="dp-form-group">
                                <label className="dp-label" htmlFor="timezone">منطقه زمانی</label>
                                <select
                                    id="timezone"
                                    className={`dp-input ${errors.timezone ? "dp-input-error" : ""}`}
                                    {...register("timezone")}
                                >
                                    {timezoneOptions.map((option) => (
                                        <option key={option.value} value={option.value}>
                                            {option.label}
                                        </option>
                                    ))}
                                </select>
                                <p className={styles.muted}>
                                    ساعت یادآور و روزکاری بر اساس این منطقه زمانی محاسبه می‌شود.
                                </p>
                                {errors.timezone && (
                                    <p className="dp-error-text">
                                        {String(errors.timezone.message ?? "")}
                                    </p>
                                )}
                            </div>

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
                                {saving && (
                                    <Loader2 size={16} className={styles.spinner} aria-hidden="true" />
                                )}
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
                                        {passwordLoading && (
                                            <Loader2 size={16} className={styles.spinner} aria-hidden="true" />
                                        )}
                                        {passwordLoading ? "در حال تغییر..." : "تغییر رمز عبور"}
                                    </button>
                                </form>
                            )}
                        </div>

                        {/*
                         * خروجی داده‌ها: فایل JSON سمت سرور ساخته می‌شود و با
                         * Content-Disposition دانلود می‌شود. هیچ داده‌ای از سمت
                         * کلاینت تعیین نمی‌کند چه چیزی/برای چه کسی صادر شود.
                         */}
                        <div className={styles.card}>
                            <h3 className={styles.cardTitle}><Download /> نسخه پشتیبان داده‌ها</h3>
                            <p className={styles.muted}>
                                یک فایل JSON شامل پروفایل، تسک‌ها، برنامه‌های روزانه و تنظیمات
                                ذخیره‌شده روی سرور دریافت کنید. رمز عبور و اطلاعات نشست در این
                                فایل نیست.
                            </p>
                            <button
                                type="button"
                                className="dp-btn dp-btn-primary"
                                onClick={onExportData}
                                disabled={exportLoading}
                                aria-busy={exportLoading}
                            >
                                {exportLoading && (
                                    <Loader2 size={16} className={styles.spinner} aria-hidden="true" />
                                )}
                                {exportLoading ? "در حال آماده‌سازی..." : "دریافت فایل JSON"}
                            </button>
                        </div>

                        {/*
                         * Danger Zone: آخرین کارت تب حساب کاربری. حذف فقط با
                         * تأیید رمز عبور در مودال انجام می‌شود؛ این کارت خودش
                         * هیچ داده‌ای را حذف نمی‌کند.
                         */}
                        <div className={`${styles.card} ${styles.dangerZone}`}>
                            <h3 className={styles.cardTitle}><Trash2 /> منطقه خطر</h3>
                            <p className={styles.muted}>
                                حذف حساب کاربری بازگشت‌پذیر نیست. همهٔ تسک‌ها، برنامه‌های
                                روزانه، تنظیمات و اشتراک‌های اعلان شما پاک می‌شوند.
                            </p>
                            <div>
                                <button
                                    type="button"
                                    className="dp-btn dp-btn-danger"
                                    onClick={() => setDeleteOpen(true)}
                                >
                                    <Trash2 size={16} aria-hidden="true" />
                                    حذف حساب کاربری
                                </button>
                            </div>
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

                        {/*
                         * تست اعلان — بدون این دکمه هیچ راهی برای تأیید انتها-به-انتها
                         * وجود نداشت. سرور فقط به دستگاه‌های همین کاربر Push می‌فرستد
                         * و سقف ۵ بار در ۱۵ دقیقه دارد.
                         */}
                        <div className={styles.card}>
                            <h3 className={styles.cardTitle}><Send /> تست اعلان</h3>
                            <p className={styles.muted}>
                                یک اعلان آزمایشی فوری برای دستگاه‌های همین حساب ارسال می‌شود تا از
                                درستی مجوز و اشتراک اعلان مطمئن شوید.
                            </p>
                            <button
                                type="button"
                                className="dp-btn dp-btn-ghost"
                                onClick={onSendTestNotification}
                                disabled={testNotificationLoading}
                            >
                                {testNotificationLoading && (
                                    <Loader2 size={16} className={styles.spinner} aria-hidden="true" />
                                )}
                                {testNotificationLoading ? "در حال ارسال..." : "ارسال اعلان آزمایشی"}
                            </button>
                        </div>
                    </motion.section>
                )}


                {/* ===== نصب برنامه (PWA) ===== */}
                {tab === "install" && (
                    <motion.section key="install" className={styles.section} {...tabMotion}>
                        <h2 className={styles.title}>نصب برنامه</h2>
                        <p className={styles.subtitle}>
                            روزساز را مثل یک اپ واقعی روی گوشی یا کامپیوترت نصب کن.
                        </p>
                        <InstallCard />
                    </motion.section>
                )}


                {/* ===== اطلاعات و پشتیبانی ===== */}
                {tab === "info" && (
                    <motion.section key="info" className={styles.section} {...tabMotion}>
                        <h2 className={styles.title}>درباره و پشتیبانی</h2>
                        <p className={styles.subtitle}>
                            درباره روزساز، حریم خصوصی و راه‌های ارتباط با ما.
                        </p>

                        {/*
                         * قبلاً این تب سه زیرتب داشت و «بازخورد» فقط یک mailto
                         * ناقص بود. اکنون همه‌چیز یک‌جا و بدون ناوبری تودرتو
                         * نمایش داده می‌شود و مسیر بازخورد به سامانه تیکت
                         * (که پیگیری واقعی دارد) وصل شده است.
                         */}
                        <div className={styles.card}>
                            <h3 className={styles.cardTitle}>درباره روزساز</h3>
                            <p className={styles.text}>
                                روزساز یک برنامه‌ی هوشمند برنامه‌ریزی روزانه است که با کمک هوش مصنوعی
                                به شما کمک می‌کند کارهای روزانه‌تان را اولویت‌بندی کنید، برای هر کار
                                زمان واقع‌بینانه‌ای تخصیص دهید و عادت‌های بهتری بسازید.
                            </p>
                            <p className={styles.text}>
                                موتور برنامه‌ریزی ما با در نظر گرفتن بودجه‌ی زمانی روز، اهمیت هر کار و
                                تخمین زمان آن، برنامه‌ای متعادل می‌سازد که هم واقع‌بینانه باشد و هم
                                به‌سادگی قابل انجام.
                            </p>
                            <p className={styles.text}>ساخته‌شده با ❤️ برای روزهای بهتر.</p>
                        </div>

                        <div className={styles.card}>
                            <h3 className={styles.cardTitle}><LifeBuoy /> پشتیبانی و تیکت‌ها</h3>
                            <p className={styles.muted}>
                                برای گزارش مشکل، پیگیری درخواست یا ارسال پیشنهاد، یک تیکت ثبت کنید؛
                                پاسخ‌ها در همین حساب قابل مشاهده و پیگیری هستند.
                            </p>
                            <div className={styles.actionRow}>
                                <Link href="/support/new" className="dp-btn dp-btn-primary">
                                    ثبت تیکت جدید
                                </Link>
                                <Link href="/support" className="dp-btn dp-btn-ghost">
                                    تیکت‌های من
                                </Link>
                            </div>
                        </div>

                        <div className={styles.card}>
                            <h3 className={styles.cardTitle}>سیاست حفظ حریم خصوصی</h3>
                            {/* متن از app/lib/privacyContent.ts خوانده می‌شود تا با صفحه‌ی
                                /privacy یکی باشد. این نسخه دو ادعای نادرستِ نسخه‌ی قبلی را
                                اصلاح می‌کند: «هرگز به اشخاص ثالث واگذار نمی‌شود» (درست
                                نبود — عنوان کار به 1xai.ir و ایمیل به Resend می‌رود) و
                                «تنظیمات به سرور ارسال نمی‌شوند» (یادآور روزانه روی سرور
                                ذخیره می‌شود تا Push ارسال شود). */}
                            {SETTINGS_PRIVACY_PARAGRAPHS.map((paragraph) => (
                                <p key={paragraph} className={styles.text}>
                                    {paragraph}
                                </p>
                            ))}
                            <Link href="/privacy" className={styles.text}>
                                متن کامل سیاست حریم خصوصی
                            </Link>
                        </div>
                    </motion.section>
                )}
                </AnimatePresence>

                {/* مودال تأیید حذف حساب — بیرون از AnimatePresence تا با تغییر تب ناگهان unmount نشود. */}
                <AnimatedModal
                    open={deleteOpen}
                    onClose={() => {
                        if (!deleteLoading) setDeleteOpen(false)
                    }}
                >
                    <div className={taskStyles.modalHead}>
                        <h4>حذف حساب کاربری</h4>
                        <button
                            type="button"
                            className={taskStyles.closeBtn}
                            onClick={() => {
                                if (!deleteLoading) setDeleteOpen(false)
                            }}
                            aria-label="بستن"
                        >
                            ✕
                        </button>
                    </div>

                    <p className={taskStyles.hint}>
                        این عمل بازگشت‌پذیر نیست. برای تأیید، رمز عبور فعلی خود را وارد کنید.
                    </p>

                    <div className="dp-form-group">
                        <label className="dp-label" htmlFor="delete-account-password">
                            رمز عبور فعلی
                        </label>
                        <input
                            id="delete-account-password"
                            type="password"
                            className="dp-input"
                            value={deletePassword}
                            onChange={(e) => setDeletePassword(e.target.value)}
                            autoComplete="current-password"
                            disabled={deleteLoading}
                            autoFocus
                        />
                    </div>

                    <div className={taskStyles.modalActions}>
                        <button
                            type="button"
                            className="dp-btn dp-btn-danger"
                            onClick={onDeleteAccount}
                            disabled={!deletePassword || deleteLoading}
                        >
                            {deleteLoading && (
                                <Loader2 size={16} className={styles.spinner} aria-hidden="true" />
                            )}
                            {deleteLoading ? "در حال حذف..." : "حذف دائمی حساب"}
                        </button>
                        <button
                            type="button"
                            className="dp-btn dp-btn-ghost"
                            onClick={() => setDeleteOpen(false)}
                            disabled={deleteLoading}
                        >
                            انصراف
                        </button>
                    </div>
                </AnimatedModal>
            </div>
        </div>
    )
}