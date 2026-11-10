import { z } from "zod"

/**
 * نام کاربری — **یک** قرارداد مشترک برای ثبت‌نام و ویرایش پروفایل.
 *
 * قبلاً ثبت‌نام فقط `min(3)` داشت و پروفایل سقف ۳۰؛ نتیجه اینکه کاربری که با
 * نام ۳۱+ کاراکتری ثبت‌نام کرده بود هرگز نمی‌توانست فرم پروفایل را ذخیره کند.
 * الگو یونیکد-آگاه است (`\p{L}`) تا نام‌های فارسی/عربی رد نشوند، ولی فاصله،
 * اسلش و کاراکترهای کنترلی را می‌بندد. عمداً `toLowerCase` اعمال نمی‌شود تا
 * نام‌های کاربری موجود (و حساسیت حروف در DB) دست‌نخورده بمانند.
 */
export const usernameSchema = z
    .string()
    .trim()
    .min(3, "نام کاربری حداقل ۳ کاراکتر باشد")
    .max(30, "نام کاربری حداکثر ۳۰ کاراکتر باشد")
    .regex(
        /^[\p{L}\p{N}_.-]+$/u,
        "نام کاربری فقط می‌تواند شامل حروف، اعداد، نقطه، خط تیره و زیرخط باشد",
    )


export const registerSchema = z.object({

    username: usernameSchema,


    email: z
        .string()
        .trim()
        .toLowerCase()
        .email("ایمیل معتبر نیست"),


    password: z
        .string()
        .min(8,"رمز عبور حداقل ۸ کاراکتر باشد"),


    confirmPassword:z
        .string()

})
.refine(
    data => data.password === data.confirmPassword,
    {
        message:"رمز عبور و تکرار آن یکسان نیست",
        path:["confirmPassword"]
    }
)



export const loginSchema = z.object({

    email:z
    .string()
    .trim()
    .toLowerCase()
    .email("ایمیل معتبر نیست"),


    password:z
    .string()
    .min(1,"رمز عبور را وارد کنید")

})



export const profileSchema = z.object({

    /*
     * اختیاری است تا PATCH واقعاً partial باشد: اگر کلاینت فقط `phone` بفرستد،
     * همین یک فیلد بررسی/به‌روزرسانی می‌شود و بقیه دست‌نخورده می‌مانند.
     * وقتی فرستاده شود، دقیقاً همان قرارداد ثبت‌نام را دارد.
     */
    username: usernameSchema.optional(),


    firstName: z
        .string()
        .max(50, "نام حداکثر ۵۰ کاراکتر باشد")
        .optional()
        .nullable(),


    lastName: z
        .string()
        .max(50, "نام خانوادگی حداکثر ۵۰ کاراکتر باشد")
        .optional()
        .nullable(),


    phone: z
        .string()
        .regex(/^[0-9+\-\s]{7,20}$/, "شماره تماس معتبر نیست")
        .optional()
        .nullable()
        .or(z.literal("")),


    birthDate: z
        .string()
        .optional()
        .nullable()
        .or(z.literal(""))

}).refine(
    (data) =>
        data.birthDate == null ||
        data.birthDate === "" ||
        isValidBirthDate(data.birthDate),
    { message: "تاریخ تولد معتبر نیست", path: ["birthDate"] },
)

export const changePasswordSchema = z
    .object({
        currentPassword: z.string().min(1, "رمز عبور فعلی را وارد کنید"),
        newPassword: z
            .string()
            .min(8, "رمز عبور جدید حداقل ۸ کاراکتر باشد")
            .max(128, "رمز عبور جدید بسیار طولانی است"),
        newPasswordConfirm: z.string(),
    })
    .refine(
        (data) => data.newPassword === data.newPasswordConfirm,
        { message: "رمز عبور جدید و تکرار آن یکسان نیست", path: ["newPasswordConfirm"] },
    )

/** POST /api/auth/forgot-password — فقط ایمیل؛ هیچ چیز دیگری از کلاینت. */
export const forgotPasswordSchema = z.object({
    email: z
        .string()
        .trim()
        .toLowerCase()
        .email("ایمیل معتبر نیست"),
})

/**
 * POST /api/auth/set-new-password — عمداً **بدون** `currentPassword`.
 *
 * علت: در این وضعیت کاربر با رمز *موقت* لاگین کرده و آن رمز فقط یک‌بارمصرف
 * است. اگر اینجا رمز فعلی را هم می‌خواستیم، یا کاربر باید رمز موقت را دوباره
 * وارد می‌کرد (که با «یک‌بارمصرف» در تناقض است) یا باید از نشستِ همین لحظه
 * عبور می‌کرد.
 *
 * امنیت از دو جای دیگر می‌آید: (۱) endpoint فقط با نشستِ معتبر کار می‌کند،
 * (۲) همان نشست فقط وقتی ساخته شده که OTP هم تأیید شده بود. پس «احراز شده» در
 * این مسیر یعنی «ایمیل هم تأیید شده».
 */
export const setNewPasswordSchema = z
    .object({
        newPassword: z
            .string()
            .min(8, "رمز عبور جدید حداقل ۸ کاراکتر باشد")
            .max(128, "رمز عبور جدید بسیار طولانی است"),
        newPasswordConfirm: z.string(),
    })
    .strict()
    .refine((data) => data.newPassword === data.newPasswordConfirm, {
        message: "رمز عبور جدید و تکرار آن یکسان نیست",
        path: ["newPasswordConfirm"],
    })

/** اعتبارسنجی تاریخ تولد: قالب YYYY-MM-DD و تاریخ تقویمی واقعی */
function isValidBirthDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const [y, m, d] = value.split("-").map(Number)
    if (m < 1 || m > 12) return false
    const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
    const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    return d >= 1 && d <= daysInMonth
}

