package ir.roozsaz.app.alarm;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * هماهنگ‌کننده‌ی «زنگ‌زدن» آلارم تسک: اعلان، جلوگیری از خواب، و صدای آلارم.
 *
 * <p>چرا یک کلاس جدا؟ چون زنگ‌زدن باید از سه مسیر ممکن شروع/پایان بگیرد و هر
 * سه باید یک صدا و یک اعلان داشته باشند:
 * <ul>
 *   <li>گیرنده‌ی آلارم ({@link TaskAlarmReceiver}) — لحظه‌ی رسیدن زمان؛</li>
 *   <li>سرویس پیش‌زمینه ({@link TaskAlarmService}) — نگه‌داشتن پروسه و صدا؛</li>
 *   <li>صفحه‌ی آلارم ({@link TaskAlarmActivity}) — دکمه‌های توقف/تعویق.</li>
 * </ul>
 *
 * <p>مالکِ صدا این کلاس است (یک {@link MediaPlayer} استاتیک با حلقه‌ی بی‌پایان)
 * و اعلان هم همین‌جا ساخته می‌شود؛ بنابراین هر مسیری که صدا را شروع کند، همان
 * اعلان را هم دارد و توقف از هر جایی کار می‌کند.
 *
 * <p>کانال اعلان عمداً «بی‌صدا» است: صدا توسط سرویس و در حلقه پخش می‌شود، و
 * اگر کانال هم صدا داشت، دو صدا هم‌زمان شنیده می‌شد.
 */
public final class TaskAlarmController {

    private static final String TAG = "TaskAlarm";

    public static final String CHANNEL_ID = "roozsaz_task_alarms";

    /** تعویق پیش‌فرض (دقیقه) — قابل تغییر از سمت JS. */
    public static final int DEFAULT_SNOOZE_MINUTES = 5;

    /** سقف زنگ‌زدن؛ بعد از این، آلارم خودش خاموش می‌شود (ضدِ زنگ ابدی). */
    public static final long MAX_RING_MS = 5 * 60 * 1000L;

    private static MediaPlayer player;
    private static PowerManager.WakeLock wakeLock;

    private static final Handler handler = new Handler(Looper.getMainLooper());
    private static final Runnable autoStop = new Runnable() {
        @Override
        public void run() {
            /* بدون context هم می‌شود صدا و اعلان را جمع کرد. */
            stopRinger();
            releaseWakeLock();
        }
    };

    private TaskAlarmController() {
    }

    /**
     * شناسه‌ی اعلان.
     *
     * <p>عمداً همان شناسه‌ی آلارم است: شناسه‌ی آلارم از هشِ {@code task-alarm:<taskId>}
     * می‌آید و با شناسه‌های یادآور ({@code task-reminder:<taskId>}) هم‌فضا نیست،
     * پس یکتایی به همان اندازه‌ی هش قابل‌اعتماد است و نیازی به تبخیر کردن بازه
     * (که تصادم را محتمل‌تر می‌کند) نیست.
     */
    public static int notificationId(int alarmId) {
        return alarmId;
    }

    /* ------------------------------------------------------------------ */
    /* کانال و اعلان                                                       */
    /* ------------------------------------------------------------------ */

    public static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager manager =
                (NotificationManager) context.getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        NotificationChannel channel =
                new NotificationChannel(CHANNEL_ID, "آلارم کارها", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("آلارم دقیق برای کارهای زمان‌دار");
        /* صدا در سرویس و به‌صورت حلقه پخش می‌شود، پس کانال بی‌صدا می‌ماند. */
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

        manager.createNotificationChannel(channel);
    }

    /** اعلانِ «آلارم در حال زنگ» + قصدِ تمام‌صفحه برای نمایش صفحه‌ی آلارم. */
    public static Notification buildNotification(Context context, TaskAlarmStore.Alarm alarm) {
        ensureChannel(context);

        Intent open = new Intent(context.getApplicationContext(), TaskAlarmActivity.class);
        open.putExtra(TaskAlarmReceiver.EXTRA_ALARM_ID, alarm.id);
        open.putExtra(TaskAlarmReceiver.EXTRA_ALARM_TITLE, alarm.title);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;

        PendingIntent contentIntent =
                PendingIntent.getActivity(context.getApplicationContext(), alarm.id, open, flags);
        PendingIntent stopIntent = buildStopIntent(context, alarm.id);

        /*
         * متن‌ها اینجا (و نه در strings.xml) هستند چون آلارم باید حتی وقتی
         * صفحه‌ی وب بارگذاری نشده هم خوانا باشد و به منبع ترجمه‌ی اپ وابسته
         * نباشد.
         */
        return new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle(alarm.title.isEmpty() ? "آلارم کار" : alarm.title)
                .setContentText("زمان این کار رسیده است")
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(false)
                .setContentIntent(contentIntent)
                /*
                 * مسیرِ رسمیِ اندروید برای باز کردن صفحه از پس‌زمینه.
                 * روی Android 14+ اگر USE_FULL_SCREEN_INTENT داده نشده باشد،
                 * به‌جای صفحه‌ی تمام‌عرض یک اعلان برجسته (heads-up) نشان داده
                 * می‌شود؛ صدا در هر حالت پخش می‌شود.
                 */
                .setFullScreenIntent(contentIntent, true)
                /* مسیر پشتیبانِ توقف: حتی اگر صفحه‌ی تمام‌عرض اجازه نگیرد. */
                .addAction(0, "توقف", stopIntent)
                .build();
    }

    private static PendingIntent buildStopIntent(Context context, int alarmId) {
        Intent stop = new Intent(context.getApplicationContext(), TaskAlarmReceiver.class);
        stop.setAction(TaskAlarmReceiver.ACTION_STOP);
        stop.putExtra(TaskAlarmReceiver.EXTRA_ALARM_ID, alarmId);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;

        return PendingIntent.getBroadcast(context.getApplicationContext(), alarmId, stop, flags);
    }

    private static void postNotification(Context context, TaskAlarmStore.Alarm alarm) {
        try {
            NotificationManagerCompat.from(context.getApplicationContext())
                    .notify(notificationId(alarm.id), buildNotification(context, alarm));
        } catch (SecurityException e) {
            Log.w(TAG, "ثبت اعلان آلارم رد شد", e);
        }
    }

    private static void cancelNotification(Context context, int alarmId) {
        try {
            NotificationManagerCompat.from(context.getApplicationContext()).cancel(notificationId(alarmId));
        } catch (Exception ignored) {
            /* لغو اعلان هرگز نباید مسیر توقف را بشکند. */
        }
    }

    /* ------------------------------------------------------------------ */
    /* صدای آلارم                                                          */
    /* ------------------------------------------------------------------ */

    private static Uri alarmSoundUri(Context context) {
        Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        return uri;
    }

    /**
     * شروع پخش حلقه‌ای صدای آلارم.
     *
     * <p>اگر دستگاه صدای آلارم پیش‌فرض نداشته باشد یا پخش ممکن نباشد، بی‌صدا
     * رد می‌شود — ولی اعلان و صفحه‌ی آلارم سرِ جای خود می‌مانند.
     */
    public static synchronized void startRinger(Context context) {
        if (player != null) return;

        try {
            Uri uri = alarmSoundUri(context);
            if (uri == null) {
                Log.w(TAG, "صدای آلارم روی دستگاه تعریف نشده است");
                return;
            }

            final MediaPlayer mp = new MediaPlayer();
            mp.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            mp.setDataSource(context.getApplicationContext(), uri);
            mp.setLooping(true);
            mp.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
                @Override
                public void onPrepared(MediaPlayer prepared) {
                    try {
                        prepared.start();
                    } catch (Exception e) {
                        Log.w(TAG, "شروع پخش صدا شکست خورد", e);
                    }
                }
            });
            mp.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                @Override
                public boolean onError(MediaPlayer errored, int what, int extra) {
                    Log.w(TAG, "خطای پخش صدا: " + what + "/" + extra);
                    stopRinger();
                    return true;
                }
            });

            /* prepare غیرمسدودکننده: رشته‌ی اصلی (گیرنده) نباید بلاک شود. */
            mp.prepareAsync();
            player = mp;
        } catch (Exception e) {
            Log.w(TAG, "ساخت پخش‌کننده‌ی صدا شکست خورد", e);
            player = null;
        }
    }

    public static synchronized void stopRinger() {
        MediaPlayer mp = player;
        player = null;

        if (mp == null) return;

        try {
            if (mp.isPlaying()) mp.stop();
        } catch (Exception ignored) {
            /* شاید هرگز شروع نشده بود. */
        }

        try {
            mp.release();
        } catch (Exception ignored) {
            /* ignore */
        }
    }

    /* ------------------------------------------------------------------ */
    /* قفل بیداری                                                          */
    /* ------------------------------------------------------------------ */

    private static void acquireWakeLock(Context context) {
        releaseWakeLock();

        try {
            PowerManager power = (PowerManager) context.getApplicationContext()
                    .getSystemService(Context.POWER_SERVICE);
            if (power == null) return;

            PowerManager.WakeLock lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dp:task-alarm");
            lock.setReferenceCounted(false);
            /* مهلت اجباری — حتی اگر توقف هرگز صدا زده نشود، سیستم آزاد می‌شود. */
            lock.acquire(MAX_RING_MS + 60_000L);
            wakeLock = lock;
        } catch (Exception e) {
            Log.w(TAG, "گرفتن قفل بیداری شکست خورد", e);
        }
    }

    private static void releaseWakeLock() {
        PowerManager.WakeLock lock = wakeLock;
        wakeLock = null;
        if (lock == null) return;

        try {
            if (lock.isHeld()) lock.release();
        } catch (Exception ignored) {
            /* ignore */
        }
    }

    /* ------------------------------------------------------------------ */
    /* چرخه‌ی زنگ                                                           */
    /* ------------------------------------------------------------------ */

    /** لحظه‌ی رسیدن زمان آلارم: اعلان + قفل بیداری + صدا + سرویس نگه‌دارنده. */
    public static void ring(Context context, TaskAlarmStore.Alarm alarm) {
        Context app = context.getApplicationContext();

        postNotification(app, alarm);
        acquireWakeLock(app);
        startRinger(app);

        /* سرویس پیش‌زمینه پروسه را زنده و اعلان را پایدار نگه می‌دارد. */
        if (!startService(app, alarm)) {
            Log.w(TAG, "سرویس پیش‌زمینه شروع نشد؛ پخش در همین پروسه ادامه می‌یابد");
        }

        handler.removeCallbacks(autoStop);
        handler.postDelayed(autoStop, MAX_RING_MS);
    }

    private static boolean startService(Context context, TaskAlarmStore.Alarm alarm) {
        Intent intent = new Intent(context, TaskAlarmService.class);
        intent.setAction(TaskAlarmService.ACTION_START);
        intent.putExtra(TaskAlarmReceiver.EXTRA_ALARM_ID, alarm.id);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
            return true;
        } catch (Exception e) {
            /*
             * روی Android 12+ شروع سرویس پیش‌زمینه از پس‌زمینه محدود است
             * (آلارمِ دقیق و اقدام کاربر روی اعلان از استثناها هستند). اگر
             * رد شد، صدا در همین پروسه ادامه می‌یابد.
             */
            Log.w(TAG, "startForegroundService رد شد", e);
            return false;
        }
    }

    private static void stopService(Context context) {
        try {
            context.getApplicationContext().stopService(new Intent(context.getApplicationContext(), TaskAlarmService.class));
        } catch (Exception ignored) {
            /* ignore */
        }
    }

    /** توقف کامل: صدا، اعلان، سرویس، قفل، و حذف آلارم از ذخیره. */
    public static void stop(Context context, int alarmId) {
        Context app = context.getApplicationContext();

        handler.removeCallbacks(autoStop);
        stopRinger();
        releaseWakeLock();
        cancelNotification(app, alarmId);
        stopService(app);
        TaskAlarmStore.delete(app, alarmId);
    }

    /**
     * تعویق: آلارم جدید در `minutes` دقیقه‌ی بعد ثبت می‌شود و زنگ فعلی خاموش.
     *
     * @return لحظه‌ی جدید (epoch ms)
     */
    public static long snooze(Context context, int alarmId, int minutes) {
        Context app = context.getApplicationContext();
        TaskAlarmStore.Alarm alarm = TaskAlarmStore.get(app, alarmId);

        long at = System.currentTimeMillis() + Math.max(1, minutes) * 60_000L;

        if (alarm != null) {
            TaskAlarmStore.Alarm next = new TaskAlarmStore.Alarm(alarm.id, alarm.taskId, alarm.title, at, alarm.createdAt);
            TaskAlarmStore.put(app, next);
            TaskAlarmScheduler.schedule(app, next);
        }

        /* صدا و اعلان خاموش می‌شوند، ولی رکورد آلارم می‌ماند (برای آلارم بعدی). */
        handler.removeCallbacks(autoStop);
        stopRinger();
        releaseWakeLock();
        cancelNotification(app, alarmId);
        stopService(app);

        return at;
    }
}
