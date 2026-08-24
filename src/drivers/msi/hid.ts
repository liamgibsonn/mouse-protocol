import type { MouseLighting, MouseLightingMode, MouseStatus } from "../mouse-types.ts";
import {
  encodeMsiAngleSnapping,
  encodeMsiAutoLedOff,
  encodeMsiBrightness,
  encodeMsiColourMode,
  encodeMsiCustomRgb,
  encodeMsiDpiPresetSelect,
  encodeMsiDpiPresetWrite,
  encodeMsiLiftOffDistance,
  encodeMsiMotionSync,
  encodeMsiPollingRate,
  encodeMsiSpeed,
  isValidMsiDpiPreset,
  msiDpiOptions,
  MSI_PRODUCT_ID,
  MSI_SUPPORTED_POLLING_RATES,
  MSI_VENDOR_ID,
  type MsiColourMode,
  type MsiLevel,
  type MsiLiftOffDistance,
} from "@openmouse/protocol/msi";

/**
 * MSI Clutch GM41 vendor HID control.
 *
 * Transport: MSI's config interface (Windows MI_01, "Vendor Defined") is
 * driven by 8-byte Feature reports at report id 0 — see src/msi/index.ts for
 * the wire format.
 *
 * IMPORTANT — unverified: `isSupported` currently matches on vendor/product
 * id only. MSI's mouse exposes three USB interfaces (MI_00 Generic Desktop,
 * MI_01 Vendor Defined, MI_02 Consumer Control/Keyboard), and WebHID may
 * surface each as a separate HIDDevice. Which one(s) actually carry the
 * config usage page/usage has not been confirmed on hardware yet — do that
 * before merging by logging `device.collections` for every device WebHID
 * grants (e.g. in the browser console after connecting through the
 * OpenMouse picker) and narrowing `isSupported` the way moddo's driver does
 * (see src/drivers/moddo/hid.ts), then add a matching usagePage/usage entry
 * to MSI_HID_FILTERS in src/drivers/vendors.ts.
 *
 * There is no confirmed read-back report for any setting (see
 * docs/msi-testing.md), so unlike moddoMOUSE this driver cannot read the
 * mouse's actual state — every setter sends its write and trusts it took
 * effect rather than confirming against a re-read. `ui.valuesVerified` is
 * left false throughout to reflect that honestly.
 */
export class MsiHidClient {
  readonly device: HIDDevice;

  // No read command exists yet, so the driver tracks what it has written
  // itself, starting from sensible defaults. This is the only source of
  // truth this driver has for its own status — a fresh device (or one
  // changed by MSI's own software) will not match, until a real status
  // report is found and this cache is replaced with an actual read.
  private dpiPresets: number[] = [800, 1600, 2400, 3200, 4000];
  private activePreset = 1;
  private pollingRateHz = 1000;
  private liftOff: MsiLiftOffDistance = "Low";
  private motionSync = false;
  private angleSnapping = false;
  private colourMode: MsiColourMode = "Steady";
  private brightness: MsiLevel = "Max";
  private speed: MsiLevel = "None";
  private customColour: [number, number, number] = [255, 255, 255];

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === MSI_VENDOR_ID && device.productId === MSI_PRODUCT_ID;
  }

  get supportedPollingRates(): number[] {
    return [...MSI_SUPPORTED_POLLING_RATES];
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
        valuesVerified: false, // every value below is cached from writes, never read from hardware
        hideLodLow: false,
        hideUnsupportedPollingRates: true,
        defaultDisplayName: "MSI Clutch GM41",
      },
      batteryPercent: null, // battery report format not yet confirmed — see docs/msi-testing.md
      batteryState: "Unknown",
      dpi: this.dpiPresets[this.activePreset] ?? 800,
      pollingRateHz: this.pollingRateHz,
      supportedPollingRates: this.supportedPollingRates,
      activeProfile: null,
      dpiStages: [...this.dpiPresets],
      activeDpiStage: this.activePreset,
      connectionType: "Wireless",
      connectionDetail: "2.4 GHz receiver",
      motionSync: this.motionSync,
      angleSnapping: this.angleSnapping,
      liftOffDistance: this.liftOff,
      supportedLiftOffDistances: ["Low", "High"],
      lighting: this.lightingSnapshot(),
      firmware: ["MSI Clutch GM41"],
    };
  }

  // ---------------------------------------------------------------------
  // DPI
  // ---------------------------------------------------------------------

  getDpiOptions(): number[] {
    return msiDpiOptions();
  }

  /** Writes the given DPI to the currently active preset slot, then selects it. */
  async setDpi(dpi: number): Promise<number> {
    if (!isValidMsiDpiPreset(dpi)) {
      throw new Error("MSI DPI presets must be 100-25,500 in 100 DPI steps.");
    }
    const presets = [...this.dpiPresets] as [number, number, number, number, number];
    presets[this.activePreset] = dpi;
    await this.open();
    await this.device.sendFeatureReport(0, encodeMsiDpiPresetWrite(presets));
    this.dpiPresets = presets;
    return dpi;
  }

  /** Selects one of the five preset slots (0-indexed) as the active DPI stage. */
  async setActiveDpiStage(slot: number): Promise<number> {
    if (!Number.isInteger(slot) || slot < 0 || slot > 4) {
      throw new Error("MSI has 5 DPI preset slots (0-4).");
    }
    await this.open();
    await this.device.sendFeatureReport(0, encodeMsiDpiPresetSelect(slot as 0 | 1 | 2 | 3 | 4));
    this.activePreset = slot;
    return this.dpiPresets[slot] ?? 800;
  }

  // ---------------------------------------------------------------------
  // Polling rate
  // ---------------------------------------------------------------------

  async setPollingRate(rate: number): Promise<number> {
    if (!(MSI_SUPPORTED_POLLING_RATES as readonly number[]).includes(rate)) {
      throw new Error("MSI supports 125, 250, 500, or 1000 Hz polling rate.");
    }
    await this.open();
    const report = encodeMsiPollingRate(rate);
    if (report) await this.device.sendFeatureReport(0, report); // 1000 Hz has no override to send
    this.pollingRateHz = rate;
    return rate;
  }

  // ---------------------------------------------------------------------
  // Performance
  // ---------------------------------------------------------------------

  /**
   * The GM41 has two lift-off stops, but the shared control surface offers
   * three, so accept the wider type and reject the stop this mouse lacks.
   * `supportedLiftOffDistances` in `readStatus` keeps the UI from offering it.
   */
  async setLiftOffDistance(value: NonNullable<MouseStatus["liftOffDistance"]>): Promise<void> {
    if (value !== "Low" && value !== "High") {
      throw new Error("MSI Clutch GM41 lift-off distance must be Low or High.");
    }
    await this.open();
    await this.device.sendFeatureReport(0, encodeMsiLiftOffDistance(value));
    this.liftOff = value;
  }

  async setMotionSync(enabled: boolean): Promise<void> {
    await this.open();
    await this.device.sendFeatureReport(0, encodeMsiMotionSync(enabled));
    this.motionSync = enabled;
  }

  async setAngleSnapping(enabled: boolean): Promise<void> {
    await this.open();
    await this.device.sendFeatureReport(0, encodeMsiAngleSnapping(enabled));
    this.angleSnapping = enabled;
  }

  // ---------------------------------------------------------------------
  // Power
  // ---------------------------------------------------------------------

  // MouseStatus has no field for this setting yet (no other driver exposes
  // an auto-LED-off toggle), so unlike the setters above this one has
  // nothing to cache — it only sends the write.
  async setAutoLedOff(enabled: boolean): Promise<void> {
    await this.open();
    await this.device.sendFeatureReport(0, encodeMsiAutoLedOff(enabled));
  }

  // ---------------------------------------------------------------------
  // RGB / colour
  // ---------------------------------------------------------------------

  async setColourMode(mode: MsiColourMode): Promise<void> {
    await this.open();
    await this.device.sendFeatureReport(0, encodeMsiColourMode(mode));
    this.colourMode = mode;
  }

  async setBrightness(level: MsiLevel): Promise<void> {
    await this.open();
    await this.device.sendFeatureReport(0, encodeMsiBrightness(level));
    this.brightness = level;
  }

  async setSpeed(level: MsiLevel): Promise<void> {
    await this.open();
    await this.device.sendFeatureReport(0, encodeMsiSpeed(level));
    this.speed = level;
  }

  async setCustomColour(red: number, green: number, blue: number): Promise<void> {
    await this.open();
    await this.device.sendFeatureReport(0, encodeMsiCustomRgb(red, green, blue));
    this.customColour = [red, green, blue];
  }

  // ---------------------------------------------------------------------
  // Lighting snapshot (cached — see the class-level note on why there is no
  // read path yet)
  // ---------------------------------------------------------------------

  private lightingSnapshot(): MouseLighting {
    const modeMap: Record<MsiColourMode, MouseLightingMode> = {
      Off: "Off",
      Steady: "Static",
      Customise: "Static",
      Breath: "Breathing single",
      Rainbow: "Cycling",
    };
    const speedMap: Record<MsiLevel, number> = { None: 0, Half: 1, Max: 2 };
    const brightnessMap: Record<MsiLevel, number> = { None: 0, Half: 50, Max: 100 };
    const [red, green, blue] = this.customColour;
    const hex = (value: number): string => value.toString(16).padStart(2, "0");
    return {
      zone: "Logo",
      modes: ["Off", "Static", "Breathing single", "Cycling"],
      mode: modeMap[this.colourMode],
      color: `#${hex(red)}${hex(green)}${hex(blue)}`,
      color2: null,
      colorModes: ["Static"],
      dualColorModes: [],
      reactiveModes: [],
      speeds: [0, 1, 2],
      speed: speedMap[this.speed],
      brightness: brightnessMap[this.brightness],
      brightnessLevels: [0, 50, 100],
      // No read-back exists yet (see docs/msi-testing.md) — this reflects
      // the driver's own last write, not a value confirmed on the mouse.
      writeOnly: true,
    };
  }
}
