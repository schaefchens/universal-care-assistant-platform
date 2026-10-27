-- What a device can open and whether it is the home screen (docs/plan-m4.md, G8): reported by the device itself, read
-- by the person and helpers who may set it up (for areas that open apps). Names and package names only.
ALTER TABLE devices ADD COLUMN apps jsonb;
ALTER TABLE devices ADD COLUMN home boolean;
-- What the kiosk is doing on the device (G9): its mode (off, pinned, locked) and whether UCAP is the device owner.
ALTER TABLE devices ADD COLUMN kiosk jsonb;
