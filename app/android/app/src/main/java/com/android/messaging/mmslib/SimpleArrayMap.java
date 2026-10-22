package com.android.messaging.mmslib;

import java.util.HashMap;

/**
 * UCAP's stand-in for androidx.collection.SimpleArrayMap in the vendored MMS PDU code, so the parser runs on the plain
 * JVM for tests. Part of UCAP (AGPL-3.0-or-later), not of AOSP.
 */
public final class SimpleArrayMap<K, V> extends HashMap<K, V> {}
