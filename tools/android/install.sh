#!/bin/sh
# Builds the app, installs it on the connected device or emulator, points it at the dev stack and starts it.
# The stack is reached through adb reverse as http://localhost:8810 (no mixed content from https://localhost).
set -e
cd "$(dirname "$0")/../../app"
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ANDROID_HOME="$HOME/Library/Android/sdk"
ADB="$ANDROID_HOME/platform-tools/adb"
npx vite build >/dev/null
npx cap sync android >/dev/null
(cd android && ./gradlew assembleDebug --console=plain -q ${GRADLE_OFFLINE:+--offline})
# No -g: permissions are asked for in the app, as a person will see them.
"$ADB" install -r android/app/build/outputs/apk/debug/app-debug.apk | tail -1
"$ADB" reverse tcp:8810 tcp:8810 >/dev/null
"$ADB" reverse tcp:8811 tcp:8811 >/dev/null
"$ADB" shell am force-stop de.schaefchens.ucap
"$ADB" shell am start -W -n de.schaefchens.ucap/.MainActivity | grep TotalTime
