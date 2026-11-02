package ir.roozsaz.app.alarm;

import android.app.Notification;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;

/**
 * سرویس پیش‌زمینه‌ی آلارم.
 *
 * <p>نقشش دو چیز است: (۱) پروسه را در حین زنگ‌زدن زنده نگه می‌دارد و (۲) اعلانِ
 * «در حال زنگ» را پایدار (ongoing) می‌کند تا کاربر راهی برای توقف داشته باشد
 * حتی اگر صفحه‌ی تمام‌عرض اجازه‌ی نمایش نگیرد.
 *
 * <p><b>سرویس مالکِ صدا نیست.</b> صدا را {@link TaskAlarmController} در همان
 * پروسه‌ی {@code :alarm} شروع می‌کند؛ این سرویس فقط {@link
 * TaskAlarmController#startRinger} را دوباره صدا می‌زند تا اگر پروسه از یک
 * مسیر دیگر بالا آمده باشد، صدا هم دوباره برقرار شود ({@code startRinger}
 * idempotent است و در صورت پخشِ بودن بی‌اثر می‌ماند).
 *
 * <p><b>استثنای عمدی:</b> اکشن {@link #ACTION_STOP} باید از Controller عبور
 * کند و صدا را واقعاً قطع کند؛ {@code stopService}/{@code STOP_FOREGROUND_REMOVE}
 * به‌تنهایی فقط اعلان/سرویس را برمی‌دارند و player را زنده می‌گذارند. مسیر عادی
 * توقف کاربر همچنان از گیرندهٔ آلارم/صفحهٔ آلارم می‌آید.
 *
 * <p><b>چرا {@code MediaSession}؟</b> روی Android 14+ سیستم‌عامل هنگامِ {@code
 * startForeground} بررسی می‌کند که اگر {@code foregroundServiceType} برابر {@code
 * mediaPlayback} است، اپ واقعاً یک {@link MediaSession} فعال داشته باشد؛ در غیر
 * این صورت {@code InvalidForegroundServiceTypeException} پرت می‌شود و سرویس
 * از کار می‌افتد. چون کاربرد این سرویس دقیقاً «پخش صدای آلارم» است،
 * {@code mediaPlayback} نوعِ درستی است — به شرطِ آن که همراه با یک
 * {@code MediaSession} واقعی ثبت شود.
 */
public class TaskAlarmService extends Service {

    private static final String TAG = "TaskAlarm";

    public static final String ACTION_START = "ir.roozsaz.app.alarm.SERVICE_START";
    public static final String ACTION_STOP = "ir.roozsaz.app.alarm.SERVICE_STOP";

    /**
     * شناسه‌ی اعلانِ پشتیبان برای حالتی که رکورد آلارم در دسترس نیست.
     * عمداً منفی است تا با هیچ شناسه‌ی آلارمِ واقعی هم‌فضا نشود.
     */
    private static final int FALLBACK_NOTIFICATION_ID = -1;

    /** برای اعتبارِ {@code foregroundServiceType=mediaPlayback} روی Android 14+. */
    @Nullable
    private MediaSession mediaSession;

    /** آیا این سرویس واقعاً وارد حالت foreground شده است؟ */
    private boolean foregroundStarted = false;
    private int foregroundNotificationId = -1;

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        int intentAlarmId = intent == null
                ? -1
                : intent.getIntExtra(TaskAlarmReceiver.EXTRA_ALARM_ID, -1);
        String intentToken = intent == null
                ? null
                : intent.getStringExtra(TaskAlarmReceiver.EXTRA_SESSION_TOKEN);

        Log.i(TAG, "PROC service " + TaskAlarmProcess.describe(this)
                + " action=" + action + " startId=" + startId
                + " alarmId=" + intentAlarmId
                + " token=" + shortToken(intentToken));

        if (ACTION_STOP.equals(action)) {
            /*
             * stopService/حذف اعلان به‌تنهایی صدا را قطع نمی‌کند. فرمان توقف
             * باید به Controller برسد تا player و WakeLock همان پروسه آزاد شوند.
             */
            boolean handled;

            if (intentAlarmId >= 0) {
                handled = TaskAlarmController.stop(this, intentAlarmId, intentToken);
            } else {
                handled = TaskAlarmController.silence(this, -1, intentToken);
            }

            /*
             * فرمان دیررس برای شناسهٔ قدیمی نباید سرویس/اعلانِ آلارم جدید را
             * بکشد. فقط وقتی سرویس را می‌بندیم که فرمان واقعاً نشست را پایان
             * داده باشد یا هیچ صدایی در جریان نباشد (سرویسِ یتیم).
             */
            if (handled || !TaskAlarmController.isRinging()) {
                stopEverything(true);
            }
            return START_NOT_STICKY;
        }

        /*
         * MediaSession باید **قبل از** startForeground فعال باشد؛ اعتبارسنجیِ
         * نوع سرویس در همان لحظه‌ی startForeground انجام می‌شود نه بعدتر.
         */
        activateMediaSession();

        /*
         * مسیر عادی: Controller همین حالا رکورد را در حافظه دارد. خواندن
         * دوباره از SQLite در onStartCommand لازم نیست و فقط پنجرهٔ ۵ ثانیه‌ای
         * startForeground را تنگ می‌کند.
         */
        TaskAlarmStore.Alarm alarm = TaskAlarmController.currentAlarm();
        if (alarm != null && alarm.id != intentAlarmId) alarm = null;

        String sessionToken = TaskAlarmController.currentSessionToken();

        /*
         * اگر رکورد در حافظه نیست، **قبل از** هر خواندن کندِ SQLite وارد
         * foreground می‌شویم. وگرنه روی Android 12+ پروسه ممکن است در همان
         * پنجرهٔ ۵ ثانیه‌ای کشته شود، حتی اگر صدا از قبل پخش شده باشد.
         */
        if (alarm == null && intentAlarmId >= 0) {
            if (!goForeground(
                    FALLBACK_NOTIFICATION_ID,
                    TaskAlarmController.buildPlaceholderNotification(this))) {
                stopEverything(false);
                return START_NOT_STICKY;
            }

            alarm = TaskAlarmStore.get(this, intentAlarmId);

            /*
             * توکن معتبر همان توکنی است که Store برای نشست فعال دارد؛ توکن
             * داخل یک intent دیررسِ سرویس می‌تواند مال نشست قبلی باشد.
             */
            TaskAlarmStore.Session session = TaskAlarmStore.session(this);
            if (session != null && alarm != null && session.alarmId == alarm.id) {
                sessionToken = session.token;
            }

            if (sessionToken == null) sessionToken = intentToken;
        } else if (sessionToken == null) {
            sessionToken = intentToken;
        }

        if (alarm == null) {
            /*
             * اگر رکورد در این فاصله حذف شده ولی صدا هنوز در حال پخش است،
             * سرویس را نکش: کشتن سرویس در میانهٔ زنگ، اعلان/صدا را بی‌کنترل
             * رها می‌کند. با اعلانِ نشست فعال، FGS را نگه می‌داریم.
             */
            TaskAlarmStore.Alarm active = TaskAlarmController.currentAlarm();
            if (active != null && TaskAlarmController.isRinging()) {
                Log.w(TAG, "SERVICE_NO_RECORD_RINGING alarmId=" + intentAlarmId
                        + " activeId=" + active.id);
                if (!goForeground(
                        TaskAlarmController.notificationId(active.id),
                        TaskAlarmController.buildNotification(
                                this, active, TaskAlarmController.currentSessionToken()))) {
                    stopEverything(false);
                }
                return START_NOT_STICKY;
            }

            /*
             * اینجا هم startForeground صدا زده می‌شود، وگرنه روی Android 12+
             * سیستم پروسه را با استثنای
             * «Context.startForegroundService() did not then call
             *  Service.startForeground()» می‌کُشد.
             */
            if (!foregroundStarted) {
                goForeground(
                        FALLBACK_NOTIFICATION_ID,
                        TaskAlarmController.buildPlaceholderNotification(this));
            }
            stopEverything(true);
            return START_NOT_STICKY;
        }

        if (!goForeground(
                TaskAlarmController.notificationId(alarm.id),
                TaskAlarmController.buildNotification(this, alarm, sessionToken))) {
            /*
             * اعلانِ پیش‌زمینه ممکن نشد؛ سرویس را نگه نمی‌داریم ولی صدا و
             * اعلانِ Controller ادامه دارند. عمداً REMOVE نمی‌کنیم تا اعلان
             * آلارمِ واقعی (که Controller ثبت کرده) پاک نشود.
             */
            stopEverything(false);
            return START_NOT_STICKY;
        }

        /*
         * اگر مسیر پشتیبان با شناسهٔ منفی بالا آمده بود، اعلان نگه‌دارنده را
         * بعد از جایگزینی (نه قبل از آن) جمع می‌کنیم.
         */
        NotificationManagerCompat.from(this).cancel(FALLBACK_NOTIFICATION_ID);

        TaskAlarmController.startRinger(this);

        return START_NOT_STICKY;
    }

    /**
     * ارتقای سرویس به پیش‌زمینه.
     *
     * @return true اگر موفق بود. شکستِ اینجا «خطای آلارم» نیست: صدا از قبل در
     *         پروسهٔ گیرنده در حال پخش است و این سرویس فقط نگه‌دارنده است.
     */
    private boolean goForeground(int notificationId, Notification notification) {
        int type = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
        }

        try {
            ServiceCompat.startForeground(this, notificationId, notification, type);
            foregroundStarted = true;
            foregroundNotificationId = notificationId;
            Log.i(TAG, "سرویس پیش‌زمینه برای آلارم فعال شد [notificationId=" + notificationId + "]");
            return true;
        } catch (Exception e) {
            /*
             * روی Android 14+ شایع‌ترین علت، نبودِ MediaSession فعال برای نوع
             * mediaPlayback است؛ روی Android 12+ هم شروع سرویسِ پیش‌زمینه از
             * پس‌زمینه محدود است (آلارمِ دقیق و اقدام کاربر روی اعلان از
             * استثناها هستند). در هر دو حالت صدا ادامه می‌یابد.
             */
            foregroundStarted = false;
            foregroundNotificationId = -1;
            Log.w(TAG, "startForeground برای آلارم ممکن نشد", e);
            return false;
        }
    }

    /**
     * فعال‌سازیِ {@code MediaSession}.
     *
     * <p>این سشن واقعاً هم «در حال پخش» را به سیستم‌عامل اعلام می‌کند (که دقیقاً
     * همان کاری است که این سرویس می‌کند) و هم {@code mediaPlayback} را روی
     * Android 14+ معتبر می‌سازد. سکوتِ احتمالیِ ساخت آن هرگز نباید مانعِ
     * {@code startForeground} شود؛ مسئولیتِ شکستِ نهایی با {@link #goForeground}.
     */
    private void activateMediaSession() {
        if (mediaSession != null) return;

        try {
            mediaSession = new MediaSession(this, "roozsaz_task_alarm");
            mediaSession.setPlaybackState(
                    new PlaybackState.Builder()
                            .setActions(PlaybackState.ACTION_PLAY_PAUSE)
                            .setState(PlaybackState.STATE_PLAYING, SystemClock.elapsedRealtime(), 1f)
                            .build());
            mediaSession.setActive(true);
        } catch (Exception e) {
            Log.w(TAG, "ساخت MediaSession ممکن نشد؛ نوع mediaPlayback ممکن است روی Android 14+ رد شود", e);
            mediaSession = null;
        }
    }

    private void releaseMediaSession() {
        MediaSession session = mediaSession;
        mediaSession = null;
        if (session == null) return;

        try {
            session.setActive(false);
            session.release();
        } catch (Exception ignored) {
            /* ignore */
        }
    }

    /**
     * خاتمهٔ سرویس با آزادسازیِ سشن.
     *
     * @param removeNotification اگر true باشد، اعلانِ foreground برداشته می‌شود.
     *        در مسیر شکستِ {@code startForeground} این مقدار false است تا
     *        اعلانِ آلارمِ واقعی که Controller جداگانه ثبت کرده، حذف نشود.
     *        در مسیر توقفِ واقعی، Controller از قبل همان اعلان را cancel کرده
     *        است؛ REMOVE در آن حالت فقط اعلانِ fallback را جمع می‌کند.
     */
    private void stopEverything(boolean removeNotification) {
        if (foregroundStarted) {
            try {
                ServiceCompat.stopForeground(this, removeNotification
                        ? ServiceCompat.STOP_FOREGROUND_REMOVE
                        : ServiceCompat.STOP_FOREGROUND_DETACH);
            } catch (Exception ignored) {
                /* ignore */
            }
        }

        foregroundStarted = false;
        foregroundNotificationId = -1;
        releaseMediaSession();
        stopSelf();
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "PROC service destroyed " + TaskAlarmProcess.describe(this)
                + " ringing=" + TaskAlarmController.isRinging()
                + " foregroundNotificationId=" + foregroundNotificationId);
        releaseMediaSession();
        super.onDestroy();

        /*
         * توجه: عمداً صدا را اینجا قطع **نمی‌کنیم**. مالکِ صدا TaskAlarmController
         * است و توقف آن فقط با اقدام صریح کاربر (توقف/تعویق) یا مهلتِ خودکارِ
         * همان کلاس انجام می‌شود؛ وگرنه ممکن بود سرویس به هر دلیلی بازراه‌اندازی
         * شود و آلارم بی‌صدا بماند.
         */
    }

    private static String shortToken(String token) {
        if (token == null) return "null";
        return token.length() <= 8 ? token : token.substring(0, 8);
    }
}
