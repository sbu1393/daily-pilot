import { cookies } from "next/headers"
import jwt from "jsonwebtoken"
import { getPrisma } from "./getPrisma"
// فاز ۵ — گام ۱۳: resolve پلن مؤثر فقط از entitlement.service (مالک lazy expiration و effective plan)
// می‌آید؛ هیچ منطق انقضا/تمدیدی این‌جا تکرار نمی‌شود (سند §17/§27).
import { resolveEffectivePlan } from "./services/entitlement.service"
// فاز صفر §26 — خطای زیرساختِ lookup کاربر از boundary مرکزی observability عبور می‌کند
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

/**
 * کاربر جاری درخواست — تنها مسیر resolve کاربر احراز‌شده (سند فاز ۵ §18/§36 گام ۱۳).
 *
 * پلن برگشتی همیشه **سرور-محور و مؤثر** است:
 * - `User.plan` یک آینه‌ی سروری است (سند §18) و هرگز به‌عنوان منبع حقیقت استفاده نمی‌شود؛
 *   عمداً حتی از `select` هم خوانده نمی‌شود تا مقدار کهنه نتواند به مصرف‌کننده برسد.
 * - مقدار نهایی از `resolveEffectivePlan` (entitlement.service) می‌آید: ردیف ACTIVE و معتبر → PRO،
 *   منقضی/بدون ردیف → FREE، با lazy expiration طبق §17 (transition شرطی و بدون downgrade تمدید هم‌زمان).
 * - JWT فقط `{id, email}` است و هیچ plan/role از آن خوانده نمی‌شود (سند فاز ۴/۵).
 */
export async function getCurrentUser() {
    const cookieStore = await cookies()

    const token = cookieStore.get("token")

    if (!token) {
        return null
    }

    const secret = process.env.JWT_SECRET

    if (!secret) {
        throw new Error("JWT_SECRET is not defined")
    }

    let decoded: { id: number; email: string }

    // M1 — انتظاری: توکن نامعتبر/منقضی/دستکاری‌شده → کاربر ناشناس، بدون لاگ نویز.
    try {
        decoded = jwt.verify(token.value, secret, { algorithms: ["HS256"] }) as {
            id: number
            email: string
        }
    } catch {
        return null
    }

    // M1 — غیرانتظاری: خطای زیرساخت/دیتابیس. بازگرداندن null یعنی «نشستی وجود ندارد»
    // و به ۴۰۱ گمراه‌کننده تبدیل می‌شود؛ پس با context لاگ می‌شود و بالا می‌رود تا مسیر
    // استاندارد ۵۰۰ (ADR-02/ADR-04) آن را مدیریت کند. جزئیات خام هرگز به کلاینت نمی‌رود.
    try {
        const prisma = getPrisma()

        const user = await prisma.user.findUnique({
            where: {
                id: decoded.id,
            },

            select: {
                id: true,

                username: true,

                email: true,

                firstName: true,

                lastName: true,

                image: true,

                birthDate: true,

                phone: true,

                timezone: true,

                // فاز ۴ — role از DB در هر request خوانده می‌شود؛ هرگز داخل JWT نمی‌رود
                // (revocation فوری در request بعدی؛ سند Phase 4 «Role Model»)
                role: true,

                // فاز ۵ — گام ۱۳: `plan` از این select حذف شد؛ مقدار کهنه‌ی آینه‌ی سروری هرگز به
                // مصرف‌کننده (planPolicy/quota) نمی‌رسد و پلن از entitlement resolve می‌شود.
            },
        })

        if (!user) {
            return null
        }

        // فاز ۵ — گام ۱۳: پلن مؤثر سرور-محور (lazy expiration + resolve plan داخل entitlement.service).
        // هیچ mutation دیگری این‌جا رخ نمی‌دهد؛ تنها نوشتن ممکن همان materialize شدن انقضا است (§17).
        const plan = await resolveEffectivePlan(prisma, user.id)

        return { ...user, plan }
    } catch (error) {
        // فاز صفر §26 — لاگ خام حذف شد. در این نقطه identity قطعی نیست (ممکن است پیش از
        // احراز هویت کامل اجرا شود) → context فقط requestId/endpoint دارد و هیچ userId ندارد.
        await recordError(error, createObservabilityContext("getCurrentUser"))

        throw error
    }
}
