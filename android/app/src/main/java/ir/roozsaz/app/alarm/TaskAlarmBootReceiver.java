package ir.roozsaz.app.alarm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * بازیابی آلارم‌ها پس از reboot، به‌روزرسانی اپ، یا تغییر زمان/منطقه‌ی زمانی.
 *
 * <p>AlarmManager آلارم‌ها را در حافظه‌ی سیستم نگه می‌دارد و با ری‌استارت پاک
 * می‌شوند؛ پس باید دوباره از {@link TaskAlarmStore} بازسازی شوند. این کار
 * کاملاً نیتیو است و به باز شدن اپ، WebView، اینترنت یا ورود کاربر وابسته نیست.
 *
 * <p>نکته‌ی صداقتی: برای رسیدن BOOT_COMPLETED اپ باید حداقل یک‌بار اجرا شده
 * باشد و «force stop» توسط کاربر یا بهینه‌سازی‌های سازنده (شیائومی/هوآوی/سامسونگ
 * و مانند آن) می‌تواند آن را محدود کند؛ این محدودیت‌ها خارج از اختیار اپ‌اند.
 */
public class TaskAlarmBootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;

        String action = intent.getAction();

        boolean relevant =
                Intent.ACTION_BOOT_COMPLETED.equals(action)
                        || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                        || Intent.ACTION_TIME_CHANGED.equals(action)
                        || Intent.ACTION_TIMEZONE_CHANGED.equals(action);

        if (!relevant) return;

        TaskAlarmScheduler.rescheduleAll(context);
    }
}
