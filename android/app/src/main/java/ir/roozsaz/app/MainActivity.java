package ir.roozsaz.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import ir.roozsaz.app.alarm.TaskAlarmPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        /*
         * پلاگین آلارم تسک باید **قبل** از super.onCreate ثبت شود؛ Capacitor
         * فقط در همین بازه پلاگین‌های محلی را می‌شناسد. هیچ پلاگین دیگری تغییر
         * نکرده است.
         */
        registerPlugin(TaskAlarmPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
