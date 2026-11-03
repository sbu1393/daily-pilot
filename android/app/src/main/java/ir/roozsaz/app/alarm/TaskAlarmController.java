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
import android.os.SystemClock;
import android.service.notification.StatusBarNotification;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import java.util.UUID;

/**
 * هماهنگ‌کننده‌ی «زنگ‌زدن» آلارم تسک: اعلان، جلوگیری از خواب، و صدای آلارم.
 *
 * <p><b>مالکیت در معماری چندپروسه‌ای:</b> گیرنده، سرویس و صفحه‌ی آلارم در
 * پروسهٔ {@code ir.roozsaz.app:alarm} اجرا می‌شوند. فقط همان پروسه
 * {@link MediaPlayer} و {@link PowerManager.WakeLock} دارد. پروسهٔ اصلی
 * (پلاگین/بازیابی) با فرمان صریح broadcast به گیرندهٔ همان پروسه، توقف یا
 * خاموش‌کردن صدا را درخواست می‌کند؛ فراخوانی static از main هرگز به player
 * پروسهٔ آلارم دست نمی‌زند.
 *
 * <p>یک نشست فعال در هر زمان: آلارم تکراری با همان شناسه و همان زمان
 * idempotent است؛ آلارم جدید، نشست قبلی را متوقف و رکورد قبلی را حذف می‌کند.
 */
public final class TaskAlarmController {

    private static final String TAG = "TaskAlarm";

    public static final String CHANNEL_ID = "roozsaz_task_alarms";

    /**
     * پیشوند data URI دکمهٔ «توقف». توکن نشست در data می‌نشیند تا بخشی از
     * {@code Intent.filterEquals} و در نتیجه بخشی از هویت PendingIntent شود.
     */
    private static final String STOP_URI_PREFIX = "roozsaz-alarm://stop/";

    /** تعویق پیش‌فرض (دقیقه) — قابل تغییر از سمت JS. */
    public static final int DEFAULT_SNOOZE_MINUTES = 5;

    /** سقف زنگ‌زدن؛ بعد از این، آلارم خودش خاموش می‌شود (ضدِ زنگ ابدی). */
    public static final long MAX_RING_MS = 5 * 60 * 1000L;

    /** مهلت اضافه برای پاک‌سازی اعلان/نشستِ یتیم بعد از سقف زنگ. */
    private static final long ORPHAN_GRACE_MS = 60_000L;

    private static MediaPlayer player;
    private static PowerManager.WakeLock wakeLock;

    private static final Handler handler = new Handler(Looper.getMainLooper());

    /** وضعیت نشست فقط در پروسه‌ای معنا دارد که player را در اختیار دارد. */
    private static int activeAlarmId = -1;
    private static String activeSessionToken;
    private static long activeSince = 0L;
    private static long activeSinceElapsed = 0L;
    private static long activeAlarmAt = 0L;
    private static TaskAlarmStore.Alarm activeAlarm;
    private static Context appContext;

    private static final Runnable autoStop = new Runnable() {
        @Override
        public void run() {
            Context app = appContext;
            int id = activeAlarmId;
            String token = activeSessionToken;

            Log.i(TAG, "AUTO_STOP alarmId=" + id + " " + (app == null ? "context=null" : TaskAlarmProcess.describe(app)));

            if (app != null) {
                silenceInternal(app, id, token, true);
            } else {
                stopRinger();
                releaseWakeLock();
            }
        }
    };

    private TaskAlarmController() {
    }

    /**
     * شناسه‌ی اعلان.
     *
     * <p>عمداً همان شناسه‌ی آلارم است: شناسه‌ی آلارم از هشِ {@code task-alarm:<taskId>}
     * می‌آید و با شناسه‌ی اعلان یادآور روزانه ({@code daily-reminder:<scope>})
     * هم‌فضا نیست، پس یکتایی به همان اندازه‌ی هش قابل‌اعتماد است و نیازی به
     * تغییر دادن بازه (که تصادم را محتمل‌تر می‌کند) نیست.
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
    public static Notification buildNotification(
            Context context,
            TaskAlarmStore.Alarm alarm,
            String sessionToken) {
        ensureChannel(context);

        Intent open = new Intent(context.getApplicationContext(), TaskAlarmActivity.class);
        open.putExtra(TaskAlarmReceiver.EXTRA_ALARM_ID, alarm.id);
        open.putExtra(TaskAlarmReceiver.EXTRA_ALARM_TITLE, alarm.title);
        putToken(open, sessionToken);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;

        PendingIntent contentIntent =
                PendingIntent.getActivity(context.getApplicationContext(), alarm.id, open, flags);
        PendingIntent stopIntent = buildStopIntent(context, alarm.id, sessionToken);

        /* متن‌ها اینجا (و نه در strings.xml) هستند چون آلارم باید حتی وقتی
         * صفحه‌ی وب بارگذاری نشده هم خوانا باشد و به منبع ترجمه‌ی اپ وابسته
         * نباشد. */
        return new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle(alarm.title.isEmpty() ? "آلارم کار" : alarm.title)
                .setContentText("زمان این کار رسیده است")
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(false)
                /*
                 * اگر پروسه بعد از زنگ بمیرد و autoStop اجرا نشود، این مهلت
                 * جلوی اعلان یتیمِ همیشگی را می‌گیرد. صدا با مرگ پروسه قطع
                 * می‌شود؛ این خط فقط اعلان را جمع می‌کند.
                 */
                .setTimeoutAfter(MAX_RING_MS + ORPHAN_GRACE_MS)
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

    private static PendingIntent buildStopIntent(Context context, int alarmId, String sessionToken) {
        Intent stop = new Intent(context.getApplicationContext(), TaskAlarmReceiver.class);
        stop.setAction(TaskAlarmReceiver.ACTION_STOP);
        stop.putExtra(TaskAlarmReceiver.EXTRA_ALARM_ID, alarmId);
        putToken(stop, sessionToken);

        /*
         * هویت PendingIntent از requestCode + Intent.filterEquals ساخته
         * می‌شود و extras در آن نقشی ندارند. توکن را در data می‌گذاریم تا
         * بخشی از هویت باشد؛ در نتیجه PendingIntent نشست قدیمی با
         * FLAG_UPDATE_CURRENT بازنویسی نمی‌شود و هرگز extras/توکن نشست
         * جدید را به ارث نمی‌برد. requestCode دیگر hashCode نیست (برخورد
         * ۳۲بیتی می‌توانست دو نشست را روی هم بیندازد) و فقط شناسهٔ آلارم
         * است. گیرنده data را نمی‌خواند و توکن را از extras می‌گیرد، پس
         * مسیر STOP بدون تغییر می‌ماند.
         */
        if (sessionToken != null && !sessionToken.isEmpty()) {
            stop.setData(Uri.parse(STOP_URI_PREFIX + Uri.encode(sessionToken)));
        }

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;

        return PendingIntent.getBroadcast(context.getApplicationContext(), alarmId, stop, flags);
    }

    private static void postNotification(
            Context context,
            TaskAlarmStore.Alarm alarm,
            String sessionToken) {
        try {
            NotificationManagerCompat.from(context.getApplicationContext())
                    .notify(notificationId(alarm.id), buildNotification(context, alarm, sessionToken));
        } catch (SecurityException e) {
            Log.w(TAG, "ثبت اعلان آلارم رد شد", e);
        }
    }

    /** لغو اعلان از هر پروسه‌ای (NotificationManager مشترک سیستم است). */
    public static void cancelNotification(Context context, int alarmId) {
        try {
            NotificationManagerCompat.from(context.getApplicationContext()).cancel(notificationId(alarmId));
        } catch (Exception ignored) {
            /* لغو اعلان هرگز نباید مسیر توقف را بشکند. */
        }
    }

    /**
     * آیا اعلان این آلارم همین حالا در نوار وضعیت هست؟ این یک نشانهٔ
     * بین‌پروسه‌ای است: اگر نوشتن نشانگر فعال در Store به هر دلیل شکست بخورد،
     * پروسهٔ اصلی باز هم می‌تواند بفهمد که احتمالاً زنگی در جریان است و فرمان
     * خاموش‌کردن را بفرستد.
     */
    private static boolean hasActiveNotification(Context context, int alarmId) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false;

        try {
            NotificationManager manager = (NotificationManager) context.getApplicationContext()
                    .getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return false;

            StatusBarNotification[] active = manager.getActiveNotifications();
            if (active == null) return false;

            for (StatusBarNotification notification : active) {
                if (notification.getId() == notificationId(alarmId)) return true;
            }
        } catch (Exception e) {
            Log.w(TAG, "خواندن اعلان‌های فعال شکست خورد", e);
        }

        return false;
    }

    /**
     * آیا نمایشِ صفحه‌ی تمام‌عرض روی این دستگاه/این نسخه ممکن است؟
     *
     * <p>فقط برای **گزارش** است؛ هیچ مسیرِ پخش صدا به آن وابسته نیست. روی
     * Android 14+ نمایش تمام‌صفحه نیازمند مجوز {@code USE_FULL_SCREEN_INTENT}
     * است که برای اپ‌های غیر-آلارمی پیش‌فرض داده نمی‌شود؛ در آن حالت اندروید
     * به‌جای Activity یک اعلان برجسته نشان می‌دهد و صدا همچنان پخش می‌شود.
     */
    public static boolean canUseFullScreenIntent(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true;

        NotificationManager manager =
                (NotificationManager) context.getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);

        try {
            return manager == null || manager.canUseFullScreenIntent();
        } catch (Exception e) {
            Log.w(TAG, "پرسیدن وضعیت USE_FULL_SCREEN_INTENT شکست خورد", e);
            return false;
        }
    }

    /**
     * اعلانِ حداقلی برای مسیری که رکورد آلارم در دسترس نیست ولی سرویس پیش‌زمینه
     * پیش‌تر با {@code startForegroundService} آغاز شده است.
     *
     * <p>این اعلان فقط برای آن است که روی Android 12+ پروسه به‌خاطر «آغاز
     * سرویسِ پیش‌زمینه بدون {@code startForeground}» کشته نشود. به هیچ رکوردی
     * وابسته نیست و با شناسه‌ی منفی ثبت می‌شود تا هرگز با اعلانِ آلارمِ واقعی
     * تصادم نکند.
     */
    public static Notification buildPlaceholderNotification(Context context) {
        ensureChannel(context);

        return new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle("آلارم کار")
                .setContentText("در حال آماده‌سازی…")
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setOngoing(true)
                .setAutoCancel(false)
                .build();
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
                        /*
                         * گواهِ پخش: اگر این خط در logcat آمد ولی صدایی نمی‌آید،
                         * مشکل دیگر نرم‌افزاری نیست (بلندی/مسیر صدا/DND دستگاه).
                         */
                        Log.i(TAG, "صدای آلارم در حال پخش است [uri=" + uri + "]");
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
            lock.acquire(MAX_RING_MS + ORPHAN_GRACE_MS);
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
    public static synchronized void ring(Context context, TaskAlarmStore.Alarm alarm) {
        Context app = context.getApplicationContext();
        long now = System.currentTimeMillis();
        long elapsedNow = SystemClock.elapsedRealtime();

        Log.i(TAG, "PROC ring " + TaskAlarmProcess.describe(app) + " alarmId=" + alarm.id);

        /*
         * آلارم تکراری با همان شناسه و همان زمان: صدا را از نو شروع نکن و
         * توکن نشست را هم عوض نکن (وگرنه دکمهٔ توقفِ اعلان فعلی بی‌اعتبار
         * می‌شد). فقط اعلان/قفل/سرویس را ترمیم می‌کنیم.
         */
        if (activeAlarmId == alarm.id
                && activeAlarmAt == alarm.at
                && activeSessionToken != null
                && player != null) {
            Log.i(TAG, "RING_DUPLICATE alarmId=" + alarm.id + " token=" + shortToken(activeSessionToken));
            postNotification(app, alarm, activeSessionToken);
            if (wakeLock == null || !wakeLock.isHeld()) acquireWakeLock(app);
            startService(app, alarm, activeSessionToken);
            return;
        }

        /*
         * نشست قبلی (در همین پروسه): صدایش را فوراً قطع می‌کنیم، ولی رکورد/
         * نشانگرش را بعد از شروع صدای جدید و به‌صورت اتمیک پاک می‌کنیم تا
         * مسیر بحرانی زنگ به پایگاه‌داده گره نخورد.
         */
        if (activeAlarmId >= 0 || player != null) {
            Log.i(TAG, "RING_REPLACE old=" + activeAlarmId + " new=" + alarm.id);
            handler.removeCallbacks(autoStop);
            stopRinger();
            releaseWakeLock();
        }

        String token = UUID.randomUUID().toString();

        activeAlarmId = alarm.id;
        activeSessionToken = token;
        activeSince = now;
        activeSinceElapsed = elapsedNow;
        activeAlarmAt = alarm.at;
        activeAlarm = alarm;
        appContext = app;

        /* گواهِ «Receiver رسید به Controller و واقعاً زنگ را شروع کرد». */
        Log.i(TAG, "RING_START alarmId=" + alarm.id
                + " taskId=" + alarm.taskId
                + " at=" + alarm.at
                + " token=" + shortToken(token)
                + " fsi=" + canUseFullScreenIntent(app)
                + " exact=" + TaskAlarmScheduler.canScheduleExact(app)
                + " sdk=" + Build.VERSION.SDK_INT
                + " " + TaskAlarmProcess.describe(app));

        /*
         * اول صدا و اعلان (مسیر بحرانی کاربر)، بعد پایگاه‌داده. توکن از همین
         * لحظه در اعلان/دکمه‌ها هست و در حافظهٔ همین پروسه معتبر است؛ نوشتن
         * آن در Store بلافاصله بعد انجام می‌شود تا منبع حقیقت بین‌پروسه‌ای هم
         * به‌روز شود.
         */
        startRinger(app);
        acquireWakeLock(app);
        postNotification(app, alarm, token);

        boolean serviceStarted = startService(app, alarm, token);
        if (!serviceStarted) {
            Log.w(TAG, "سرویس پیش‌زمینه شروع نشد؛ پخش در همین پروسه ادامه می‌یابد");
        }

        TaskAlarmStore.StartResult started =
                TaskAlarmStore.startSession(app, alarm, token, now, elapsedNow);

        if (!started.ok) {
            if (started.aborted) {
                /*
                 * رکوردِ همین آلارم (id + at) در تراکنش پیدا نشد؛ یعنی
                 * cancel/Snooze در همین فاصله آن را حذف یا جابه‌جا کرده است.
                 * نشست جدیدی ثبت نشده، پس هیچ صدایی نباید باقی بماند.
                 */
                Log.w(TAG, "RING_ABORTED alarmId=" + alarm.id
                        + " at=" + alarm.at
                        + " token=" + shortToken(token)
                        + " (رکورد در همین فاصله حذف/جابه‌جا شد)");
            } else {
                Log.e(TAG, "RING_SESSION_PERSIST_FAILED alarmId=" + alarm.id
                        + " token=" + shortToken(token));
            }
            rollbackRingAttempt(app, alarm.id, token, serviceStarted);
            return;
        }

        if (started.previous != null) {
            if (started.previousRecordDeleted) {
                /*
                 * رکورد نشست قبلی در همان تراکنش حذف شد. زمان‌بندی‌اش را هم
                 * برمی‌داریم، ولی اگر در همین فاصله رکورد جدیدی برای همان
                 * شناسه ساخته شده باشد دوباره ثبت می‌شود (پاک‌سازی قدیمی نباید
                 * Snooze جدید را از بین ببرد).
                 */
                TaskAlarmScheduler.cancelAndRestoreIfRecreated(app, started.previous.alarmId);
            }

            if (started.previous.alarmId != alarm.id) {
                /* اعلان نشست قبلی مالک جدید ندارد؛ بعد از شروع نشست جدید جمع شود. */
                cancelNotification(app, started.previous.alarmId);
            }
        }

        handler.removeCallbacks(autoStop);
        handler.postDelayed(autoStop, MAX_RING_MS);
    }

    /**
     * برگرداندن اثرهای یک تلاشِ ring که نشستش ثبت نشد (ABORTED/FAILED):
     * صدا، قفل بیداری، اعلان، سرویس و وضعیت حافظه.
     *
     * <p>فقط وقتی اجرا می‌شود که توکنِ همان تلاش هنوز نشست فعالِ همین
     * پروسه باشد. اگر بین تلاش و rollback نشست جدیدی شروع شده باشد، توکن
     * عوض شده و این متد هیچ‌چیز را لمس نمی‌کند؛ در نتیجه صدای نشست جدید
     * قطع نمی‌شود.
     */
    private static void rollbackRingAttempt(
            Context app,
            int alarmId,
            String token,
            boolean serviceStarted) {
        if (token == null || !token.equals(activeSessionToken)) {
            Log.i(TAG, "RING_ROLLBACK_SKIP alarmId=" + alarmId
                    + " token=" + shortToken(token)
                    + " activeToken=" + shortToken(activeSessionToken));
            return;
        }

        handler.removeCallbacks(autoStop);
        stopRinger();
        releaseWakeLock();
        if (serviceStarted) stopService(app);
        cancelNotification(app, alarmId);

        activeAlarmId = -1;
        activeSessionToken = null;
        activeSince = 0L;
        activeSinceElapsed = 0L;
        activeAlarmAt = 0L;
        activeAlarm = null;
        appContext = null;

        Log.i(TAG, "RING_ROLLBACK_DONE alarmId=" + alarmId + " token=" + shortToken(token));
    }

    public static boolean isRinging() {
        return player != null;
    }

    public static int currentAlarmId() {
        return activeAlarmId;
    }

    /** رکورد نشست فعال (فقط در پروسهٔ آلارم معنا دارد). */
    public static TaskAlarmStore.Alarm currentAlarm() {
        return activeAlarm;
    }

    /** توکن نشست فعال در همین پروسه (برای سرویس/اعلان)؛ null یعنی بدون نشست. */
    public static String currentSessionToken() {
        return activeSessionToken;
    }

    private static boolean isAlarmRuntime(Context context) {
        /*
         * اگر تشخیص نام پروسه به هر دلیل شکست بخورد، وجود player/نشست در
         * حافظهٔ همین پروسه نشانهٔ قطعیِ پروسهٔ آلارم است؛ با این کار از
         * ارسال broadcast به خود و حلقهٔ فرمان جلوگیری می‌شود.
         */
        return TaskAlarmProcess.isAlarmProcess(context)
                || activeAlarmId >= 0
                || player != null;
    }

    private static boolean startService(
            Context context,
            TaskAlarmStore.Alarm alarm,
            String sessionToken) {
        Intent intent = new Intent(context, TaskAlarmService.class);
        intent.setAction(TaskAlarmService.ACTION_START);
        intent.putExtra(TaskAlarmReceiver.EXTRA_ALARM_ID, alarm.id);
        putToken(intent, sessionToken);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
            Log.i(TAG, "SERVICE_START_SENT alarmId=" + alarm.id
                    + " token=" + shortToken(sessionToken));
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
            context.getApplicationContext().stopService(
                    new Intent(context.getApplicationContext(), TaskAlarmService.class));
        } catch (Exception ignored) {
            /* ignore */
        }
    }

    /**
     * توقف کاملِ نشست جاری در همین پروسه. فقط اگر شناسه و توکن با نشست فعال
     * بخوانند کاری می‌کند؛ فرمان دیررس نباید صدای آلارم جدید را قطع کند یا
     * اعلانش را بردارد.
     *
     * @return true اگر نشست همین پروسه (یا نشست منطبق در Store) پایان یافت.
     */
    private static boolean silenceInternal(
            Context app,
            int alarmId,
            String token,
            boolean deleteRecord) {

        boolean memoryMatch = token != null
                ? activeAlarmId == alarmId && token.equals(activeSessionToken)
                : alarmId < 0 || activeAlarmId == alarmId;

        if (!memoryMatch) {
            Log.i(TAG, "SILENCE_STALE requested=" + alarmId
                    + " token=" + shortToken(token)
                    + " active=" + activeAlarmId
                    + " activeToken=" + shortToken(activeSessionToken));

            /*
             * اگر این پروسه تازه بالا آمده و نشستی در حافظه ندارد، ولی توکن
             * دقیقاً با نشست ثبت‌شده در Store می‌خواند، همان نشستِ قدیمی را
             * (که صدایی ندارد) اتمیک جمع می‌کنیم. اگر نشست جدیدتری در Store
             * باشد، endSession «STALE» برمی‌گرداند و هیچ‌چیز لمس نمی‌شود.
             */
            if (activeAlarmId < 0 && token != null && alarmId >= 0) {
                TaskAlarmStore.EndResult result =
                        TaskAlarmStore.endSession(app, alarmId, token, deleteRecord);

                if (result.status == TaskAlarmStore.EndStatus.ENDED
                        && deleteRecord
                        && result.recordDeleted) {
                    TaskAlarmScheduler.cancelAndRestoreIfRecreated(app, alarmId);
                }

                if (result.status == TaskAlarmStore.EndStatus.ENDED
                        || result.status == TaskAlarmStore.EndStatus.NO_SESSION) {
                    cancelNotification(app, alarmId);
                    return true;
                }
            }

            return false;
        }

        int id = activeAlarmId;
        String currentToken = activeSessionToken;
        int sessionId = alarmId < 0 ? activeAlarmId : alarmId;

        handler.removeCallbacks(autoStop);
        stopRinger();
        releaseWakeLock();

        TaskAlarmStore.EndResult result = null;

        if (sessionId >= 0) {
            /*
             * حذف رکورد و پاک‌کردن نشانگر در یک تراکنش. سپس (و نه قبل از آن)
             * زمان‌بندی لغو می‌شود؛ مرگ پروسه بین این دو نمی‌تواند آلارمِ
             * حذف‌شده را زنده کند، چون گیرنده رکوردی برای زنگ‌زدن نمی‌یابد.
             */
            result = TaskAlarmStore.endSession(app, sessionId, currentToken, deleteRecord);

            if (result.status == TaskAlarmStore.EndStatus.ENDED
                    && deleteRecord
                    && result.recordDeleted) {
                TaskAlarmScheduler.cancelAndRestoreIfRecreated(app, sessionId);
            }
        }

        /*
         * اعلان را بعد از قطع صدا و بعد از تلاش برای پایان نشست برمی‌داریم.
         * اگر Store بگوید نشست عوض شده (STALE)، این اعلان احتمالاً مالِ نشست
         * جدید است و نباید حذف شود.
         */
        if (id >= 0 && (result == null || result.status != TaskAlarmStore.EndStatus.STALE)) {
            cancelNotification(app, id);
        }

        stopService(app);

        activeAlarmId = -1;
        activeSessionToken = null;
        activeSince = 0L;
        activeSinceElapsed = 0L;
        activeAlarmAt = 0L;
        activeAlarm = null;
        appContext = null;

        Log.i(TAG, "SILENCE_DONE requested=" + alarmId
                + " token=" + shortToken(token)
                + " wasActive=" + id
                + " status=" + (result == null ? "none" : result.status)
                + " deleteRecord=" + deleteRecord);
        return true;
    }

    /**
     * توقف کامل: صدا، اعلان، سرویس، قفل، حذف آلارم از ذخیره و لغو زمان‌بندی.
     *
     * <p>در پروسهٔ اصلی این متد رکورد را اتمیک حذف می‌کند، بعد زمان‌بندی را
     * لغو می‌کند و در پایان فرمان قطع صدا را می‌فرستد. در پروسهٔ آلارم، عملیات
     * مستقیم روی player انجام می‌شود.
     */
    public static boolean stop(Context context, int alarmId) {
        Context app = context.getApplicationContext();
        TaskAlarmStore.Session session = TaskAlarmStore.session(app);
        String token = session != null && session.alarmId == alarmId ? session.token : null;
        return stop(context, alarmId, token);
    }

    public static boolean stop(Context context, int alarmId, String token) {
        Context app = context.getApplicationContext();
        Log.i(TAG, "CMD_STOP alarmId=" + alarmId
                + " token=" + shortToken(token)
                + " " + TaskAlarmProcess.describe(app));

        if (isAlarmRuntime(app)) {
            return silenceInternal(app, alarmId, token, true);
        }

        boolean notificationActive = hasActiveNotification(app, alarmId);

        /*
         * ترتیب عمدی: اول حذف اتمیک رکورد، بعد لغو PendingIntent. اگر پروسه
         * بین این دو بمیرد، PendingIntent ممکن است شلیک شود ولی گیرنده رکوردی
         * پیدا نمی‌کند؛ برعکسِ ترتیب قبلی، آلارم لغوشده دوباره زنده نمی‌شود.
         */
        TaskAlarmStore.EndResult result =
                TaskAlarmStore.endSession(app, alarmId, token, true);

        if (result.status == TaskAlarmStore.EndStatus.STALE) {
            Log.i(TAG, "STOP_STALE alarmId=" + alarmId + " token=" + shortToken(token));
            return false;
        }

        if (result.recordDeleted) {
            TaskAlarmScheduler.cancelAndRestoreIfRecreated(app, alarmId);
        }

        /*
         * فرمان توقف بعد از حذف رکورد فرستاده می‌شود. توکنِ فرمان از نتیجهٔ
         * خودِ endSession گرفته می‌شود، نه فقط از snapshot اولیه: اگر نشست
         * بین خواندن اولیه و endSession شروع شده باشد، endSession با همان
         * توکن ENDED برمی‌گرداند و باید همان را به پروسهٔ آلارم بفرستیم؛
         * وگرنه صدای نشستی که همین حالا پاک شد تا MAX_RING_MS ادامه می‌یافت.
         * اعلان با توکن‌دار بودن به عهدهٔ پروسهٔ آلارم می‌ماند؛ برای فرمان
         * بدون توکن (cancel اداری) بعد از ارسال خودمان اعلان را جمع می‌کنیم.
         */
        String commandToken = result.token != null ? result.token : token;

        if (commandToken != null || notificationActive) {
            sendCommand(app, TaskAlarmReceiver.ACTION_SILENCE, alarmId, commandToken, 0);
        }

        if (commandToken == null) {
            cancelNotification(app, alarmId);
        }

        if (!result.ok()) {
            Log.e(TAG, "STOP_STORE_FAILED alarmId=" + alarmId
                    + " status=" + result.status);
        }

        return result.ok();
    }

    /**
     * خاموش‌کردن صدای نشست جاری بدون حذف رکورد/زمان‌بندی. برای «تعویق» و
     * پاک‌سازی اعلان یتیم استفاده می‌شود.
     */
    public static boolean silence(Context context, int alarmId) {
        Context app = context.getApplicationContext();
        TaskAlarmStore.Session session = TaskAlarmStore.session(app);
        String token = session != null && session.alarmId == alarmId ? session.token : null;
        return silence(context, alarmId, token);
    }

    public static boolean silence(Context context, int alarmId, String token) {
        Context app = context.getApplicationContext();
        Log.i(TAG, "CMD_SILENCE alarmId=" + alarmId
                + " token=" + shortToken(token)
                + " " + TaskAlarmProcess.describe(app));

        if (isAlarmRuntime(app)) {
            return silenceInternal(app, alarmId, token, false);
        }

        /*
         * اول فرمان (تا اعلان در زمان اجرای توقف برداشته شود)، بعد پاک‌کردن
         * نشانگر. با توکن، حذف اعلان را به پروسهٔ آلارم می‌سپاریم.
         */
        if (token != null || (alarmId >= 0 && hasActiveNotification(app, alarmId))) {
            sendCommand(app, TaskAlarmReceiver.ACTION_SILENCE, alarmId, token, 0);
        }

        TaskAlarmStore.EndResult result =
                TaskAlarmStore.endSession(app, alarmId, token, false);

        if (token == null && alarmId >= 0) {
            cancelNotification(app, alarmId);
        }

        return result.ok();
    }

    /**
     * تعویق: رکورد جدید در `minutes` دقیقه‌ی بعد ثبت و زمان‌بندی می‌شود، سپس
     * زنگ فعلی خاموش می‌شود. رکورد قبلی حذف نمی‌شود؛ همان شناسه با زمان جدید
     * جایگزین می‌شود.
     *
     * @return لحظه‌ی جدید (epoch ms)، یا -1 اگر رکورد پیدا نشود/توکن کهنه باشد/نوشتن شکست بخورد.
     */
    public static long snooze(Context context, int alarmId, int minutes) {
        Context app = context.getApplicationContext();
        TaskAlarmStore.Session session = TaskAlarmStore.session(app);
        String token = session != null && session.alarmId == alarmId ? session.token : null;
        return snooze(context, alarmId, minutes, token);
    }

    public static long snooze(Context context, int alarmId, int minutes, String token) {
        Context app = context.getApplicationContext();
        TaskAlarmStore.Alarm alarm = TaskAlarmStore.get(app, alarmId);

        if (alarm == null) {
            Log.e(TAG, "SNOOZE_NOT_FOUND alarmId=" + alarmId + " " + TaskAlarmProcess.describe(app));
            return -1L;
        }

        boolean alarmProcess = isAlarmRuntime(app);

        /*
         * بررسی سریع در همین پروسه (وقتی فرمان از اعلان/صفحهٔ قدیمی می‌آید):
         * توکن کهنه نباید حتی رکورد را عوض کند. اگر نشستی در حافظه نیست،
         * Store داور نهایی است (snoozeSession اتمیک).
         */
        if (token != null && alarmProcess) {
            if (activeAlarmId >= 0
                    && (activeAlarmId != alarmId || !token.equals(activeSessionToken))) {
                Log.i(TAG, "SNOOZE_STALE alarmId=" + alarmId
                        + " token=" + shortToken(token)
                        + " active=" + activeAlarmId
                        + " activeToken=" + shortToken(activeSessionToken));
                return -1L;
            }

            if (activeAlarmId < 0) {
                TaskAlarmStore.Session session = TaskAlarmStore.session(app);
                if (session == null
                        || session.alarmId != alarmId
                        || !token.equals(session.token)) {
                    Log.i(TAG, "SNOOZE_STALE_STORE alarmId=" + alarmId
                            + " token=" + shortToken(token));
                    return -1L;
                }
            }
        }

        int safeMinutes = Math.max(1, minutes);
        long at = System.currentTimeMillis() + safeMinutes * 60_000L;
        TaskAlarmStore.Alarm next = new TaskAlarmStore.Alarm(
                alarm.id,
                alarm.taskId,
                alarm.title,
                at,
                alarm.createdAt);

        TaskAlarmStore.SnoozeResult stored =
                TaskAlarmStore.snoozeSession(app, next, token);

        if (!stored.ok()) {
            Log.e(TAG, "SNOOZE_STORE_FAILED alarmId=" + alarmId
                    + " status=" + stored.status
                    + " token=" + shortToken(token));
            return -1L;
        }

        boolean exact = TaskAlarmScheduler.schedule(app, next);

        Log.i(TAG, "SNOOZE alarmId=" + alarmId
                + " minutes=" + safeMinutes
                + " at=" + at
                + " exact=" + exact
                + " token=" + shortToken(token)
                + " " + TaskAlarmProcess.describe(app));

        if (alarmProcess) {
            silenceInternal(app, alarmId, token, false);
        } else if (token != null) {
            /* اعلان را پروسهٔ آلارم بعد از اجرای فرمان برمی‌دارد. */
            sendCommand(app, TaskAlarmReceiver.ACTION_SILENCE, alarmId, token, 0);
        } else if (alarmId >= 0 && hasActiveNotification(app, alarmId)) {
            sendCommand(app, TaskAlarmReceiver.ACTION_SILENCE, alarmId, null, 0);
            cancelNotification(app, alarmId);
        }

        return at;
    }

    /**
     * پاک‌سازی نشستِ یتیم: اگر پروسهٔ آلارم بعد از زنگ مرده باشد، ممکن است
     * نشانگر فعال و اعلان باقی مانده باشند. فقط بعد از گذشت سقف زنگ + مهلت
     * دست می‌زنیم تا زنگِ سالمِ در جریان را قطع نکنیم.
     */
    public static void cleanupOrphanedRing(Context context) {
        Context app = context.getApplicationContext();
        TaskAlarmStore.Session session = TaskAlarmStore.session(app);

        if (session == null) return;

        long wallAge = System.currentTimeMillis() - session.since;
        long elapsedAge = session.sinceElapsed > 0L
                ? SystemClock.elapsedRealtime() - session.sinceElapsed
                : -1L;

        /*
         * مرجع اصلی، ساعت monotonic است تا تغییر ساعت دیواری/منطقه‌ای باعث
         * پاک‌شدن زنگِ سالم نشود. برای دادهٔ قدیمی که monotonic ندارد، فقط
         * ساعت دیواری در دسترس است و مقدار منفی به‌عنوان صفر (نه کهنه) دیده
         * می‌شود.
         */
        long age = elapsedAge >= 0L ? elapsedAge : Math.max(0L, wallAge);
        boolean unknownAge = session.since <= 0L && session.sinceElapsed <= 0L;
        boolean stale = unknownAge || age > MAX_RING_MS + ORPHAN_GRACE_MS;

        if (!stale) {
            Log.i(TAG, "ORPHAN_ACTIVE alarmId=" + session.alarmId
                    + " ageMs=" + age
                    + " monotonic=" + (elapsedAge >= 0L)
                    + " " + TaskAlarmProcess.describe(app));
            return;
        }

        Log.w(TAG, "ORPHAN_CLEANUP alarmId=" + session.alarmId
                + " token=" + shortToken(session.token)
                + " ageMs=" + age
                + " " + TaskAlarmProcess.describe(app));

        if (isAlarmRuntime(app)) {
            silenceInternal(app, session.alarmId, session.token, true);
            return;
        }

        /*
         * پاک‌سازی اتمیک: اگر در همین فاصله Snooze/نشست جدیدی برای همان شناسه
         * ساخته شده باشد، endSession با STALE برمی‌گردد و هیچ رکورد/زمان‌بندی
         * جدیدی لمس نمی‌شود. رکورد فقط با تطبیق id+at حذف می‌شود.
         */
        TaskAlarmStore.EndResult result = TaskAlarmStore.endSession(
                app, session.alarmId, session.token, true);

        if (result.status == TaskAlarmStore.EndStatus.STALE) {
            Log.i(TAG, "ORPHAN_CLEANUP_STALE alarmId=" + session.alarmId);
            return;
        }

        if (result.recordDeleted) {
            TaskAlarmScheduler.cancelAndRestoreIfRecreated(app, session.alarmId);
        }

        /* فرمان بعد از حذف رکورد؛ حذف اعلان با گیرندهٔ پروسهٔ آلارم است. */
        sendCommand(app, TaskAlarmReceiver.ACTION_SILENCE,
                session.alarmId, session.token, 0);
    }

    /** ارسال فرمان صریح به گیرندهٔ پروسهٔ آلارم (غیر export شده). */
    private static boolean sendCommand(
            Context context,
            String action,
            int alarmId,
            String sessionToken,
            int minutes) {

        Intent intent = new Intent(context.getApplicationContext(), TaskAlarmReceiver.class);
        intent.setAction(action);
        intent.putExtra(TaskAlarmReceiver.EXTRA_ALARM_ID, alarmId);
        putToken(intent, sessionToken);
        if (minutes > 0) {
            intent.putExtra(TaskAlarmReceiver.EXTRA_SNOOZE_MINUTES, minutes);
        }

        try {
            context.getApplicationContext().sendBroadcast(intent);
            Log.i(TAG, "IPC_SEND action=" + action
                    + " alarmId=" + alarmId
                    + " token=" + shortToken(sessionToken)
                    + " minutes=" + minutes);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "IPC_SEND_FAILED action=" + action + " alarmId=" + alarmId, e);
            return false;
        }
    }

    private static void putToken(Intent intent, String sessionToken) {
        if (sessionToken != null && !sessionToken.isEmpty()) {
            intent.putExtra(TaskAlarmReceiver.EXTRA_SESSION_TOKEN, sessionToken);
        }
    }

    private static String shortToken(String token) {
        if (token == null) return "null";
        return token.length() <= 8 ? token : token.substring(0, 8);
    }
}
