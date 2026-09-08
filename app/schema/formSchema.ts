import { z } from "zod"


export const registerSchema = z.object({

    username: z
        .string()
        .min(3,"نام کاربری حداقل ۳ کاراکتر باشد"),


    email: z
        .string()
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
    .email("ایمیل معتبر نیست"),


    password:z
    .string()
    .min(1,"رمز عبور را وارد کنید")

})



export const profileSchema = z.object({

    username: z
        .string()
        .min(3, "نام کاربری حداقل ۳ کاراکتر باشد")
        .max(30, "نام کاربری حداکثر ۳۰ کاراکتر باشد"),


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
    data => (data.username ?? "").trim().length >= 3,
    { message: "نام کاربری حداقل ۳ کاراکتر باشد", path: ["username"] }
).refine(
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

/** اعتبارسنجی تاریخ تولد: قالب YYYY-MM-DD و تاریخ تقویمی واقعی */
function isValidBirthDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const [y, m, d] = value.split("-").map(Number)
    if (m < 1 || m > 12) return false
    const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
    const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]
    return d >= 1 && d <= daysInMonth
}

