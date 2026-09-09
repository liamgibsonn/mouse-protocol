import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMsiReport,
  encodeMsiAngleSnapping,
  encodeMsiAutoLedOff,
  encodeMsiBrightness,
  encodeMsiButtonDpi,
  encodeMsiButtonMacro,
  encodeMsiButtonMouseFunction,
  encodeMsiButtonMultimedia,
  encodeMsiColourMode,
  encodeMsiCustomRgb,
  encodeMsiDpiPresetSelect,
  encodeMsiDpiPresetWrite,
  encodeMsiDpiStage,
  encodeMsiLiftOffDistance,
  encodeMsiMotionSync,
  encodeMsiPollingRate,
  encodeMsiSpeed,
  isValidMsiDpiPreset,
  msiDpiOptions,
  MSI_BUTTON_ID,
  MSI_FRAME_MARKER,
  MSI_REPORT_LENGTH,
} from "@openmouse/protocol/msi";

test("buildMsiReport frames the command and zero-pads the payload to 8 bytes", () => {
  // Act
  const report = buildMsiReport(0x33, [0x01]);

  // Assert
  assert.equal(report.length, MSI_REPORT_LENGTH);
  assert.equal(report[0], MSI_FRAME_MARKER);
  assert.deepEqual([...report], [0x0d, 0x33, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
});

test("buildMsiReport rejects a payload that would overflow the 8-byte report", () => {
  // Act / Assert
  assert.throws(() => buildMsiReport(0x41, [1, 2, 3, 4, 5, 6, 7]));
});

test("DPI stage select matches the captured stage bytes", () => {
  // Assert — 0d 96 [80-84], one per stage (from Notes.txt)
  assert.deepEqual([...encodeMsiDpiStage(1)], [0x0d, 0x96, 0x80, 0, 0, 0, 0, 0]);
  assert.deepEqual([...encodeMsiDpiStage(5)], [0x0d, 0x96, 0x84, 0, 0, 0, 0, 0]);
});

test("DPI preset write matches the captured preset-write report", () => {
  // Arrange — captured: 0d 15 01 02 03 04 05 00 for 100/200/300/400/500 DPI
  const presets: [number, number, number, number, number] = [100, 200, 300, 400, 500];

  // Act
  const report = encodeMsiDpiPresetWrite(presets);

  // Assert
  assert.deepEqual([...report], [0x0d, 0x15, 0x01, 0x02, 0x03, 0x04, 0x05, 0x00]);
});

test("DPI preset validation follows the 100-step range", () => {
  // Act / Assert
  assert.equal(isValidMsiDpiPreset(100), true);
  assert.equal(isValidMsiDpiPreset(20000), true);
  assert.equal(isValidMsiDpiPreset(19500), true); // encodable, though MSI Center does not offer it
  assert.equal(isValidMsiDpiPreset(50), false); // below min
  assert.equal(isValidMsiDpiPreset(150), false); // not a step of 100
  assert.equal(isValidMsiDpiPreset(20100), false); // above max
  assert.throws(() => encodeMsiDpiPresetWrite([150, 200, 300, 400, 500]));
});

test("DPI preset select matches the captured slot-select report", () => {
  // Assert — captured: 0d 16 03 selects the 4th preset (0-indexed slot 3)
  assert.deepEqual([...encodeMsiDpiPresetSelect(3)], [0x0d, 0x16, 0x03, 0, 0, 0, 0, 0]);
});

test("polling rate matches the captured bytes and 1000 Hz sends no override", () => {
  // Assert — captured: 500=02, 250=04, 125=08
  assert.deepEqual([...encodeMsiPollingRate(500)!], [0x0d, 0x11, 0x02, 0, 0, 0, 0, 0]);
  assert.deepEqual([...encodeMsiPollingRate(250)!], [0x0d, 0x11, 0x04, 0, 0, 0, 0, 0]);
  assert.deepEqual([...encodeMsiPollingRate(125)!], [0x0d, 0x11, 0x08, 0, 0, 0, 0, 0]);
  assert.equal(encodeMsiPollingRate(1000), null);
  assert.throws(() => encodeMsiPollingRate(2000));
});

test("performance toggles match the captured on/off bytes", () => {
  // Assert — angle snapping: 0d 12 [00|01]; motion sync: 0d 1a [00|01]
  assert.deepEqual([...encodeMsiAngleSnapping(true)], [0x0d, 0x12, 0x01, 0, 0, 0, 0, 0]);
  assert.deepEqual([...encodeMsiAngleSnapping(false)], [0x0d, 0x12, 0x00, 0, 0, 0, 0, 0]);
  assert.deepEqual([...encodeMsiMotionSync(true)], [0x0d, 0x1a, 0x01, 0, 0, 0, 0, 0]);
  assert.deepEqual([...encodeMsiMotionSync(false)], [0x0d, 0x1a, 0x00, 0, 0, 0, 0, 0]);
});

test("lift-off distance matches the captured High/Low bytes", () => {
  // Assert — captured: 0d 14 [01=Low|02=High]
  assert.deepEqual([...encodeMsiLiftOffDistance("Low")], [0x0d, 0x14, 0x01, 0, 0, 0, 0, 0]);
  assert.deepEqual([...encodeMsiLiftOffDistance("High")], [0x0d, 0x14, 0x02, 0, 0, 0, 0, 0]);
});

test("auto LED off matches the captured power-setting bytes", () => {
  // Assert — captured: 0d 32 [00|01] 00 00 00 00 00
  assert.deepEqual([...encodeMsiAutoLedOff(true)], [0x0d, 0x32, 0x01, 0, 0, 0, 0, 0]);
  assert.deepEqual([...encodeMsiAutoLedOff(false)], [0x0d, 0x32, 0x00, 0, 0, 0, 0, 0]);
});

test("colour mode, brightness, and speed match the captured bytes", () => {
  // Assert — colour mode: 0d 33 [00-04]
  assert.deepEqual([...encodeMsiColourMode("Steady")], [0x0d, 0x33, 0x01, 0, 0, 0, 0, 0]);
  assert.deepEqual([...encodeMsiColourMode("Rainbow")], [0x0d, 0x33, 0x03, 0, 0, 0, 0, 0]);
  // brightness: 0d 34 [01=None|02=Half|03=Max]; speed: 0d 36 [00=None|01=Half|02=Max]
  assert.deepEqual([...encodeMsiBrightness("Max")], [0x0d, 0x34, 0x03, 0, 0, 0, 0, 0]);
  assert.deepEqual([...encodeMsiSpeed("Half")], [0x0d, 0x36, 0x01, 0, 0, 0, 0, 0]);
});

test("custom RGB matches the captured red and green writes", () => {
  // Assert — captured: 0d 37 12 ff 00 00 00 00 (red), 0d 37 12 00 ff 00 00 00 (green)
  assert.deepEqual([...encodeMsiCustomRgb(0xff, 0x00, 0x00)], [0x0d, 0x37, 0x12, 0xff, 0x00, 0x00, 0x00, 0x00]);
  assert.deepEqual([...encodeMsiCustomRgb(0x00, 0xff, 0x00)], [0x0d, 0x37, 0x12, 0x00, 0xff, 0x00, 0x00, 0x00]);
  assert.throws(() => encodeMsiCustomRgb(256, 0, 0));
  assert.throws(() => encodeMsiCustomRgb(-1, 0, 0));
});

test("button bindings match the captured mouse-function, multimedia, macro, and DPI reports", () => {
  // Assert — mouse function: captured 0d 41 01 00 07 00 01 00 (left click -> left click)
  assert.deepEqual(
    [...encodeMsiButtonMouseFunction(MSI_BUTTON_ID.left, "Left click")],
    [0x0d, 0x41, 0x01, 0x00, 0x07, 0x00, 0x01, 0x00],
  );
  // multimedia: captured 0d 41 10 00 0a cd 00 00 (MB4 -> Play/Pause)
  assert.deepEqual(
    [...encodeMsiButtonMultimedia(MSI_BUTTON_ID.forward, "Play/Pause")],
    [0x0d, 0x41, 0x10, 0x00, 0x0a, 0xcd, 0x00, 0x00],
  );
  // macro: captured 0d 41 10 00 0b 01 01 00 (MB4 -> macro slot 1)
  assert.deepEqual(
    [...encodeMsiButtonMacro(MSI_BUTTON_ID.forward, 1)],
    [0x0d, 0x41, 0x10, 0x00, 0x0b, 0x01, 0x01, 0x00],
  );
  // DPI select level: captured 0d 41 10 00 0c 04 00 00 (MB4 -> select DPI level 1)
  assert.deepEqual(
    [...encodeMsiButtonDpi(MSI_BUTTON_ID.forward, "Select level", 1)],
    [0x0d, 0x41, 0x10, 0x00, 0x0c, 0x04, 0x00, 0x00],
  );
  assert.throws(() => encodeMsiButtonMacro(MSI_BUTTON_ID.left, 31));
});

test("msiDpiOptions mirrors the ladder MSI Center offers", () => {
  // Act
  const options = msiDpiOptions();

  // Assert
  assert.equal(options[0], 100);
  assert.equal(options.at(-1), 20000);
  assert.equal(options.at(-2), 19000); // 19,100-19,900 are not offered
  assert.equal(options.length, 191); // 190 stepped values plus the 20,000 stop
  assert.deepEqual([...options].sort((a, b) => a - b), options); // ascending
  assert.equal(new Set(options).size, options.length); // no duplicates
  assert.ok(options.every((dpi) => isValidMsiDpiPreset(dpi))); // every offer is writable
});
