import assert from "node:assert/strict";
import test from "node:test";

import { MsiHidClient } from "./hid.ts";
import { MSI_CONFIG_USAGE, MSI_CONFIG_USAGE_PAGE, MSI_PRODUCT_ID, MSI_VENDOR_ID } from "@openmouse/protocol/msi";

/** A fake GM41 vendor-config collection. Feature-report writes are recorded, not answered — this driver has no confirmed read-back. */
function device(collections: readonly HIDCollectionInfo[]): HIDDevice {
  const sent: Uint8Array[] = [];
  return {
    vendorId: MSI_VENDOR_ID,
    productId: MSI_PRODUCT_ID,
    collections,
    opened: false,
    open: async function (this: { opened: boolean }) { this.opened = true; },
    sendFeatureReport: async (_reportId: number, data: BufferSource) => {
      sent.push(new Uint8Array(data as ArrayBuffer));
    },
    sent,
  } as unknown as HIDDevice & { sent: Uint8Array[] };
}

const configCollection: HIDCollectionInfo = {
  usagePage: MSI_CONFIG_USAGE_PAGE,
  usage: MSI_CONFIG_USAGE,
  children: [],
  featureReports: [{ reportId: 0, items: [] }],
  inputReports: [],
  outputReports: [],
};

const bootMouseCollection: HIDCollectionInfo = {
  usagePage: 0x01,
  usage: 0x02,
  children: [],
  featureReports: [],
  inputReports: [{ reportId: 1, items: [] }],
  outputReports: [],
};

test("isSupported requires the vendor config collection, not just the product id", () => {
  // Arrange
  const configOnly = device([configCollection]);
  const bootMouseOnly = device([bootMouseCollection]);
  const wrongVendor = { ...device([configCollection]), vendorId: 0x1234 } as HIDDevice;

  // Act / Assert
  assert.equal(MsiHidClient.isSupported(configOnly), true);
  assert.equal(MsiHidClient.isSupported(bootMouseOnly), false);
  assert.equal(MsiHidClient.isSupported(wrongVendor), false);
});

test("isSupported finds the config collection nested under a parent collection", () => {
  // Arrange — some devices report the vendor usage as a child of a top-level collection
  const nested = device([{ ...bootMouseCollection, children: [configCollection] }]);

  // Act / Assert
  assert.equal(MsiHidClient.isSupported(nested), true);
});

test("setLighting writes colour mode and custom RGB for a Static colour, and reflects it back", async () => {
  // Arrange
  const hid = device([configCollection]) as HIDDevice & { sent: Uint8Array[] };
  const client = new MsiHidClient(hid);
  const status = await client.readStatus();

  // Act
  const result = await client.setLighting({ ...status.lighting!, mode: "Static", color: "#00ff80" });

  // Assert — one report for the custom RGB write, one for the colour-mode write
  assert.deepEqual([...hid.sent[0]!], [0x0d, 0x37, 0x12, 0x00, 0xff, 0x80, 0x00, 0x00]);
  assert.deepEqual([...hid.sent[1]!], [0x0d, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(result.mode, "Static");
  assert.equal(result.color, "#00ff80");
});

test("setLighting Off always pins brightness to Max, ignoring whatever was staged", async () => {
  // Arrange
  const hid = device([configCollection]) as HIDDevice & { sent: Uint8Array[] };
  const client = new MsiHidClient(hid);
  const status = await client.readStatus();

  // Act — a stale low brightness in the staged object must not reach the mouse
  const result = await client.setLighting({ ...status.lighting!, mode: "Off", brightness: 0 });

  // Assert
  assert.deepEqual([...hid.sent[0]!], [0x0d, 0x33, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.deepEqual([...hid.sent[1]!], [0x0d, 0x34, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00]); // brightness Max
  assert.equal(hid.sent.length, 2);
  assert.equal(result.mode, "Off");
  assert.equal(result.brightness, 100);
});

test("Off excludes itself from brightnessModes; every other mode includes it", async () => {
  // brightnessLevels itself must stay a fixed array — the openmouse control
  // surface's optimistic preview merges only {mode, color, color2, speed,
  // brightness} onto the previous lighting object when a change is staged,
  // so any field that varies by mode (like brightnessLevels used to) shows
  // stale data until the write actually reaches the mouse and is read back.
  // brightnessModes is a static list precisely so the UI's own
  // `brightnessModes.includes(mode)` check reacts the instant `mode` changes.
  // Arrange
  const hid = device([configCollection]);
  const client = new MsiHidClient(hid);
  const status = await client.readStatus();

  // Act
  const off = await client.setLighting({ ...status.lighting!, mode: "Off" });
  const onAgain = await client.setLighting({ ...status.lighting!, mode: "Static", color: "#112233" });

  // Assert
  assert.deepEqual(off.brightnessLevels, [0, 50, 100]);
  assert.equal(off.brightnessModes?.includes("Off"), false);
  assert.equal(onAgain.brightnessModes?.includes("Static"), true);
});

test("setLighting writes custom RGB before the Breathe colour mode, and Breathe/Rainbow both offer a speed control", async () => {
  // Arrange
  const hid = device([configCollection]) as HIDDevice & { sent: Uint8Array[] };
  const client = new MsiHidClient(hid);
  const status = await client.readStatus();

  // Act
  const breathing = await client.setLighting({ ...status.lighting!, mode: "Breathe", color: "#ff8800" });

  // Assert — custom RGB write, then colour mode Breath (0x02), distinct from Rainbow's byte (0x03)
  assert.deepEqual([...hid.sent[0]!], [0x0d, 0x37, 0x12, 0xff, 0x88, 0x00, 0x00, 0x00]);
  assert.deepEqual([...hid.sent[1]!], [0x0d, 0x33, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(breathing.mode, "Breathe");
  assert.equal(breathing.color, "#ff8800");
  assert.ok(breathing.colorModes.includes("Breathe"));
  assert.ok(breathing.reactiveModes.includes("Breathe"));
  assert.ok(breathing.reactiveModes.includes("Rainbow"));

  hid.sent.length = 0;
  const rainbow = await client.setLighting({ ...status.lighting!, mode: "Rainbow" });
  assert.deepEqual([...hid.sent[0]!], [0x0d, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(rainbow.mode, "Rainbow");
});

test("setLighting rejects a mode the GM41 does not support", async () => {
  // Arrange
  const hid = device([configCollection]);
  const client = new MsiHidClient(hid);
  const status = await client.readStatus();

  // Act / Assert
  await assert.rejects(() => client.setLighting({ ...status.lighting!, mode: "Wave" }));
});
