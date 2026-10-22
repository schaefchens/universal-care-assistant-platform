package com.android.messaging.mmslib;

import java.util.HashMap;

/**
 * UCAP's stand-in for android.util.SparseArray in the vendored MMS PDU code (the calls it makes: get and put), so the
 * parser runs on the plain JVM for tests. Part of UCAP (AGPL-3.0-or-later), not of AOSP.
 */
public final class SparseArray<E> {
    private final HashMap<Integer, E> map = new HashMap<>();

    public E get(int key) {
        return map.get(key);
    }

    public E get(int key, E fallback) {
        E v = map.get(key);
        return v != null ? v : fallback;
    }

    public void put(int key, E value) {
        map.put(key, value);
    }

    public int size() {
        return map.size();
    }
}
