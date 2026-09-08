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
  MSI_CONFIG_USAGE,
  MSI_CONFIG_USAGE_PAGE,
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
 * Interface selection is confirmed on hardware. The GM41 surfaces three
 * separate HIDDevices to WebHID; only the vendor collection
 * (usagePage 0xff10, usage 0x06) carries feature reports and accepts writes.
 * The boot-mouse and keyboard/consumer collections are owned by Windows'
 * mouse and keyboard stacks, so writes to them fail with "Failed to write
 * the feature report". `isSupported` matches the vendor collection only, and
 * MSI_HID_FILTERS in src/drivers/vendors.ts pins the picker to it, so the
 * other two are neither offered nor listed.
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
    if (device.vendorId !== MSI_VENDOR_ID || device.productId !== MSI_PRODUCT_ID) return false;
    const hasConfigCollection = (collections: readonly HIDCollectionInfo[]): boolean =>
      collections.some((collection) =>
        (collection.usagePage === MSI_CONFIG_USAGE_PAGE && collection.usage === MSI_CONFIG_USAGE)
        || hasConfigCollection(collection.children));
    return hasConfigCollection(device.collections);
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
      throw new Error("MSI DPI presets must be 100-20,000 in 100 DPI steps.");
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

  /**
   * Generic lighting entry point the control surface dispatches to (see
   * `requireClientMethod("setLighting", ...)` in openmouse's controller).
   * Without this method the app throws "This mouse does not support
   * changing lighting yet" for every lighting change, regardless of the
   * individual setColourMode/setBrightness/etc. methods above existing.
   */
  async setLighting(lighting: MouseLighting): Promise<MouseLighting> {
    const mode = lighting.mode;

    // Off has no brightness or colour control in the UI (see brightnessModes
    // below) — always leave the LED at full brightness so the next effect
    // resumes bright rather than at whatever level was last dialed down
    // before it was turned off.
    if (mode === "Off") {
      await this.setColourMode("Off");
      await this.setBrightness("Max");
      return this.lightingSnapshot();
    }

    if (mode === "Static") {
      if (lighting.color) {
        const [red, green, blue] = this.hexToRgb(lighting.color);
        await this.setCustomColour(red, green, blue);
        await this.setColourMode("Customise");
      } else {
        await this.setColourMode("Steady");
      }
    } else if (mode === "Breathe") {
      if (lighting.color) {
        const [red, green, blue] = this.hexToRgb(lighting.color);
        await this.setCustomColour(red, green, blue);
      }
      await this.setColourMode("Breath");
    } else if (mode === "Rainbow") {
      await this.setColourMode("Rainbow");
    } else throw new Error(`Unsupported MSI lighting mode: ${mode}.`);

    if (lighting.brightness != null) {
      const level: MsiLevel = lighting.brightness >= 100 ? "Max" : lighting.brightness >= 50 ? "Half" : "None";
      await this.setBrightness(level);
    }
    if (mode !== "Static" && lighting.speed != null) {
      const level: MsiLevel = lighting.speed >= 2 ? "Max" : lighting.speed >= 1 ? "Half" : "None";
      await this.setSpeed(level);
    }
    return this.lightingSnapshot();
  }

  private hexToRgb(value: string): [number, number, number] {
    if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error("Lighting colour must be a six-digit hex colour.");
    const [red, green, blue] = [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
    return [red ?? 0, green ?? 0, blue ?? 0];
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
      Breath: "Breathe",
      Rainbow: "Rainbow",
    };
    const speedMap: Record<MsiLevel, number> = { None: 0, Half: 1, Max: 2 };
    const brightnessMap: Record<MsiLevel, number> = { None: 0, Half: 50, Max: 100 };
    const [red, green, blue] = this.customColour;
    const hex = (value: number): string => value.toString(16).padStart(2, "0");
    return {
      zone: "Logo",
      modes: ["Off", "Static", "Breathe", "Rainbow"],
      mode: modeMap[this.colourMode],
      color: `#${hex(red)}${hex(green)}${hex(blue)}`,
      color2: null,
      colorModes: ["Static", "Breathe"],
      dualColorModes: [],
      reactiveModes: ["Breathe", "Rainbow"],
      speeds: [0, 1, 2],
      speed: speedMap[this.speed],
      brightness: brightnessMap[this.brightness],
      brightnessLevels: [0, 50, 100],
      // Off has no LED to dim — setLighting always pins brightness to Max
      // for it instead of taking a value from the UI. This list (not
      // brightnessLevels, a fixed array the UI's optimistic preview cannot
      // recompute mid-edit) is what hides the picker for that one mode.
      brightnessModes: ["Static", "Breathe", "Rainbow"],
      // No read-back exists yet (see docs/msi-testing.md) — this reflects
      // the driver's own last write, not a value confirmed on the mouse.
      writeOnly: true,
    };
  }
}