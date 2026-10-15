package ir.roozsaz.app.alarm;

import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.ServiceCompat;

/**
 * سرویس پیش‌زمینه‌ی آلارم.
 *
 * <p>نقشش دو چیز است: (۱) پروسه را در حین زنگ‌زدن زنده نگه می‌دارد و (۲) اعلانِ
 * «در حال زنگ» را پایدار (ongoing) می‌کند تا کاربر راهی برای توقف داشته باشد
 * حتی اگر صفحه‌ی تمام‌عرض اجازه‌ی نمایش نگیرد.
 *
 * <p>اگر شروع سرویس از پس‌زمینه رد شود (روی Android 12+ محدود است؛ آلارم دقیق
 * و اقدام کاربر روی اعلان از استثناها هستند)، صدا در همان پروسه ادامه می‌یابد و
 * چیزی از دست نمی‌رود — به همین دلیل شکست اینجا «خطای آلارم» نیست.
 */
public class TaskAlarmService extends Service {

    private static final String TAG = "TaskAlarm";

    public static final String ACTION_START = "ir.roozsaz.app.alarm.SERVICE_START";
    public static final String ACTION_STOP = "ir.roozsaz.app.alarm.SERVICE_STOP";

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();

        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }

        int alarmId = intent == null ? -1 : intent.getIntExtra(TaskAlarmReceiver.EXTRA_ALARM_ID, -1);
        TaskAlarmStore.Alarm alarm = alarmId < 0 ? null : TaskAlarmStore.get(this, alarmId);

        if (alarm == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        if (!goForeground(alarm)) {
            /* اعلانِ پیش‌زمینه ممکن نشد؛ سرویس را نگه نمی‌داریم ولی صدا ادامه دارد. */
            stopSelf();
            return START_NOT_STICKY;
        }

        TaskAlarmController.startRinger(this);

        return START_NOT_STICKY;
    }

    private boolean goForeground(TaskAlarmStore.Alarm alarm) {
        int type = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
        }

        try {
            ServiceCompat.startForeground(
                    this,
                    TaskAlarmController.notificationId(alarm.id),
                    TaskAlarmController.buildNotification(this, alarm),
                    type);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "startForeground برای آلارم ممکن نشد", e);
            return false;
        }
    }

    /*
     * توجه: عمداً در onDestroy صدا را قطع نمی‌کنیم. توقف صدا فقط با اقدام صریح
     * کاربر (توقف/تعویق) یا مهلت خودکارِ TaskAlarmController انجام می‌شود؛
     * وگرنه ممکن بود سرویس به هر دلیلی بازراه‌اندازی شود و آلارم بی‌صدا بماند.
     */
}
