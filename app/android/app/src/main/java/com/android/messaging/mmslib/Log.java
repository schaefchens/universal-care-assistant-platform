package com.android.messaging.mmslib;

/**
 * UCAP's stand-in for android.util.Log in the vendored MMS PDU code: it logs nothing. The parser's verbose lines carry
 * header values (addresses, subjects), and UCAP logs no message content; it also lets the parser run on the plain JVM
 * for tests. Part of UCAP (AGPL-3.0-or-later), not of AOSP.
 */
public final class Log {
    private Log() {}

    public static int v(String tag, String msg) {
        return 0;
    }

    public static int v(String tag, String msg, Throwable t) {
        return 0;
    }

    public static int e(String tag, String msg) {
        return 0;
    }

    public static int e(String tag, String msg, Throwable t) {
        return 0;
    }

    public static int w(String tag, String msg) {
        return 0;
    }

    public static int d(String tag, String msg) {
        return 0;
    }
}
