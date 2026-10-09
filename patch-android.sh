#!/usr/bin/env bash
# Patches the generated Android project: permissions, icons, splash, foreground service.
set -euo pipefail
M=android/app/src/main/AndroidManifest.xml
R=android/app/src/main/res
CONVERT=$(command -v magick || command -v convert)

sed -i 's#<application#<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />\n    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />\n    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n    <uses-permission android:name="android.permission.WAKE_LOCK" />\n    <application android:largeHeap="true"#' "$M"
sed -i 's#<activity#<activity android:screenOrientation="portrait"#' "$M"

if [ -d node_modules/@capawesome-team/capacitor-android-foreground-service ]; then
  sed -i 's#</application>#    <service android:name="io.capawesome.capacitorjs.plugins.foregroundservice.AndroidForegroundService" android:foregroundServiceType="mediaPlayback" android:exported="false" />\n    <receiver android:name="io.capawesome.capacitorjs.plugins.foregroundservice.NotificationActionBroadcastReceiver" android:exported="false" />\n</application>#' "$M"
  echo "Foreground service patched in."
else
  echo "Foreground service plugin not installed - skipping."
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
