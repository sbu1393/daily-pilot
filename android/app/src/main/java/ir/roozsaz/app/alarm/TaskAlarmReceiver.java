package ir.roozsaz.app.alarm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * گیرنده‌ی آلارم تسک.
 *
 * <p>این گیرنده نقطه‌ی شروعِ کاملاً نیتیو است: نه WebView لازم دارد، نه اینترنت،
 * نه نشستِ ورود. فقط AlarmManager آن را صدا می‌زند و بعدش
 * {@link TaskAlarmController} اعلان/صدا/صفحه‌ی آلارم را می‌سازد.
 *
 * <p>اکشن‌های پشتیبانی‌شده:
 * <ul>
 *   <li>{@link TaskAlarmScheduler#ACTION_FIRE} — لحظه‌ی رسیدن زمان؛</li>
 *   <li>{@link #ACTION_STOP} — دکمه‌ی «توقف» روی خودِ اعلان (مسیر پشتیبانِ
 *       توقف، حتی اگر صفحه‌ی تمام‌عرض اجازه‌ی نمایش نگیرد).</li>
 *   <li>{@link #ACTION_SILENCE} — فرمان بین‌پروسه‌ای برای خاموش‌کردن صدای
 *       نشست جاری بدون حذف رکورد/زمان‌بندی.</li>
 *   <li>{@link #ACTION_SNOOZE} — تعویق از مسیر فرمان (اختیاری؛ صفحه‌ی آلارم
 *       معمولاً مستقیم Controller را صدا می‌زند).</li>
 * </ul>
 *
 * <p>این گیرنده در پروسهٔ {@code :alarm} اجرا می‌شود. اکشن‌های کنترلی از
 * پروسهٔ اصلی با broadcast صریح به همین کلاس می‌رسند؛ هیچ متد static از main
 * به player پروسهٔ آلارم دست نمی‌زند.
 */
public class TaskAlarmReceiver extends BroadcastReceiver {

    /** همان تگ کل زنجیره‌ی آلارم تا `adb logcat -s TaskAlarm` همه‌چیز را ببیند. */
    private static final String TAG = "TaskAlarm";

    public static final String EXTRA_ALARM_ID = "alarmId";
    public static final String EXTRA_ALARM_TITLE = "alarmTitle";
    public static final String EXTRA_SNOOZE_MINUTES = "snoozeMinutes";
    /** توکن نشست واقعی زنگ؛ هر فرمان فقط با همین توکن معتبر است. */
    public static final String EXTRA_SESSION_TOKEN = "sessionToken";

    public static final String ACTION_STOP = "ir.roozsaz.app.alarm.STOP";
    public static final String ACTION_SILENCE = "ir.roozsaz.app.alarm.SILENCE";
    public static final String ACTION_SNOOZE = "ir.roozsaz.app.alarm.SNOOZE";

    /**
     * اگر PendingIntent زنگ کهنه باشد (مثلاً زمان رکورد در این فاصله Snooze
     * شده باشد)، ممکن است در زمانِ قدیمی شلیک شود. AlarmManager هیچ‌وقت زودتر
     * از زمان درخواستی شلیک نمی‌کند، پس «زمان رکورد در آیندهٔ دور» یعنی این
     * شلیک مالِ زمان‌بندی کهنه است و نباید رکورد جدید را زودتر زنگ بزند.
     */
    private static final long EARLY_FIRE_TOLERANCE_MS = 10_000L;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;

        String action = intent.getAction();
        int alarmId = intent.getIntExtra(EXTRA_ALARM_ID, -1);
        String sessionToken = intent.getStringExtra(EXTRA_SESSION_TOKEN);

        /*
         * این لاگ «گواهِ اجرا» است: مهم‌ترین خط تشخیصی کل زنجیره. اگر آلارمی
         * نزد و اینجا در logcat دیده نشد، یعنی broadcast هرگز نرسیده (ثبت یا
         * نگهداری مشکل دارد) — نه اینکه رسیده و بی‌صدا بلعیده شده.
         */
        Log.i(TAG, "onReceive [action=" + action + " alarmId=" + alarmId
                + " token=" + shortToken(sessionToken) + "]");
        Log.i(TAG, "PROC receiver " + TaskAlarmProcess.describe(context)
                + " action=" + action + " alarmId=" + alarmId);

        /*
         * گواهِ «broadcast واقعاً به این پروسه رسید». عمداً اکشن FIRE از
         * فرمان‌های کنترلی جدا نگه داشته می‌شود: هنگام جست‌وجو در logcat،
         * FIRE_RECEIVED باید فقط یعنی «زمان زنگ رسید»، نه «یک STOP هم رسید».
         */
        if (TaskAlarmScheduler.ACTION_FIRE.equals(action)) {
            Log.i(TAG, "FIRE_RECEIVED alarmId=" + alarmId + " action=" + action);
        } else {
            Log.i(TAG, "CMD_RECEIVED alarmId=" + alarmId + " action=" + action);
        }

        if (ACTION_SILENCE.equals(action)) {
            TaskAlarmController.silence(context, alarmId, sessionToken);
            return;
        }

        if (ACTION_SNOOZE.equals(action)) {
            if (alarmId < 0) return;
            int minutes = intent.getIntExtra(EXTRA_SNOOZE_MINUTES, TaskAlarmController.DEFAULT_SNOOZE_MINUTES);
            TaskAlarmController.snooze(context, alarmId, minutes, sessionToken);
            return;
        }

        if (alarmId < 0) return;

        if (ACTION_STOP.equals(action)) {
            TaskAlarmController.stop(context, alarmId, sessionToken);
            return;
        }

        if (!TaskAlarmScheduler.ACTION_FIRE.equals(action)) return;

        TaskAlarmStore.Alarm alarm = TaskAlarmStore.get(context, alarmId);
        if (alarm == null) {
            /*
             * گلوگاهِ بی‌صدا: قبلاً بدون هیچ نشانه‌ای return می‌کرد و یک کلِس
             * کامل از خطاها (رکورد حذف‌شده، ذخیره‌ساز خراب، شناسه‌ی ناهماهنگ)
             * عملاً نامرئی می‌شد. حالا این حالت دقیقاً در logcat دیده می‌شود.
             * رفتار عوض نشده: همچنان بدون صدا/اعلان/صفحه خاتمه می‌یابد.
             */
            Log.e(TAG, "NOT_FOUND alarmId=" + alarmId);
            Log.w(TAG, "onReceive: رکورد آلارم پیدا نشد؛ زنگ‌زدن رد شد [alarmId=" + alarmId + "]");
            return;
        }

        Log.i(TAG, "FOUND alarmId=" + alarmId + " title=" + alarm.title + " at=" + alarm.at);

        long earlyBy = alarm.at - System.currentTimeMillis();
        if (earlyBy > EARLY_FIRE_TOLERANCE_MS) {
            /*
             * گلوگاهِ «زنگ زودتر از موعد»: یک شلیک کهنه (مثلاً از زمان‌بندی
             * قبل از Snooze) نباید رکوردِ جدید را زودتر به صدا درآورد.
             * زمان‌بندی درست، خودش دوباره ثبت می‌شود و سر وقت شلیک می‌کند.
             */
            Log.w(TAG, "FIRE_STALE alarmId=" + alarmId
                    + " at=" + alarm.at
                    + " earlyByMs=" + earlyBy);
            return;
        }

        TaskAlarmController.ring(context, alarm);
    }

    private static String shortToken(String token) {
        if (token == null) return "null";
        return token.length() <= 8 ? token : token.substring(0, 8);
    }
}
