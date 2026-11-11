#!/usr/bin/env bash
# Patches the generated Android project: permissions, icons, splash, foreground service.
set -euo pipefail
M=android/app/src/main/AndroidManifest.xml
R=android/app/src/main/res
CONVERT=$(command -v magick || command -v convert)

sed -i 's#<application#<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />\n    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />\n    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n    <uses-permission android:name="android.permission.WAKE_LOCK" />\n    <uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS" />\n    <application android:largeHeap="true"#' "$M"
sed -i 's#<activity#<activity android:screenOrientation="portrait"#' "$M"

if [ -d node_modules/@capawesome-team/capacitor-android-foreground-service ]; then
  sed -i 's#</application>#    <service android:name="io.capawesome.capacitorjs.plugins.foregroundservice.AndroidForegroundService" android:foregroundServiceType="mediaPlayback" android:exported="false" />\n    <receiver android:name="io.capawesome.capacitorjs.plugins.foregroundservice.NotificationActionBroadcastReceiver" android:exported="false" />\n</application>#' "$M"
  echo "Foreground service patched in."
else
  echo "Foreground service plugin not installed - skipping."
fi

# Native keep-alive plugin: CPU wake lock while reading (so reading continues with the screen off),
# keeps the web view running in the background, and opens the battery "Unrestricted" setting.
MAIN=$(find android/app/src/main/java -name MainActivity.java | head -1)
if [ -n "$MAIN" ]; then
  JDIR=$(dirname "$MAIN")
  PKG=$(grep -m1 '^package ' "$MAIN" | sed 's/^package \(.*\);.*/\1/')
  cat > "$JDIR/KeepAlivePlugin.java" <<'JAVA'
package __PKG__;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "KeepAlive")
public class KeepAlivePlugin extends Plugin {
    private PowerManager.WakeLock wakeLock;

    private boolean isHeld() {
        return wakeLock != null && wakeLock.isHeld();
    }

    @PluginMethod
    public void hold(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        try {
            if (on) {
                if (wakeLock == null) {
                    PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OfflineReader:reading");
                    wakeLock.setReferenceCounted(false);
                }
                wakeLock.acquire(8L * 60L * 60L * 1000L);
            } else if (isHeld()) {
                wakeLock.release();
            }
            JSObject r = new JSObject();
            r.put("held", isHeld());
            call.resolve(r);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void batteryStatus(PluginCall call) {
        try {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            boolean ok = Build.VERSION.SDK_INT < 23 || pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
            JSObject r = new JSObject();
            r.put("unrestricted", ok);
            call.resolve(r);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void requestUnrestricted(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            try {
                Intent j = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                j.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(j);
                call.resolve();
            } catch (Exception e2) {
                call.reject(String.valueOf(e2.getMessage()));
            }
        }
    }

    private void keepWebViewRunning() {
        if (!isHeld()) return;
        try {
            final WebView w = getBridge().getWebView();
            w.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        w.onResume();
                        w.resumeTimers();
                    } catch (Exception ignored) {
                    }
                }
            });
        } catch (Exception ignored) {
        }
    }

    @Override
    protected void handleOnPause() {
        keepWebViewRunning();
    }

    @Override
    protected void handleOnStop() {
        keepWebViewRunning();
    }

    @Override
    protected void handleOnDestroy() {
        try {
            if (isHeld()) wakeLock.release();
        } catch (Exception ignored) {
        }
    }
}
JAVA
  sed -i "s/__PKG__/$PKG/" "$JDIR/KeepAlivePlugin.java"
  cat > "$MAIN" <<JAVA
package $PKG;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KeepAlivePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
JAVA
  echo "Keep-alive plugin added to $PKG."
else
  echo "MainActivity.java not found - keep-alive plugin skipped."
fi

mkdir -p "$R/drawable"
cat > "$R/drawable/ic_stat_reader.xml" <<'XML'
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
  <path android:fillColor="#FFFFFFFF" android:pathData="M3,5v13c2.5,-1 5.5,-1 9,1c3.5,-2 6.5,-2 9,-1V5c-2.5,-1 -5.5,-1 -9,1C8.5,4 5.5,4 3,5z"/>
</vector>
XML

for d in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  dpi=${d%%:*}; px=${d##*:}
  mkdir -p "$R/mipmap-$dpi"
  $CONVERT icon-512.png -resize ${px}x${px} "$R/mipmap-$dpi/ic_launcher.png"
  cp "$R/mipmap-$dpi/ic_launcher.png" "$R/mipmap-$dpi/ic_launcher_round.png"
done
rm -rf "$R/mipmap-anydpi-v26"
find "$R" -name splash.png -exec cp splash.png {} \;
echo "Android project patched."
