package ir.roozsaz.app.alarm;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import java.util.List;

import ir.roozsaz.app.MainActivity;

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

    /**
     * سقف تلاش برای هم‌گرا کردن دوبارهٔ زمان‌بندی پس از لغو. هر تلاش شامل
     * خواندن رکورد، ثبت، و بازخوانی برای تأیید است؛ حلقه هرگز بی‌نهایت نیست.
     */
    private static final int MAX_RESTORE_ATTEMPTS = 3;

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
        long now = System.currentTimeMillis();
        long at = Math.max(alarm.at, now + 1_000L);

        /* گواهِ «فراخوانی schedule اصلاً رسید» — نقطه‌ی شروعِ زنجیره در native. */
        Log.i(TAG, "SCHEDULE alarmId=" + alarm.id
                + " taskId=" + alarm.taskId
                + " requestCode=" + alarm.id
                + " at=" + at
                + " now=" + now
                + " deltaMs=" + (at - now)
                + " exactAllowed=" + canScheduleExact(context)
                + " " + TaskAlarmProcess.describe(context));

        if (canScheduleExact(context)) {
            /*
             * showIntent باید MainActivity باشد، نه TaskAlarmActivity:
             * TaskAlarmActivity صفحهٔ «آلارم در جریان» است و باز شدنش نباید
             * هیچ نقشی در شروع صدا داشته باشد. با این انتخاب، تپ روی آیکن
             * «آلارم بعدی» فقط اپ را باز می‌کند.
             */
            Intent show = new Intent(context.getApplicationContext(), MainActivity.class);
            show.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

            PendingIntent showIntent =
                    PendingIntent.getActivity(context.getApplicationContext(), alarm.id, show, pendingFlags());

            try {
                alarmManager.setAlarmClock(new AlarmManager.AlarmClockInfo(at, showIntent), pending);
                Log.i(TAG, "setAlarmClock OK alarmId=" + alarm.id + " at=" + at);
                return true;
            } catch (SecurityException e) {
                /* مجوز سلب شده؛ به مسیر غیردقیق برمی‌گردیم. */
                Log.e(TAG, "setAlarmClock FAILED alarmId=" + alarm.id, e);
                Log.w(TAG, "setAlarmClock رد شد؛ مسیر غیردقیق", e);
            } catch (Exception e) {
                /* هر خطای دیگری — مثلاً محدودیت سازنده — نباید بی‌نشان بماند. */
                Log.e(TAG, "setAlarmClock FAILED alarmId=" + alarm.id, e);
            }
        }

        try {
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
            Log.i(TAG, "setAndAllowWhileIdle OK alarmId=" + alarm.id + " at=" + at);
        } catch (Exception e) {
            Log.e(TAG, "setAndAllowWhileIdle FAILED alarmId=" + alarm.id, e);
            Log.w(TAG, "setAndAllowWhileIdle شکست خورد", e);
        }

        return false;
    }

    public static boolean cancel(Context context, int alarmId) {
        AlarmManager alarmManager = manager(context);
        if (alarmManager == null) return false;

        Log.i(TAG, "CANCEL alarmId=" + alarmId
                + " requestCode=" + alarmId
                + " " + TaskAlarmProcess.describe(context));

        try {
            PendingIntent pending = fireIntent(context, alarmId);
            alarmManager.cancel(pending);
            pending.cancel();
            return true;
        } catch (Exception e) {
            Log.e(TAG, "CANCEL_FAILED alarmId=" + alarmId, e);
            return false;
        }
    }

    /**
     * لغو زمان‌بندی بعد از حذف موفق رکورد.
     *
     * <p>اگر در همین فاصله رکورد جدیدی برای همان شناسه ساخته شده باشد
     * (مثلاً Snooze هم‌زمان)، لغو بالا ممکن است زمان‌بندی جدید را هم گرفته
     * باشد؛ پس رکورد آینده را دوباره ثبت می‌کنیم. به این ترتیب پاک‌سازی نشست
     * قدیمی هرگز Snooze جدید را از بین نمی‌برد.
     *
     * <p><b>چرا فقط یک بار خواندن کافی نیست:</b> بین «خواندن رکورد» و
     * «{@code schedule}» یک پنجرهٔ واقعی هست؛ اگر Snooze در همان پنجره رکورد
     * را با {@code at} جدیدتر جایگزین و خودش زمان‌بندی کند، ثبتِ بعدیِ ما
     * می‌تواند زمان‌بندی جدیدتر را با مقدار قدیمی بازنویسی کند. برای همین
     * بعد از هر ثبت دوباره رکورد را می‌خوانیم و اگر {@code at} عوض شده یا
     * رکورد حذف شده، در تلاش بعدی تصحیح می‌کنیم. حداکثر
     * {@value #MAX_RESTORE_ATTEMPTS} تلاش انجام می‌شود.
     *
     * <p><b>پنجرهٔ باقی‌مانده (قابل حذف نیست):</b> AlarmManager و SQLite دو
     * سیستم جدا با قفل مشترک نیستند؛ حتی بعد از آخرین بازخوانی هم ممکن است
     * یک Snooze جدید بلافاصله رکورد را عوض کند. این تابع آن را «تا حد امکان»
     * تصحیح می‌کند، نه اتمیک. آخرین بازخوانی/ثبت هم در همین پنجره است.
     */
    public static void cancelAndRestoreIfRecreated(Context context, int alarmId) {
        cancel(context, alarmId);

        long now = System.currentTimeMillis();
        TaskAlarmStore.Alarm lastScheduled = null;

        for (int attempt = 1; attempt <= MAX_RESTORE_ATTEMPTS; attempt++) {
            TaskAlarmStore.Alarm current = TaskAlarmStore.get(context, alarmId);

            if (current == null) {
                /*
                 * رکورد در این فاصله حذف شده است. اگر در تلاش قبلی چیزی
                 * زمان‌بندی کرده‌ایم، همان را هم برمی‌داریم تا آلارمِ
                 * حذف‌شده شلیک نشود. اگر رکورد تازه‌ای همین حالا ساخته شود،
                 * تلاش بعدی آن را می‌بیند و ثبت می‌کند.
                 */
                if (lastScheduled != null) {
                    cancel(context, alarmId);
                    lastScheduled = null;
                }
                continue;
            }

            if (current.at <= now + 1_000L) {
                /*
                 * رکورد گذشته/در حال زنگ: زمان‌بندی آینده لازم نیست. اگر در
                 * تلاش قبلی زمان‌بندیِ قدیمی‌تری ثبت کرده‌ایم، همان را هم
                 * برمی‌داریم تا شلیکِ کهنه باقی نماند.
                 */
                if (lastScheduled != null) cancel(context, alarmId);
                return;
            }

            Log.w(TAG, "CANCEL_RESTORE_NEWER alarmId=" + alarmId
                    + " at=" + current.at
                    + " now=" + now
                    + " attempt=" + attempt);
            schedule(context, current);
            lastScheduled = current;

            TaskAlarmStore.Alarm after = TaskAlarmStore.get(context, alarmId);
            if (after == null) continue;
            if (after.at == current.at) return;

            Log.w(TAG, "CANCEL_RESTORE_CHANGED alarmId=" + alarmId
                    + " scheduledAt=" + current.at
                    + " storeAt=" + after.at
                    + " attempt=" + attempt);
        }

        /*
         * سقف تلاش تمام شد. یک بار دیگر جدیدترین مقدار را می‌خوانیم و اگر
         * رکورد آینده‌ای هست، همان را ثبت می‌کنیم؛ ترجیح می‌دهیم آخرین
         * مقدار شناخته‌شده زمان‌بندی شود تا این‌که نسخهٔ قدیمی باقی بماند.
         */
        TaskAlarmStore.Alarm latest = TaskAlarmStore.get(context, alarmId);
        if (latest == null) {
            if (lastScheduled != null) cancel(context, alarmId);
            Log.w(TAG, "CANCEL_RESTORE_GIVEUP_GONE alarmId=" + alarmId);
            return;
        }

        if (latest.at > now + 1_000L) {
            schedule(context, latest);
            Log.w(TAG, "CANCEL_RESTORE_GIVEUP_SCHEDULED alarmId=" + alarmId
                    + " at=" + latest.at);
        }
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
        TaskAlarmStore.Session session = TaskAlarmStore.session(context);
        int active = session == null ? -1 : session.alarmId;

        List<TaskAlarmStore.Alarm> alarms = TaskAlarmStore.all(context);
        for (TaskAlarmStore.Alarm alarm : alarms) {
            if (alarm.at <= now) {
                /*
                 * روی تغییر زمان/منطقه ممکن است یک زنگ در جریان باشد. رکورد
                 * نشست فعال را نکش؛ توقف آن با فرمان صریح/autoStop انجام
                 * می‌شود. در reboot، BootReceiver قبلاً active را پاک کرده است.
                 */
                if (alarm.id != active) {
                    if (!TaskAlarmStore.delete(context, alarm.id)) {
                        Log.e(TAG, "RESCHEDULE_DELETE_FAILED alarmId=" + alarm.id);
                    }
                }
                continue;
            }
            schedule(context, alarm);
        }
    }

    /**
     * بازیابی هنگام باز شدن دوباره‌ی اپ (مسیر اصلی مقابله با «اپ از Recent Apps
     * حذف شد و آلارم گم شد»).
     *
     * <p>چرا این متد از {@link #rescheduleAll} جداست:
     * {@code rescheduleAll} برای «ری‌استارت دستگاه» طراحی شده و رکوردهای گذشته را
     * از ذخیره‌ساز پاک می‌کند. اینجا اما داریم «باز شدن اپ» را پوشش می‌دهیم؛ پاک
     * کردنِ رکوردهایی که در آینده‌ی نزدیک زنگ زده‌اند، بازخورد «زنگ زد» را از
     * آینه‌ی UI می‌پراند. پس فقط **زمان‌بندی** می‌شود، نه حذف.
     *
     * <p>چرا تکرارِ فراخوانی بی‌خطر است (نباید duplicate alarm بسازد):
     * شناسه‌ی هر آلارم قطعی و پایدار است و {@link #fireIntent} برای همان شناسه
     * **همان** PendingIntent را برمی‌گرداند (یکتاییِ PendingIntent از
     * requestCode + action + component ساخته می‌شود؛ extras دخیل نیست).
     * {@code AlarmManager} هم با هر بار صدا زدنِ ثبت، آلارمِ قبلیِ همان
     * PendingIntent را <b>جایگزین</b> می‌کند، نه اینکه کنارش بگذارد. پس صد بار
     * هم صدا زده شود، دقیقاً یک آلارم برای هر شناسه باقی می‌ماند.
     *
     * @return تعداد آلارم‌های آینده‌ای که دوباره روی AlarmManager ثبت شدند.
     */
    public static int rescheduleUpcoming(Context context) {
        long now = System.currentTimeMillis();
        int restored = 0;

        for (TaskAlarmStore.Alarm alarm : TaskAlarmStore.all(context)) {
            /* گذشته ⇒ رکورد دست‌نخورده می‌ماند و چیزی ثبت نمی‌شود. */
            if (alarm.at <= now) continue;

            schedule(context, alarm);
            restored++;
        }

        return restored;
    }
}
