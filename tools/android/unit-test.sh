#!/bin/sh
# Runs the app's JVM unit tests (app/android/app/src/test): the plugins' pure Java parts, such as SigFormat.
set -e
cd "$(dirname "$0")/../../app/android"
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
./gradlew testDebugUnitTest --console=plain -q ${GRADLE_OFFLINE:+--offline}
grep -ho 'tests="[0-9]*" skipped="[0-9]*" failures="[0-9]*" errors="[0-9]*"' app/build/test-results/testDebugUnitTest/*.xml
