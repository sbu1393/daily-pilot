package ir.roozsaz.app.alarm;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import java.util.List;

/**
 * زمان‌بندی آلارم‌های تسک روی AlarmManager.
 *
 * <p>انتخاب API (و صراحتاً: چه چیزی تضمین می‌شود و چه چیزی نه):
 *
 * <ul>
 *   <li>{@code setAlarmClock()} — دقیق، مستثنا از Doze/App-Standby، و همراه با
 *       نشان‌دادن آیکن آلارم سیستم. این API فقط وقتی معتبر است که
 *       {@code canScheduleExactAlarms()} مثبت باشد.</li>
 *   <li>اگر مجوز آلارم دقیق داده نشده باشد (روی Android 14+ برای اپ‌های
 *       targetSdk 33+ پیش‌فرض منفی است)، {@code setAndAllowWhileIdle()} استفاده
 *       می‌شود: بیدارکننده است ولی <b>قطعی نیست</b> و سیستم می‌تواند آن را چند
 *       دقیقه به عقب/جلو بیندازد. این حالت به کاربر گزارش می‌شود.</li>
 *   <li>هیچ‌جا ادعا نمی‌کنیم {@code setAndAllowWhileIdle()} دقت را تضمین
 *       می‌کند.</li>
 * </ul>
 *
 * <p>هر آلارم یک {@link PendingIntent} یکتا دارد (requestCode = شناسه‌ی قطعی
 * آلارم)، پس زمان‌بندی دوباره همان آلارم را جایگزین می‌کند و چند PendingIntent
 * هم‌زمان ساخته نمی‌شود. لغو هم با همان PendingIntent انجام می‌شود.
 */
public final class TaskAlarmScheduler {

    private static final String TAG = "TaskAlarm";

    /** اکشن اختصاصی گیرنده‌ی آلارم. */
    public static final String ACTION_FIRE = "ir.roozsaz.app.alarm.FIRE";

    private TaskAlarmScheduler() {
    }

    private static AlarmManager manager(Context context) {
        return (AlarmManager) context.getApplicationContext().getSystemService(Context.ALARM_SERVICE);
    }

    /**
     * آیا سیستم اجازه‌ی آلارم دقیق می‌دهد؟
     * روی API < 31 این مفهوم وجود ندارد و همیشه true است.
     */
    public static boolean canScheduleExact(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;

        AlarmManager alarmManager = manager(context);
        return alarmManager != null && alarmManager.canScheduleExactAlarms();
    }

    private static int pendingFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return flags;
    }

    /** PendingIntent یکتای هر آلارم (برای زمان‌بندی و لغو، یکسان ساخته می‌شود). */
    public static PendingIntent fireIntent(Context context, int alarmId) {
        Intent intent = new Intent(context.getApplicationContext(), TaskAlarmReceiver.class);
        intent.setAction(ACTION_FIRE);
        intent.putExtra(TaskAlarmReceiver.EXTRA_ALARM_ID, alarmId);

        return PendingIntent.getBroadcast(context.getApplicationContext(), alarmId, intent, pendingFlags());
    }

    /**
     * ثبت آلارم.
     *
     * @return true اگر آلارمِ دقیق ثبت شد؛ false یعنی مسیر غیردقیقِ
     *         {@code setAndAllowWhileIdle} استفاده شده است.
     */
    public static boolean schedule(Context context, TaskAlarmStore.Alarm alarm) {
        AlarmManager alarmManager = manager(context);
        if (alarmManager == null) return false;

        PendingIntent pending = fireIntent(context, alarm.id);

        /* چند ثانیه حاشیه تا ثبتِ روی مرزِ «همین حالا» رد نشود. */
        long at = Math.max(alarm.at, System.currentTimeMillis() + 1_000L);

        if (canScheduleExact(context)) {
            Intent show = new Intent(context.getApplicationContext(), TaskAlarmActivity.class);
            show.putExtra(TaskAlarmReceiver.EXTRA_ALARM_ID, alarm.id);
            show.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

            PendingIntent showIntent =
                    PendingIntent.getActivity(context.getApplicationContext(), alarm.id, show, pendingFlags());

            try {
                alarmManager.setAlarmClock(new AlarmManager.AlarmClockInfo(at, showIntent), pending);
                return true;
            } catch (SecurityException e) {
                /* مجوز سلب شده؛ به مسیر غیردقیق برمی‌گردیم. */
                Log.w(TAG, "setAlarmClock رد شد؛ مسیر غیردقیق", e);
            }
        }

        try {
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
        } catch (Exception e) {
            Log.w(TAG, "setAndAllowWhileIdle شکست خورد", e);
        }

        return false;
    }

    public static void cancel(Context context, int alarmId) {
        AlarmManager alarmManager = manager(context);
        if (alarmManager == null) return;

        PendingIntent pending = fireIntent(context, alarmId);
        alarmManager.cancel(pending);
        pending.cancel();
    }

    /**
     * بازیابی پس از reboot، به‌روزرسانی اپ، یا تغییر زمان/منطقه‌ی زمانی.
     *
     * <p>آلارم‌های گذشته حذف می‌شوند (زنگ‌شان بی‌معناست) و آلارم‌های آینده دوباره
     * ثبت می‌شوند. این کار همان چیزی است که «بازیابی پس از ری‌استارت» را
     * محقق می‌کند و کاملاً مستقل از WebView و اینترنت است.
     */
    public static void rescheduleAll(Context context) {
        long now = System.currentTimeMillis();

        List<TaskAlarmStore.Alarm> alarms = TaskAlarmStore.all(context);
        for (TaskAlarmStore.Alarm alarm : alarms) {
            if (alarm.at <= now) {
                TaskAlarmStore.delete(context, alarm.id);
                continue;
            }
            schedule(context, alarm);
        }
    }
}
