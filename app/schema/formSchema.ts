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
)

