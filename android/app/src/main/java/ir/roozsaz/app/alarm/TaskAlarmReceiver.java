package ir.roozsaz.app.alarm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * گیرنده‌ی آلارم تسک.
 *
 * <p>این گیرنده نقطه‌ی شروعِ کاملاً نیتیو است: نه WebView لازم دارد، نه اینترنت،
 * نه نشستِ ورود. فقط AlarmManager آن را صدا می‌زند و بعدش
 * {@link TaskAlarmController} اعلان/صدا/صفحه‌ی آلارم را می‌سازد.
 *
 * <p>دو اکشن پشتیبانی می‌شود:
 * <ul>
 *   <li>{@link TaskAlarmScheduler#ACTION_FIRE} — لحظه‌ی رسیدن زمان؛</li>
 *   <li>{@link #ACTION_STOP} — دکمه‌ی «توقف» روی خودِ اعلان (مسیر پشتیبانِ
 *       توقف، حتی اگر صفحه‌ی تمام‌عرض اجازه‌ی نمایش نگیرد).</li>
 * </ul>
 */
public class TaskAlarmReceiver extends BroadcastReceiver {

    public static final String EXTRA_ALARM_ID = "alarmId";
    public static final String EXTRA_ALARM_TITLE = "alarmTitle";

    public static final String ACTION_STOP = "ir.roozsaz.app.alarm.STOP";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;

        int alarmId = intent.getIntExtra(EXTRA_ALARM_ID, -1);
        if (alarmId < 0) return;

        if (ACTION_STOP.equals(intent.getAction())) {
            TaskAlarmController.stop(context, alarmId);
            return;
        }

        if (!TaskAlarmScheduler.ACTION_FIRE.equals(intent.getAction())) return;

        TaskAlarmStore.Alarm alarm = TaskAlarmStore.get(context, alarmId);
        if (alarm == null) {
            /* بین زمان‌بندی و رسیدن لغو شده بود (کار حذف/تمام شد یا تعویق خورد). */
            return;
        }

        TaskAlarmController.ring(context, alarm);
    }
}
