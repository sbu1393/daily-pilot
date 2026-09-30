import { requireVerifiedUser } from "./requireVerifiedUser"
import { ServiceError } from "@/app/lib/services/errors"

// فاز ۴ — Step 4: گارد server-side authorization برای Admin.
//
// Contract قفل‌شده:
//   unauthenticated        → 401 UNAUTHORIZED
//   authenticated non-admin → 403 ADMIN_FORBIDDEN
//   role === "ADMIN"        → allowed (user به caller برمی‌گردد)
//
// Security invariants:
//   - تصمیم فقط بر اساس User.role از DB (getCurrentUser هر request از DB می‌خواند)
//   - role هرگز از JWT claim خوانده نمی‌شود (JWT = {id, email})
//   - هیچ checkی بر اساس email/username/plan/frontend state انجام نمی‌شود
//   - frontend protection صرفاً UX است؛ این گارد تنها مرز امنیتی است

export class AdminForbiddenError extends ServiceError {
    constructor() {
        super(403, "ADMIN_FORBIDDEN", "دسترسی مدیریتی لازم است")
    }
}

export async function requireAdmin() {
    // از گارد مرکزی رد می‌شود تا مسیر مدیریتی هم تا وقتی کاربر رمز موقت دارد
    // مسدود بماند — بدون آن، /api/admin/* می‌شد راه دور زدن enforcement.
    const user = await requireVerifiedUser()
    if (!user) {
        // 401 — استاندارد فعلی repository (same code/envelope as route-level 401)
        throw new ServiceError(401, "UNAUTHORIZED", "Unauthorized")
    }
    // فقط DB-backed role؛ هیچ منبع دیگری (plan/JWT/email) معتبر نیست
    if (user.role !== "ADMIN") {
        throw new AdminForbiddenError()
    }
    return user
}
