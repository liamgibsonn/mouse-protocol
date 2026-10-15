import assert from "node:assert/strict";
import test from "node:test";
import { MsiHidClient } from "./hid.ts";
import {
  MSI_CLUTCH_GM41_PRODUCT_ID,
  MSI_CONFIG_USAGE,
  MSI_CONFIG_USAGE_PAGE,
  MSI_VENDOR_ID,
  msiDpiOptions,
  msiEncodeAngleSnapping,
  msiEncodeAutoLedOff,
  msiEncodeButtonBinding,
  msiEncodeButtonBindings,
  msiEncodeCommand,
  msiEncodeDpiPresets,
  msiEncodeDpiPresetSelect,
  msiEncodeLiftOffDistance,
  msiEncodeLighting,
  msiEncodeMotionSync,
  msiEncodePollingRate,
} from "../../msi/index.ts";

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");

function device(collections: HIDCollectionInfo[] = [configCollection()], vendorId = MSI_VENDOR_ID) {
  const writes: string[] = [];
  const hid = {
    vendorId,
    productId: MSI_CLUTCH_GM41_PRODUCT_ID,
    opened: false,
    collections,
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    async sendFeatureReport(reportId: number, data: BufferSource) {
      assert.equal(reportId, 0);
      writes.push(hex(new Uint8Array(data as ArrayBuffer)));
    },
  };
  return { hid: hid as unknown as HIDDevice, writes };
}

function configCollection(): HIDCollectionInfo {
  return {
    usagePage: MSI_CONFIG_USAGE_PAGE, usage: MSI_CONFIG_USAGE, children: [],
    featureReports: [{ reportId: 0, items: [] }], inputReports: [], outputReports: [],
  } as HIDCollectionInfo;
}

// Every frame below is copied from a USBPcap capture of MSI Center.
test("encodes performance, DPI, and power reports as captured", () => {
  assert.equal(hex(msiEncodeDpiPresets([500, 1000, 1600, 3200, 6400])), "0d 15 05 0a 10 20 40 00");
  assert.equal(hex(msiEncodeDpiPresetSelect(3)), "0d 16 03 00 00 00 00 00");
  assert.equal(hex(msiEncodePollingRate(500)), "0d 11 02 00 00 00 00 00");
  assert.equal(hex(msiEncodePollingRate(250)), "0d 11 04 00 00 00 00 00");
  assert.equal(hex(msiEncodePollingRate(125)), "0d 11 08 00 00 00 00 00");
  assert.equal(hex(msiEncodeLiftOffDistance("High")), "0d 14 02 00 00 00 00 00");
  assert.equal(hex(msiEncodeLiftOffDistance("Low")), "0d 14 01 00 00 00 00 00");
  assert.equal(hex(msiEncodeAngleSnapping(true)), "0d 12 01 00 00 00 00 00");
  assert.equal(hex(msiEncodeMotionSync(true)), "0d 1a 01 00 00 00 00 00");
  assert.equal(hex(msiEncodeAutoLedOff(false)), "0d 32 00 00 00 00 00 00");
});

test("1000 Hz is a 1 ms interval", () => {
  assert.equal(hex(msiEncodePollingRate(1000)), "0d 11 01 00 00 00 00 00");
  assert.throws(() => msiEncodePollingRate(2000), RangeError);
});

test("rejects out-of-range values", () => {
  assert.throws(() => msiEncodeCommand(0x41, [1, 2, 3, 4, 5, 6, 7]), RangeError);
  assert.throws(() => msiEncodeDpiPresets([100, 200, 300, 400]), RangeError);
  assert.throws(() => msiEncodeDpiPresets([100, 200, 300, 400, 20100]), RangeError);
  assert.throws(() => msiEncodeDpiPresets([100, 200, 300, 400, 450]), RangeError);
  assert.throws(() => msiEncodeDpiPresetSelect(5), RangeError);
  assert.throws(() => msiEncodeButtonBinding("forward", { kind: "macro", slot: 31 }), RangeError);
});

test("offers 100-19,000 in steps of 100, then 20,000", () => {
  const options = msiDpiOptions();
  assert.equal(options[0], 100);
  assert.equal(options.at(-2), 19000);
  assert.equal(options.at(-1), 20000);
  assert.equal(options.length, 191);
});

test("encodes a lighting block as captured", () => {
  // temp.pcapng: steady red at full brightness.
  assert.deepEqual(msiEncodeLighting({ mode: "steady", brightness: 3, speed: 0, red: 0xff, green: 0, blue: 0 }).map(hex), [
    "0d 02 02 00 00 00 00 00",
    "0d 33 01 00 00 00 00 00",
    "0d 34 03 00 00 00 00 00",
    "0d 36 00 00 00 00 00 00",
    "0d 37 12 ff 00 00 00 00",
    "0d 34 03 00 00 00 00 00",
    "0d 02 e8 03 00 00 00 00",
  ]);
});

test("encodes button bindings as captured", () => {
  const forward = (binding: Parameters<typeof msiEncodeButtonBinding>[1]) => hex(msiEncodeButtonBinding("forward", binding));
  assert.equal(forward({ kind: "mouse", button: 0x08 }), "0d 41 10 00 07 00 08 00");
  assert.equal(forward({ kind: "mouse", button: 0 }), "0d 41 10 00 07 00 00 00");
  assert.equal(forward({ kind: "scroll", direction: "down" }), "0d 41 10 00 08 00 ff 00");
  assert.equal(forward({ kind: "media", usage: 0xcd }), "0d 41 10 00 0a 00 cd 00");
  assert.equal(forward({ kind: "macro", slot: 30 }), "0d 41 10 00 0b 1e 01 00");
  assert.equal(forward({ kind: "dpi", action: "default" }), "0d 41 10 00 0c 00 03 00");
  assert.equal(forward({ kind: "dpi", action: "select", stage: 2 }), "0d 41 10 00 0c 00 04 02");
});

test("writes every button inside one block", () => {
  // MB4 Multimedia.pcapng: forward bound to play/pause, the rest at defaults.
  const reports = msiEncodeButtonBindings({
    left: { kind: "mouse", button: 0x01 },
    right: { kind: "mouse", button: 0x02 },
    middle: { kind: "default" },
    back: { kind: "default" },
    forward: { kind: "media", usage: 0xcd },
  });
  assert.deepEqual(reports.map(hex), [
    "0d 02 09 00 00 00 00 00",
    "0d 41 01 00 07 00 01 00",
    "0d 41 02 00 07 00 02 00",
    "0d 41 04 00 06 00 00 00",
    "0d 41 08 00 06 00 00 00",
    "0d 41 10 00 0a 00 cd 00",
    "0d 02 e8 03 00 00 00 00",
  ]);
});

test("claims only the vendor config collection", () => {
  const bootMouse = {
    usagePage: 0x01, usage: 0x02, children: [],
    featureReports: [], inputReports: [{ reportId: 1, items: [] }], outputReports: [],
  } as unknown as HIDCollectionInfo;
  assert.equal(MsiHidClient.isSupported(device().hid), true);
  assert.equal(MsiHidClient.isSupported(device([bootMouse]).hid), false);
  assert.equal(MsiHidClient.isSupported(device([configCollection()], 0x1234).hid), false);
});

test("DPI writes keep the other presets and report the cached value", async () => {
  const { hid, writes } = device();
  const client = new MsiHidClient(hid);
  await client.setDpiStageValue(4, 12000);
  await client.setActiveDpiStage(4);
  assert.deepEqual(writes, ["0d 15 05 0a 10 20 78 00", "0d 16 04 00 00 00 00 00"]);
  const status = await client.readStatus();
  assert.equal(status.dpi, 12000);
  assert.equal(status.activeDpiStage, 4);
  await assert.rejects(client.setDpi(150), RangeError);
});

test("lighting maps the shared modes and remembers the last write", async () => {
  const { hid, writes } = device();
  const client = new MsiHidClient(hid);
  const lighting = (await client.readStatus()).lighting!;
  const result = await client.setLighting({ ...lighting, mode: "Breathing single", color: "#00FF00", brightness: 67, speed: 2 });
  assert.equal(writes.length, 6 * 40 + 1, "each report but the close is resent, as MSI Center does");
  assert.deepEqual(writes.filter((report, index) => report !== writes[index - 1]), [
    "0d 02 02 00 00 00 00 00",
    "0d 33 02 00 00 00 00 00",
    "0d 34 02 00 00 00 00 00",
    "0d 36 02 00 00 00 00 00",
    "0d 37 12 00 ff 00 00 00",
    "0d 34 02 00 00 00 00 00",
    "0d 02 e8 03 00 00 00 00",
  ]);
  assert.equal(result.mode, "Breathing single");
  assert.equal(result.color, "#00ff00");
  await assert.rejects(client.setLighting({ ...lighting, mode: "Wave" }), RangeError);
});

test("rejects the Medium lift-off stop the GM41 does not have", async () => {
  const { hid, writes } = device();
  await assert.rejects(new MsiHidClient(hid).setLiftOffDistance("Medium"), RangeError);
  assert.deepEqual(writes, []);
});
