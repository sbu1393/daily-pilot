package ir.roozsaz.app.alarm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

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

    private static final String TAG = "TaskAlarm";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;

        String action = intent.getAction();

        boolean rebootOrUpdate =
                Intent.ACTION_BOOT_COMPLETED.equals(action)
                        || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);

        boolean relevant = rebootOrUpdate
                || Intent.ACTION_TIME_CHANGED.equals(action)
                || Intent.ACTION_TIMEZONE_CHANGED.equals(action);

        if (!relevant) return;

        Log.i(TAG, "PROC boot " + TaskAlarmProcess.describe(context) + " action=" + action);

        /*
         * بعد از reboot یا به‌روزرسانی، هیچ زنگ زنده‌ای نمی‌تواند باقی مانده
         * باشد. اگر نشانگر نشست فعال مانده باشد، اعلان و رکورد یتیم را همان‌جا
         * جمع می‌کنیم. روی تغییر زمان/منطقه، زنگ در جریان را دست نمی‌زنیم.
         */
        if (rebootOrUpdate) {
            TaskAlarmStore.Session session = TaskAlarmStore.session(context);
            int active = session == null ? -1 : session.alarmId;
            if (active >= 0) {
                Log.w(TAG, "BOOT_CLEAR_ACTIVE alarmId=" + active);
            }

            /*
             * علاوه بر شناسهٔ فعال، اعلان همهٔ رکوردهای شناخته‌شده را می‌بندیم.
             * این کار در reboot بی‌خطر است و اعلان یتیمی را که نشانگر فعالش
             * به هر دلیل از دست رفته هم جمع می‌کند.
             */
            for (TaskAlarmStore.Alarm alarm : TaskAlarmStore.all(context)) {
                TaskAlarmController.cancelNotification(context, alarm.id);
            }

            if (active >= 0) {
                TaskAlarmController.cancelNotification(context, active);
            }

            if (!TaskAlarmStore.clearActiveAlways(context)) {
                Log.e(TAG, "BOOT_CLEAR_ACTIVE_FAILED alarmId=" + active);
            }
        }

        TaskAlarmScheduler.rescheduleAll(context);
    }
}
