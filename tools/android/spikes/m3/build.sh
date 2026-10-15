#!/bin/sh
# Builds the two spike apps of docs/plan-m3.md (K0 C and D) with the SDK's own tools, no Gradle: the SMS-role and
# notification-listener spike (de.schaefchens.ucap.spike) and a stand-in messenger. Debug-signed, for the emulator
# only. Their own packages: UCAP's installed app stays as it is. Output: build/spike.apk, build/messenger.apk.
set -e
cd "$(dirname "$0")"
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="$SDK/build-tools/35.0.0"
JAR="$SDK/platforms/android-36/android.jar"
rm -rf build
for app in spike messenger; do
  out="build/$app"
  mkdir -p "$out/classes" "$out/dex"
  "$BT/aapt2" link -o "$out/base.apk" --manifest "$app/AndroidManifest.xml" -I "$JAR" --min-sdk-version 29 --target-sdk-version 36 --debug-mode
  # Only android.* and basic java.* APIs: compiled against android.jar.
  "$JAVA_HOME/bin/javac" -nowarn -Xlint:-options -source 17 -target 17 -classpath "$JAR" -d "$out/classes" $(find "$app/src" -name '*.java')
  "$BT/d8" --release --min-api 29 --lib "$JAR" --output "$out/dex" $(find "$out/classes" -name '*.class')
  (cd "$out/dex" && zip -q ../base.apk classes.dex)
  "$BT/zipalign" -p -f 4 "$out/base.apk" "$out/aligned.apk"
  "$BT/apksigner" sign --ks "$HOME/.android/debug.keystore" --ks-pass pass:android --key-pass pass:android --out "build/$app.apk" "$out/aligned.apk"
done
ls -l build/*.apk
