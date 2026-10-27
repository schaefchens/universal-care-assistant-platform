package de.schaefchens.ucap;

import android.app.admin.DeviceAdminReceiver;

/**
 * UCAP's device administrator (docs/plan-m4.md, G9): what makes a dedicated device's kiosk possible when an operator
 * set UCAP up as its device owner (operator.md). It asks for no policy of its own; lock task needs none.
 */
public class UcapAdmin extends DeviceAdminReceiver {}
