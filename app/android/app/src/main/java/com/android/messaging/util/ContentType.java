package com.android.messaging.util;

/**
 * The MMS multipart types the vendored PDU parser names (AOSP Messaging's ContentType holds many more). Part of UCAP
 * (AGPL-3.0-or-later), not of AOSP.
 */
public final class ContentType {
    private ContentType() {}

    public static final String MMS_MULTIPART_MIXED = "application/vnd.wap.multipart.mixed";
    public static final String MMS_MULTIPART_RELATED = "application/vnd.wap.multipart.related";
    public static final String MMS_MULTIPART_ALTERNATIVE = "application/vnd.wap.multipart.alternative";
}
