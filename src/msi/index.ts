/**
 * MSI Clutch GM41 (and compatible MSI mice) vendor HID protocol — pure
 * encode helpers.
 *
 * Transport: MSI's configuration interface is a fixed-size USB HID Feature
 * report, sent as a standard USB control transfer:
 *   bmRequestType 0x21 (host->device, class, interface)
 *   bRequest      9    (SET_REPORT)
 *   wValue        0x0300 (Report Type = Feature, report id 0)
 *   wIndex        1    (the "Vendor Defined" interface — MI_01 on Windows)
 *   wLength       8
 *
 * Every report is exactly 8 bytes: a constant 0x0d frame marker, a command
 * byte, then up to 6 payload bytes, zero-padded to fill the report.
 *
 * No read-back report has been identified for these settings yet, so this
 * protocol is currently write-only from this package's point of view — see
 * docs/msi-testing.md for the reverse-engineering notes, evidence, and open
 * questions (in particular the unconfirmed 0x02 "session" command that
 * precedes button-binding and colour writes).
 */

export const MSI_VENDOR_ID = 0x0db0;
export const MSI_PRODUCT_ID = 0x0d4c; // MSI Clutch GM41

export const MSI_REPORT_LENGTH = 8;
/** Constant first byte of every report. Not a WebHID "report id" — MSI always
 * sends report id 0 (see wValue above) and puts this marker in the payload. */
export const MSI_FRAME_MARKER = 0x0d;

export const MSI_COMMAND = {
  buttonBind: 0x41,
  pollingRate: 0x11,
  angleSnapping: 0x12,
  liftOffDistance: 0x14,
  dpiPresetWrite: 0x15,
  dpiPresetSelect: 0x16,
  motionSync: 0x1a,
  autoLedOff: 0x32,
  colourMode: 0x33,
  brightness: 0x34,
  speed: 0x36,
  customRgb: 0x37,
  dpiStage: 0x96,
  /**
   * Sent before button-binding and colour writes only (not DPI, polling, or
   * power writes) as `0x02 [09|02] 00 00 00 00 00` then
   * `0x02 0xe8 0x03 00 00 00 00` (0x03e8 = 1000 as little-endian u16).
   * Purpose unconfirmed — see docs/msi-testing.md.
   */
  sessionInit: 0x02,
} as const;

/**
 * Build one 8-byte MSI feature report: frame marker, command, then payload
 * bytes, zero-padded to fill the report. Throws if the payload is too long
 * to fit (command byte + payload must be <= 7 bytes, leaving byte 0 for the
 * frame marker).
 */
export function buildMsiReport(command: number, payload: readonly number[] = []): Uint8Array<ArrayBuffer> {
  if (payload.length > MSI_REPORT_LENGTH - 2) {
    throw new Error(`MSI report payload too long: ${payload.length} bytes (max ${MSI_REPORT_LENGTH - 2}).`);
  }
  const report = new Uint8Array(MSI_REPORT_LENGTH);
  report[0] = MSI_FRAME_MARKER;
  report[1] = command;
  for (let index = 0; index < payload.length; index += 1) report[2 + index] = payload[index] ?? 0;
  return report;
}

// ---------------------------------------------------------------------------
// DPI
// ---------------------------------------------------------------------------

/** The five fixed DPI stage slots, selected by dedicated single-byte codes
 * rather than through the preset-select command below. */
export const MSI_DPI_STAGE_BYTE: Record<1 | 2 | 3 | 4 | 5, number> = {
  1: 0x80, 2: 0x81, 3: 0x82, 4: 0x83, 5: 0x84,
};

export function encodeMsiDpiStage(stage: 1 | 2 | 3 | 4 | 5): Uint8Array<ArrayBuffer> {
  return buildMsiReport(MSI_COMMAND.dpiStage, [MSI_DPI_STAGE_BYTE[stage]]);
}

export const MSI_DPI_PRESET_MIN = 100;
export const MSI_DPI_PRESET_MAX = 25500; // 0xff * 100 -- the value byte is a single u8
export const MSI_DPI_PRESET_STEP = 100;

export function isValidMsiDpiPreset(dpi: number): boolean {
  return Number.isInteger(dpi)
    && dpi >= MSI_DPI_PRESET_MIN
    && dpi <= MSI_DPI_PRESET_MAX
    && dpi % MSI_DPI_PRESET_STEP === 0;
}

/** Write all five custom DPI presets in one report. Each value is DPI / 100. */
export function encodeMsiDpiPresetWrite(presets: readonly [number, number, number, number, number]): Uint8Array<ArrayBuffer> {
  for (const dpi of presets) {
    if (!isValidMsiDpiPreset(dpi)) {
      throw new Error(
        `MSI DPI presets must be ${MSI_DPI_PRESET_MIN}–${MSI_DPI_PRESET_MAX} in ${MSI_DPI_PRESET_STEP} DPI steps.`,
      );
    }
  }
  const payload = presets.map((dpi) => dpi / 100);
  return buildMsiReport(MSI_COMMAND.dpiPresetWrite, [...payload, 0]);
}

/** Select which of the five custom presets (0-indexed: 0 = preset 1) is active. */
export function encodeMsiDpiPresetSelect(slot: 0 | 1 | 2 | 3 | 4): Uint8Array<ArrayBuffer> {
  return buildMsiReport(MSI_COMMAND.dpiPresetSelect, [slot]);
}

// ---------------------------------------------------------------------------
// Polling rate
// ---------------------------------------------------------------------------

/** 1000 Hz has no observed explicit command — it appears to be the device
 * default reached by simply not sending an override. */
export const MSI_POLLING_RATE_BYTE: ReadonlyMap<number, number> = new Map([
  [500, 0x02],
  [250, 0x04],
  [125, 0x08],
]);

export const MSI_SUPPORTED_POLLING_RATES = [125, 250, 500, 1000] as const;

export function encodeMsiPollingRate(hz: number): Uint8Array<ArrayBuffer> | null {
  if (hz === 1000) return null; // no override to send
  const encoded = MSI_POLLING_RATE_BYTE.get(hz);
  if (encoded === undefined) {
    throw new Error("MSI supports 125, 250, 500, or 1000 Hz polling rate.");
  }
  return buildMsiReport(MSI_COMMAND.pollingRate, [encoded]);
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

export function encodeMsiAngleSnapping(enabled: boolean): Uint8Array<ArrayBuffer> {
  return buildMsiReport(MSI_COMMAND.angleSnapping, [enabled ? 0x01 : 0x00]);
}

export function encodeMsiMotionSync(enabled: boolean): Uint8Array<ArrayBuffer> {
  return buildMsiReport(MSI_COMMAND.motionSync, [enabled ? 0x01 : 0x00]);
}

/** MSI's Clutch GM41 exposes two lift-off distance stops, not the usual three. */
export type MsiLiftOffDistance = "Low" | "High";

export function encodeMsiLiftOffDistance(value: MsiLiftOffDistance): Uint8Array<ArrayBuffer> {
  return buildMsiReport(MSI_COMMAND.liftOffDistance, [value === "High" ? 0x02 : 0x01]);
}

// ---------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------

export function encodeMsiAutoLedOff(enabled: boolean): Uint8Array<ArrayBuffer> {
  return buildMsiReport(MSI_COMMAND.autoLedOff, [enabled ? 0x01 : 0x00]);
}

// ---------------------------------------------------------------------------
// RGB / colour
// ---------------------------------------------------------------------------

export type MsiColourMode = "Off" | "Steady" | "Breath" | "Rainbow" | "Customise";

const COLOUR_MODE_BYTE: Record<MsiColourMode, number> = {
  Off: 0x00, Steady: 0x01, Breath: 0x02, Rainbow: 0x03, Customise: 0x04,
};

export function encodeMsiColourMode(mode: MsiColourMode): Uint8Array<ArrayBuffer> {
  return buildMsiReport(MSI_COMMAND.colourMode, [COLOUR_MODE_BYTE[mode]]);
}

export type MsiLevel = "None" | "Half" | "Max";

const BRIGHTNESS_BYTE: Record<MsiLevel, number> = { None: 0x01, Half: 0x02, Max: 0x03 };
const SPEED_BYTE: Record<MsiLevel, number> = { None: 0x00, Half: 0x01, Max: 0x02 };

export function encodeMsiBrightness(level: MsiLevel): Uint8Array<ArrayBuffer> {
  return buildMsiReport(MSI_COMMAND.brightness, [BRIGHTNESS_BYTE[level]]);
}

export function encodeMsiSpeed(level: MsiLevel): Uint8Array<ArrayBuffer> {
  return buildMsiReport(MSI_COMMAND.speed, [SPEED_BYTE[level]]);
}

/**
 * Set the custom RGB colour (colour mode "Customise"). `0x12` is a constant
 * sub-command byte confirmed against two different colours (red and green) —
 * it does not vary with colour, so it is not a zone/slot index.
 */
export function encodeMsiCustomRgb(red: number, green: number, blue: number): Uint8Array<ArrayBuffer> {
  for (const channel of [red, green, blue]) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new Error("MSI custom RGB channels must be integers 0-255.");
    }
  }
  return buildMsiReport(MSI_COMMAND.customRgb, [0x12, red, green, blue]);
}

// ---------------------------------------------------------------------------
// Button bindings
// ---------------------------------------------------------------------------

export const MSI_BUTTON_ID = {
  left: 0x01,
  right: 0x02,
  scrollClick: 0x04,
  back: 0x08, // MB5
  forward: 0x10, // MB4
} as const;

export type MsiButtonId = typeof MSI_BUTTON_ID[keyof typeof MSI_BUTTON_ID];

export type MsiMouseFunction =
  | "Left click" | "Right click" | "Scroll click" | "Backwards" | "Forwards"
  | "Disable" | "Scroll up" | "Scroll down";

const MOUSE_FUNCTION_BYTES: Record<MsiMouseFunction, readonly [group: number, code: number]> = {
  "Left click": [0x07, 0x01],
  "Right click": [0x07, 0x02],
  "Scroll click": [0x07, 0x04],
  Backwards: [0x07, 0x08],
  Forwards: [0x07, 0x10],
  Disable: [0x07, 0x00],
  "Scroll up": [0x08, 0x01],
  "Scroll down": [0x08, 0xff],
};

/** Bind a button to a core mouse function (click, scroll wheel step, or disable). */
export function encodeMsiButtonMouseFunction(button: MsiButtonId, fn: MsiMouseFunction): Uint8Array<ArrayBuffer> {
  const [group, code] = MOUSE_FUNCTION_BYTES[fn];
  return buildMsiReport(MSI_COMMAND.buttonBind, [button, 0x00, group, 0x00, code, 0x00]);
}

export type MsiMultimediaFunction =
  | "Play/Pause" | "Stop" | "Previous track" | "Next track"
  | "Volume up" | "Volume down" | "Mute";

/** Standard USB HID Consumer Page usage codes MSI's software sends for these. */
const MULTIMEDIA_CODE: Record<MsiMultimediaFunction, number> = {
  "Play/Pause": 0xcd, Stop: 0xb7, "Previous track": 0xb6, "Next track": 0xb5,
  "Volume up": 0xe9, "Volume down": 0xea, Mute: 0xe2,
};

/** Bind a button to a multimedia (consumer-control) function. */
export function encodeMsiButtonMultimedia(button: MsiButtonId, fn: MsiMultimediaFunction): Uint8Array<ArrayBuffer> {
  return buildMsiReport(MSI_COMMAND.buttonBind, [button, 0x00, 0x0a, MULTIMEDIA_CODE[fn], 0x00, 0x00]);
}

/** Bind a button to a macro slot (1-30). */
export function encodeMsiButtonMacro(button: MsiButtonId, slot: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(slot) || slot < 1 || slot > 30) {
    throw new Error("MSI macro slot must be an integer 1-30.");
  }
  return buildMsiReport(MSI_COMMAND.buttonBind, [button, 0x00, 0x0b, slot, 0x01, 0x00]);
}

export type MsiButtonDpiAction = "Cycle +" | "Cycle -" | "Default" | "Select level";

const DPI_ACTION_CODE: Record<MsiButtonDpiAction, number> = {
  "Cycle +": 0x01, "Cycle -": 0x02, Default: 0x03, "Select level": 0x04,
};

/**
 * Bind a button to a DPI action. `level` (1-5) is required and only used
 * when `action` is "Select level"; MSI's software always sends a level byte
 * regardless, so this always includes one (0 when unused).
 */
export function encodeMsiButtonDpi(button: MsiButtonId, action: MsiButtonDpiAction, level?: 1 | 2 | 3 | 4 | 5): Uint8Array<ArrayBuffer> {
  const levelByte = action === "Select level" ? (level ?? 1) - 1 : 0;
  return buildMsiReport(MSI_COMMAND.buttonBind, [button, 0x00, 0x0c, DPI_ACTION_CODE[action], levelByte, 0x00]);
}

// ---------------------------------------------------------------------------
// Session-init command (unconfirmed purpose — see docs/msi-testing.md)
// ---------------------------------------------------------------------------

/**
 * MSI's software sends this pair before button-binding and colour writes
 * only. Included for completeness / evidence, but the driver does not send
 * it — every button/colour write observed so far still succeeded without it
 * in ad hoc testing order, and CONTRIBUTING.md asks us not to send commands
 * we can't explain. Revisit if a colour/button write is ever found not to
 * take effect without it.
 */
export function encodeMsiSessionInit(marker: number): readonly [Uint8Array, Uint8Array] {
  return [
    buildMsiReport(MSI_COMMAND.sessionInit, [marker, 0x00, 0x00, 0x00, 0x00, 0x00]),
    buildMsiReport(MSI_COMMAND.sessionInit, [0xe8, 0x03, 0x00, 0x00, 0x00, 0x00]),
  ];
}
