package de.schaefchens.ucap;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * Whole files read and written with streams: java.nio.file needs Android 8 (API 26), and the app runs from Android 7
 * (API 24), where its classes are missing and the call ends the process (an Error, which no `catch (Exception)` takes).
 */
final class Io {
    private Io() {}

    static byte[] readAll(File f) throws IOException {
        try (FileInputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.max(0, Math.min(f.length(), Integer.MAX_VALUE)));
            byte[] buf = new byte[16 * 1024];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    static void writeAll(File f, byte[] data) throws IOException {
        try (FileOutputStream out = new FileOutputStream(f)) {
            out.write(data);
        }
    }
}
