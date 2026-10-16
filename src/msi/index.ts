/**
 * MSI Clutch GM41 (`0db0:0d4c`) vendor feature-report protocol.
 *
 * Source: USBPcap captures of MSI Center configuring a GM41 on Windows, one
 * capture per settings page (see docs/msi-clutch-gm41-testing.md).
 *
 * Every command is an 8-byte unnumbered feature report (SET_REPORT, report
 * id 0) on the vendor interface (MI_01): a constant 0x0d marker, a command
 * byte, then up to six argument bytes, zero-padded. Performance, DPI, polling,
 * and power commands are sent on their own. Lighting and button commands are
 * only ever sent as a block, opened by `0d 02 <kind>` and closed by
 * `0d 02 e8 03`; MSI Center rewrites every lighting setting, or every button,
 * inside one block even when a single value changed.
 *
 * The mouse reports state as 64-byte input reports on the same interface: the
 * command byte with bit 7 set and the current value (`0d 91 01` after a
 * polling write; `0d b3`-`0d b7` cycling through the lighting state during and
 * after a lighting block). No command that reads a setting without writing it
 * has been observed.
 */

export const MSI_VENDOR_ID = 0x0db0;
export const MSI_CLUTCH_GM41_PRODUCT_ID = 0x0d4c;

/**
 * The GM41 surfaces three collections to WebHID. Only this one (Windows MI_01,
 * "Vendor Defined") accepts feature reports; the boot-mouse and
 * keyboard/consumer collections are owned by the OS and reject writes.
 */
export const MSI_CONFIG_USAGE_PAGE = 0xff10;
export const MSI_CONFIG_USAGE = 0x06;
/** The feature report is unnumbered. */
export const MSI_REPORT_ID = 0;
export const MSI_REPORT_SIZE = 8;
/** First byte of every command. Part of the payload, not a report id. */
export const MSI_MARKER = 0x0d;

export const MSI_CMD = {
  /** Opens (`02 <kind>`) or closes (`02 e8 03`) a lighting or button block. */
  block: 0x02,
  pollingInterval: 0x11,
  angleSnapping: 0x12,
  liftOffDistance: 0x14,
  dpiPresets: 0x15,
  dpiPresetSelect: 0x16,
  motionSync: 0x1a,
  autoLedOff: 0x32,
  lightingMode: 0x33,
  lightingBrightness: 0x34,
  lightingSpeed: 0x36,
  lightingColor: 0x37,
  buttonBinding: 0x41,
} as const;

export const MSI_BLOCK = { lighting: 0x02, buttons: 0x09 } as const;
export type MsiBlock = keyof typeof MSI_BLOCK;
/** Argument bytes of the closing `0d 02 e8 03` report (0x03e8, little-endian). */
const BLOCK_END = [0xe8, 0x03] as const;

export function msiEncodeCommand(command: number, args: readonly number[] = []): Uint8Array<ArrayBuffer> {
  if (args.length > MSI_REPORT_SIZE - 2) throw new RangeError("MSI commands carry at most six argument bytes.");
  const report = new Uint8Array(MSI_REPORT_SIZE);
  report[0] = MSI_MARKER;
  report[1] = command;
  args.forEach((value, index) => {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new RangeError("Invalid MSI argument byte.");
    report[2 + index] = value;
  });
  return report;
}

/** Wraps `commands` in the open/close reports MSI Center sends around them. */
export function msiEncodeBlock(block: MsiBlock, commands: readonly Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer>[] {
  return [
    msiEncodeCommand(MSI_CMD.block, [MSI_BLOCK[block]]),
    ...commands,
    msiEncodeCommand(MSI_CMD.block, BLOCK_END),
  ];
}

export const MSI_DPI_MIN = 100;
/**
 * The preset byte is DPI / 100, so the wire format reaches 25,500. MSI Center
 * stops at 20,000, which is taken as the sensor ceiling.
 */
export const MSI_DPI_MAX = 20000;
export const MSI_DPI_STEP = 100;
/** MSI Center offers 100-19,000 in 100s, then a single 20,000 stop. */
const MSI_DPI_STEPPED_MAX = 19000;
export const MSI_DPI_PRESET_COUNT = 5;

export function msiIsValidDpi(dpi: number): boolean {
  return Number.isInteger(dpi) && dpi >= MSI_DPI_MIN && dpi <= MSI_DPI_MAX && dpi % MSI_DPI_STEP === 0;
}

export function msiDpiOptions(): number[] {
  const options: number[] = [];
  for (let dpi = MSI_DPI_MIN; dpi <= MSI_DPI_STEPPED_MAX; dpi += MSI_DPI_STEP) options.push(dpi);
  options.push(MSI_DPI_MAX);
  return options;
}

/** All five presets in one report, each as DPI / 100, plus a trailing zero. */
export function msiEncodeDpiPresets(presets: readonly number[]): Uint8Array<ArrayBuffer> {
  if (presets.length !== MSI_DPI_PRESET_COUNT) throw new RangeError("MSI mice take exactly five DPI presets.");
  if (!presets.every(msiIsValidDpi)) {
    throw new RangeError(`MSI DPI must be ${MSI_DPI_MIN}–${MSI_DPI_MAX.toLocaleString("en-US")} in steps of ${MSI_DPI_STEP}.`);
  }
  return msiEncodeCommand(MSI_CMD.dpiPresets, [...presets.map((dpi) => dpi / MSI_DPI_STEP), 0]);
}

/** Selects the active preset, 0-based. */
export function msiEncodeDpiPresetSelect(preset: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(preset) || preset < 0 || preset >= MSI_DPI_PRESET_COUNT) {
    throw new RangeError("MSI DPI preset must be 0-4.");
  }
  return msiEncodeCommand(MSI_CMD.dpiPresetSelect, [preset]);
}

export const MSI_POLLING_RATES: readonly number[] = [125, 250, 500, 1000];

/** The argument is the report interval in milliseconds: 01, 02, 04, 08. */
export function msiEncodePollingRate(hz: number): Uint8Array<ArrayBuffer> {
  if (!MSI_POLLING_RATES.includes(hz)) throw new RangeError(`MSI mice cannot poll at ${hz} Hz.`);
  return msiEncodeCommand(MSI_CMD.pollingInterval, [1000 / hz]);
}

export function msiEncodeAngleSnapping(enabled: boolean): Uint8Array<ArrayBuffer> {
  return msiEncodeCommand(MSI_CMD.angleSnapping, [enabled ? 1 : 0]);
}

export function msiEncodeMotionSync(enabled: boolean): Uint8Array<ArrayBuffer> {
  return msiEncodeCommand(MSI_CMD.motionSync, [enabled ? 1 : 0]);
}

/** The GM41 has two lift-off stops: 01 Low, 02 High. */
export type MsiLiftOffDistance = "Low" | "High";

export function msiEncodeLiftOffDistance(value: MsiLiftOffDistance): Uint8Array<ArrayBuffer> {
  return msiEncodeCommand(MSI_CMD.liftOffDistance, [value === "High" ? 2 : 1]);
}

export function msiEncodeAutoLedOff(enabled: boolean): Uint8Array<ArrayBuffer> {
  return msiEncodeCommand(MSI_CMD.autoLedOff, [enabled ? 1 : 0]);
}

export const MSI_LIGHTING_MODE = { off: 0x00, steady: 0x01, breathing: 0x02, rainbow: 0x03, custom: 0x04 } as const;
export type MsiLightingMode = keyof typeof MSI_LIGHTING_MODE;
/** Brightness wire values 01-03; MSI Center's lowest stop still lights the LED. */
export const MSI_BRIGHTNESS_LEVELS: readonly number[] = [1, 2, 3];
/** Effect speed wire values 00-02. */
export const MSI_SPEED_LEVELS: readonly number[] = [0, 1, 2];
/** Constant byte before the RGB triple; identical across every captured colour. */
const LIGHTING_COLOR_PREFIX = 0x12;

export interface MsiLighting {
  mode: MsiLightingMode;
  brightness: number;
  speed: number;
  red: number;
  green: number;
  blue: number;
}

/**
 * The full lighting block exactly as MSI Center sends it: mode, brightness,
 * speed, colour, then brightness again. The colour is sent for every mode.
 */
export function msiEncodeLighting(lighting: MsiLighting): Uint8Array<ArrayBuffer>[] {
  if (!MSI_BRIGHTNESS_LEVELS.includes(lighting.brightness)) throw new RangeError("MSI brightness must be 1-3.");
  if (!MSI_SPEED_LEVELS.includes(lighting.speed)) throw new RangeError("MSI effect speed must be 0-2.");
  const brightness = msiEncodeCommand(MSI_CMD.lightingBrightness, [lighting.brightness]);
  return msiEncodeBlock("lighting", [
    msiEncodeCommand(MSI_CMD.lightingMode, [MSI_LIGHTING_MODE[lighting.mode]]),
    brightness,
    msiEncodeCommand(MSI_CMD.lightingSpeed, [lighting.speed]),
    msiEncodeCommand(MSI_CMD.lightingColor, [LIGHTING_COLOR_PREFIX, lighting.red, lighting.green, lighting.blue]),
    brightness,
  ]);
}

/** Button ids double as the HID button bit for that button. */
export const MSI_BUTTON = { left: 0x01, right: 0x02, middle: 0x04, back: 0x08, forward: 0x10 } as const;
export type MsiButton = keyof typeof MSI_BUTTON;
export const MSI_BUTTON_ORDER: readonly MsiButton[] = ["left", "right", "middle", "back", "forward"];

export const MSI_DPI_ACTION = { cycleUp: 0x01, cycleDown: 0x02, default: 0x03, select: 0x04 } as const;
export type MsiDpiAction = keyof typeof MSI_DPI_ACTION;

/**
 * What a button does. `default` is the 06 group MSI Center writes for the
 * middle and back buttons in their factory state.
 */
export type MsiButtonBinding =
  | { kind: "default" }
  /** `button` is an `MSI_BUTTON` bit, or 0 to disable the button. */
  | { kind: "mouse"; button: number }
  | { kind: "scroll"; direction: "up" | "down" }
  /** HID consumer-page usage, e.g. 0xcd play/pause, 0xe9 volume up. */
  | { kind: "media"; usage: number }
  | { kind: "macro"; slot: number }
  /** `stage` is the 0-based preset for `select` and ignored otherwise. */
  | { kind: "dpi"; action: MsiDpiAction; stage?: number };

export const MSI_MACRO_SLOTS = 30;

/** `0d 41 <button> 00 <group> <a> <b> <c>` */
export function msiEncodeButtonBinding(button: MsiButton, binding: MsiButtonBinding): Uint8Array<ArrayBuffer> {
  const encode = (group: number, a: number, b: number, c = 0x00) =>
    msiEncodeCommand(MSI_CMD.buttonBinding, [MSI_BUTTON[button], 0x00, group, a, b, c]);
  switch (binding.kind) {
    case "default":
      return encode(0x06, 0x00, 0x00);
    case "mouse":
      return encode(0x07, 0x00, binding.button);
    case "scroll":
      return encode(0x08, 0x00, binding.direction === "up" ? 0x01 : 0xff);
    case "media":
      return encode(0x0a, 0x00, binding.usage);
    case "macro":
      if (!Number.isInteger(binding.slot) || binding.slot < 1 || binding.slot > MSI_MACRO_SLOTS) {
        throw new RangeError(`MSI macro slot must be 1-${MSI_MACRO_SLOTS}.`);
      }
      return encode(0x0b, binding.slot, 0x01);
    case "dpi": {
      const stage = binding.action === "select" ? binding.stage ?? 0 : 0;
      if (!Number.isInteger(stage) || stage < 0 || stage >= MSI_DPI_PRESET_COUNT) {
        throw new RangeError("MSI DPI stage must be 0-4.");
      }
      return encode(0x0c, 0x00, MSI_DPI_ACTION[binding.action], stage);
    }
  }
}

/** Every button in one block, in the order MSI Center writes them. */
export function msiEncodeButtonBindings(bindings: Readonly<Record<MsiButton, MsiButtonBinding>>): Uint8Array<ArrayBuffer>[] {
  return msiEncodeBlock("buttons", MSI_BUTTON_ORDER.map((button) => msiEncodeButtonBinding(button, bindings[button])));
}
