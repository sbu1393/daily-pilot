// G-09 — Service Layer: خطاهای سرویس
// Route فقط status/message را به شکل Envelope ADR-04 ({ ok:false, error:{code,message,errors?} })
// به Client برمی‌گرداند (A6).

export class ServiceError extends Error {
    readonly status: number
    readonly code: string
    readonly errors?: unknown

    constructor(status: number, code: string, message: string, errors?: unknown) {
        super(message)
        this.name = new.target.name
        this.status = status
        this.code = code
        this.errors = errors
    }
}

// A6 — بدنه‌ی خالص Envelope خطا (بدون NextResponse — قابل تست در vitest)
export function toServiceErrorBody(
    error: unknown,
): { ok: false; error: { code: string; message: string; errors?: unknown } } | null {
    if (!(error instanceof ServiceError)) return null
    const body: { ok: false; error: { code: string; message: string; errors?: unknown } } = {
        ok: false,
        error: { code: error.code, message: error.message },
    }
    if (error.errors !== undefined) body.error.errors = error.errors
    return body
}

// ---------- Tasks ----------

export class TaskNotFoundError extends ServiceError {
    constructor() {
        super(404, "TASK_NOT_FOUND", "تسک پیدا نشد")
    }
}

export class MissingDayKeyError extends ServiceError {
    constructor() {
        super(400, "MISSING_DAY_KEY", "تاریخ برنامه‌ریزی تسک نامعتبر است")
    }
}

export class TaskAlreadyDoneError extends ServiceError {
    constructor() {
        super(400, "TASK_ALREADY_DONE", "این تسک قبلاً تمام شده است")
    }
}

export class TaskNotAnalyzeableError extends ServiceError {
    constructor(status: "DONE" | "IN_PROGRESS") {
        super(
            400,
            "TASK_NOT_ANALYZEABLE",
            status === "DONE"
                ? "تسک انجام‌شده را نمی‌توان دوباره تحلیل کرد"
                : "تسک در حال انجام را نمی‌توان دوباره تحلیل کرد",
        )
    }
}

export class OverdueTaskError extends ServiceError {
    constructor() {
        super(400, "OVERDUE_TASK", "این تسک مربوط به روزهای گذشته است؛ اول آن را به امروز منتقل کن.")
    }
}

export class NoRolloverCandidatesError extends ServiceError {
    constructor() {
        super(404, "NO_ROLLOVER_CANDIDATES", "تسکی برای انتقال پیدا نشد")
    }
}

// ---------- Auth / Users ----------

export class EmailTakenError extends ServiceError {
    constructor() {
        super(409, "EMAIL_TAKEN", "این ایمیل قبلا ثبت شده")
    }
}

export class InvalidCredentialsError extends ServiceError {
    constructor() {
        super(401, "INVALID_CREDENTIALS", "ایمیل یا رمز عبور اشتباه است")
    }
}

export class UserNotFoundError extends ServiceError {
    constructor() {
        super(404, "USER_NOT_FOUND", "کاربری یافت نشد")
    }
}

export class WrongPasswordError extends ServiceError {
    constructor() {
        super(401, "WRONG_PASSWORD", "رمز عبور فعلی اشتباه است")
    }
}

export class SamePasswordError extends ServiceError {
    constructor() {
        super(400, "SAME_PASSWORD", "رمز عبور جدید باید با رمز فعلی متفاوت باشد")
    }
}

export class UsernameTakenError extends ServiceError {
    constructor() {
        super(409, "USERNAME_TAKEN", "این نام کاربری قبلاً استفاده شده است")
    }
}