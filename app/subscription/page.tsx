// صفحهٔ اشتراک — انتخاب کاربر سمت سرور، رندر سمت کلاینت.
//
// الگوی احراز هویت پروژه عیناً همان `getCurrentUser()` است که در
// `app/dashboard/layout.tsx` و `app/dashboard/settings/page.tsx` استفاده می‌شود؛
// الگوی جدیدی اختراع نشده.
//
// این صفحه برای مهمان هم باز می‌ماند (بدون redirect) تا لینک‌های عمومی مثل
// «مشاهدهٔ اشتراک» نشکنند؛ فقط `user` به لایهٔ کلاینت داده می‌شود تا فرم کد هدیه
// برای کاربر احراز‌شده رندر و برای مهمان اصلاً نمایش داده نشود.

import { getCurrentUser } from "@/app/lib/getCurrentUser"
import SubscriptionView from "./SubscriptionView"

export default async function SubscriptionPage() {
    const user = await getCurrentUser()

    return <SubscriptionView user={user === null ? null : { id: user.id }} />
}
