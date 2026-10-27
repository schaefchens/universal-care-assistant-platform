#!/bin/sh
# Builds the spike app of docs/plan-m4.md (G0) with the SDK's own tools, no Gradle: Android's unlock with a key bound
# to it, the home role, screen pinning and lock task as device owner, the phone role (de.schaefchens.ucap.spike4).
# Debug-signed, for a scratch emulator only. Output: build/spike4.apk.
set -e
cd "$(dirname "$0")"
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="$SDK/build-tools/36.0.0"
JAR="$SDK/platforms/android-36/android.jar"
rm -rf build
out=build/spike
mkdir -p "$out/classes" "$out/dex" "$out/res"
"$BT/aapt2" compile --dir spike/res -o "$out/res/res.zip"
"$BT/aapt2" link -o "$out/base.apk" --manifest spike/AndroidManifest.xml -I "$JAR" -R "$out/res/res.zip" --min-sdk-version 30 --target-sdk-version 36 --debug-mode
"$JAVA_HOME/bin/javac" -nowarn -Xlint:-options -source 17 -target 17 -classpath "$JAR" -d "$out/classes" $(find spike/src -name '*.java')
"$BT/d8" --release --min-api 30 --lib "$JAR" --output "$out/dex" $(find "$out/classes" -name '*.class')
(cd "$out/dex" && zip -q ../base.apk classes.dex)
"$BT/zipalign" -p -f 4 "$out/base.apk" "$out/aligned.apk"
"$BT/apksigner" sign --ks "$HOME/.android/debug.keystore" --ks-pass pass:android --key-pass pass:android --out build/spike4.apk "$out/aligned.apk"
ls -l build/*.apk
