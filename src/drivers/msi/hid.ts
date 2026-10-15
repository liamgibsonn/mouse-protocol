import type { MouseLighting, MouseLightingMode, MouseStatus } from "../mouse-types.ts";
import {
  MSI_CLUTCH_GM41_PRODUCT_ID,
  MSI_CONFIG_USAGE,
  MSI_CONFIG_USAGE_PAGE,
  MSI_DPI_MAX,
  MSI_DPI_MIN,
  MSI_DPI_PRESET_COUNT,
  MSI_DPI_STEP,
  MSI_POLLING_RATES,
  MSI_REPORT_ID,
  MSI_VENDOR_ID,
  msiDpiOptions,
  msiEncodeAngleSnapping,
  msiEncodeDpiPresets,
  msiEncodeDpiPresetSelect,
  msiEncodeLiftOffDistance,
  msiEncodeLighting,
  msiEncodeMotionSync,
  msiEncodePollingRate,
  msiIsValidDpi,
  type MsiLightingMode,
} from "../../msi/index.ts";

const LIGHTING_MODES: Readonly<Partial<Record<MouseLightingMode, MsiLightingMode>>> = {
  Off: "off",
  Static: "steady",
  "Breathing single": "breathing",
  Spectrum: "rainbow",
};
/** MSI Center's three brightness stops (wire 01-03) as percentages. */
const BRIGHTNESS_PERCENT = [33, 67, 100];
/**
 * MSI Center resends each lighting report every ~3 ms for up to ~320 ms (mode
 * 5-100 times, brightness and speed always 100), so the mouse appears to drop
 * lighting reports while it applies the previous one. Resend each one for
 * ~150 ms before moving on; repeating a value is harmless.
 */
const LIGHTING_SENDS = 40;
const LIGHTING_SEND_GAP_MS = 4;
/** Starting presets until the first write; the mouse cannot report its own. */
const DEFAULT_DPI_PRESETS = [500, 1000, 1600, 3200, 6400];

function hasConfigCollection(collections: readonly HIDCollectionInfo[]): boolean {
  return collections.some((collection) =>
    (collection.usagePage === MSI_CONFIG_USAGE_PAGE && collection.usage === MSI_CONFIG_USAGE)
    || hasConfigCollection(collection.children));
}

/**
 * MSI Clutch GM41 over its vendor feature report (see `@openmouse/protocol/msi`).
 *
 * The mouse has no known read command, so every value in `readStatus` is the
 * driver's own last write, starting from defaults. A mouse changed by MSI
 * Center, or a fresh page load, will not match until each setting is written.
 */
export class MsiHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private dpiPresets = [...DEFAULT_DPI_PRESETS];
  private activePreset = 1;
  private pollingRateHz = 1000;
  private liftOffDistance: "Low" | "High" = "Low";
  private motionSync = false;
  private angleSnapping = false;
  private lighting: MouseLighting = {
    zone: "Mouse",
    modes: Object.keys(LIGHTING_MODES) as MouseLightingMode[],
    mode: null,
    color: null,
    color2: null,
    colorModes: ["Static", "Breathing single"],
    dualColorModes: [],
    reactiveModes: ["Breathing single", "Spectrum"],
    speeds: [0, 1, 2],
    speed: null,
    brightness: null,
    brightnessLevels: BRIGHTNESS_PERCENT,
    writeOnly: true,
  };

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === MSI_VENDOR_ID
      && device.productId === MSI_CLUTCH_GM41_PRODUCT_ID
      && hasConfigCollection(device.collections);
  }

  getDpiOptions(): number[] {
    return msiDpiOptions();
  }

  getSupportedPollingRates(): number[] {
    return [...MSI_POLLING_RATES];
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    return {
      brand: "MSI",
      name: "MSI Clutch GM41",
      ui: {
        family: "msi",
        settingsReady: true,
        valuesVerified: false,
        hideUnsupportedPollingRates: true,
        defaultDisplayName: "MSI Clutch GM41",
        statusNote: "The GM41 cannot report its settings, so these show the last values OpenMouse wrote.",
      },
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: this.dpiPresets[this.activePreset]!,
      dpiStages: [...this.dpiPresets],
      activeDpiStage: this.activePreset,
      pollingRateHz: this.pollingRateHz,
      supportedPollingRates: this.getSupportedPollingRates(),
      activeProfile: null,
      connectionType: "Wired",
      connectionDetail: "USB",
      liftOffDistance: this.liftOffDistance,
      supportedLiftOffDistances: ["Low", "High"],
      motionSync: this.motionSync,
      angleSnapping: this.angleSnapping,
      lighting: { ...this.lighting },
      firmware: [],
    };
  }

  async setDpi(dpi: number): Promise<number> {
    return this.setDpiStageValue(this.activePreset, dpi);
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    if (!msiIsValidDpi(dpi)) {
      throw new RangeError(`MSI DPI must be ${MSI_DPI_MIN}–${MSI_DPI_MAX.toLocaleString("en-US")} in steps of ${MSI_DPI_STEP}.`);
    }
    if (!Number.isInteger(stage) || stage < 0 || stage >= MSI_DPI_PRESET_COUNT) {
      throw new RangeError(`DPI stage must be between 1 and ${MSI_DPI_PRESET_COUNT}.`);
    }
    const presets = [...this.dpiPresets];
    presets[stage] = dpi;
    await this.send(msiEncodeDpiPresets(presets));
    this.dpiPresets = presets;
    return dpi;
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    await this.send(msiEncodeDpiPresetSelect(stage));
    this.activePreset = stage;
    return stage;
  }

  async setPollingRate(rate: number): Promise<number> {
    await this.send(msiEncodePollingRate(rate));
    this.pollingRateHz = rate;
    return rate;
  }

  async setLiftOffDistance(value: NonNullable<MouseStatus["liftOffDistance"]>): Promise<"Low" | "High"> {
    if (value !== "Low" && value !== "High") throw new RangeError("The MSI Clutch GM41 supports Low or High lift-off distance.");
    await this.send(msiEncodeLiftOffDistance(value));
    this.liftOffDistance = value;
    return value;
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    await this.send(msiEncodeMotionSync(enabled));
    this.motionSync = enabled;
    return enabled;
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    await this.send(msiEncodeAngleSnapping(enabled));
    this.angleSnapping = enabled;
    return enabled;
  }

  async setLighting(lighting: MouseLighting): Promise<MouseLighting> {
    const mode = lighting.mode ? LIGHTING_MODES[lighting.mode] : undefined;
    if (!mode) throw new RangeError(`The MSI Clutch GM41 does not support ${lighting.mode ?? "that"} lighting.`);
    const color = lighting.color ?? this.lighting.color ?? "#ffffff";
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new RangeError("Lighting colour must be a six-digit hex colour.");
    const brightness = nearestIndex(BRIGHTNESS_PERCENT, lighting.brightness ?? this.lighting.brightness ?? 100);
    const speed = Math.min(2, Math.max(0, Math.round(lighting.speed ?? this.lighting.speed ?? 1)));
    const [red, green, blue] = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
    const reports = msiEncodeLighting({ mode, brightness: brightness + 1, speed, red: red!, green: green!, blue: blue! });
    const close = reports.pop()!;
    await this.send(...reports.flatMap((report) => Array<Uint8Array<ArrayBuffer>>(LIGHTING_SENDS).fill(report)), close);
    this.lighting = { ...this.lighting, mode: lighting.mode, color: color.toLowerCase(), speed, brightness: BRIGHTNESS_PERCENT[brightness]! };
    return { ...this.lighting };
  }

  /** Sends `reports` in order, so a lighting block is never interleaved with another write. */
  private send(...reports: Uint8Array<ArrayBuffer>[]): Promise<void> {
    const run = this.queue.then(async () => {
      await this.open();
      for (const [index, report] of reports.entries()) {
        if (index > 0) await new Promise<void>((resolve) => setTimeout(resolve, LIGHTING_SEND_GAP_MS));
        await this.device.sendFeatureReport(MSI_REPORT_ID, report);
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function nearestIndex(values: readonly number[], target: number): number {
  let best = 0;
  values.forEach((value, index) => {
    if (Math.abs(value - target) < Math.abs(values[best]! - target)) best = index;
  });
  return best;
}
