# MSI Clutch GM41 protocol

Source: USBPcap captures of MSI Center configuring a GM41 (`0db0:0d4c`) on Windows, one capture per settings page. The raw captures are not committed; every frame quoted here and in `src/drivers/msi/hid.test.ts` is copied from them.

## Transport

The mouse exposes three interfaces: MI_00 (boot mouse), MI_01 (vendor collection `FF10:0006`), and MI_02 (consumer control and keyboard). Only MI_01 accepts writes; the OS owns the other two. MSI Center configures the mouse with 8-byte unnumbered feature reports (SET_REPORT, report id 0) on MI_01. Each report is a `0d` marker, a command byte, and up to six argument bytes, zero-padded.

The mouse reports state as 64-byte input reports on the same interface (MI_01, endpoint `0x84`; WebHID lists input report 0 on `FF10:0006`). Each is the command byte with bit 7 set followed by the current value. After a polling write it sends `0d 91 <interval>`. During a lighting block it cycles through its whole lighting state every ~12 ms, and dumps it once more after the block closes:

| Report | Field |
|---|---|
| `0d 82 02` / `0d 82 e8 03` | block opened / closed |
| `0d b3 xx` | mode |
| `0d b4 xx` | brightness (`ff` while off) |
| `0d b5 xx` | unknown; `08` while lit, `ff` while off |
| `0d b6 xx` | speed (`ff` while off) |
| `0d b7 12 RR GG BB` | colour |

The state changes 10-50 ms after a write, but MSI Center resends each lighting report for up to ~320 ms regardless, and the driver resends for ~150 ms. Nothing reads a setting without writing it, so `readStatus` still returns the driver's own last writes.

The same endpoint carries `a0 xx 07 yy 94 00 94` reports every few seconds; see battery below.

## Commands

| Command | Arguments | Notes |
|---|---|---|
| `11` polling | interval in ms | `01` 1000 Hz, `02` 500 Hz, `04` 250 Hz, `08` 125 Hz |
| `12` angle snapping | `00` off, `01` on | |
| `14` lift-off distance | `01` Low, `02` High | |
| `15` DPI presets | five bytes of DPI / 100, then `00` | e.g. `05 0a 10 20 40 00` = 500/1000/1600/3200/6400 |
| `16` active preset | `00`-`04` | |
| `1a` motion sync | `00` off, `01` on | |
| `32` auto LED off | `00` off, `01` on | |
| `33` lighting mode | `00` off, `01` steady, `02` breathing, `03` rainbow, `04` custom | |
| `34` brightness | `01`-`03` | |
| `36` effect speed | `00`-`02` | |
| `37` colour | `12 RR GG BB` | `12` is constant across every captured colour |
| `41` button binding | `<button> 00 <group> <a> <b> <c>` | see below |

After every DPI, polling, performance, or power write, MSI Center also re-sends its current motion sync (`1a`) and auto LED off (`32`) values. That looks like MSI Center resending its own state rather than something the mouse requires, so the driver does not copy it.

### Blocks

Lighting and button writes are always wrapped in a block: `0d 02 02` (lighting) or `0d 02 09` (buttons) opens it, and `0d 02 e8 03` closes it. MSI Center rewrites the whole lighting state, or all five buttons, inside each block. A lighting block is mode, brightness, speed, colour, then brightness again:

```text
0d 02 02 / 0d 33 01 / 0d 34 03 / 0d 36 00 / 0d 37 12 ff 00 00 / 0d 34 03 / 0d 02 e8 03
```

The first brightness report sometimes carries the previous value and sometimes `02`; the second always carries the new one. The driver sends the new value in both.

### Buttons

Button ids are `01` left, `02` right, `04` middle, `08` back, `10` forward.

| Group | Meaning | `a` `b` `c` |
|---|---|---|
| `06` | factory default (middle and back) | `00 00 00` |
| `07` | mouse button | `00`, button id (`00` disables), `00` |
| `08` | scroll | `00`, `01` up or `ff` down, `00` |
| `0a` | media | `00`, HID consumer usage (`cd` play/pause, `b7` stop, `b6` previous, `b5` next, `e9` volume up, `ea` volume down, `e2` mute), `00` |
| `0b` | macro | slot `01`-`1e`, `01`, `00` |
| `0c` | DPI | `00`, `01` cycle up / `02` cycle down / `03` default / `04` select, stage `00`-`04` for select |

The button encoders are in the codec but not yet connected to OpenMouse's button-mapping UI.

## Hardware status

Mode `04` (custom) has not been explained, so the driver uses `01` (steady), which takes the colour in the captures.

Tested on a GM41 over USB (firmware: TODO) with this driver:

- [ ] DPI preset values and active preset
- [ ] Polling rate 125 / 250 / 500 Hz
- [x] Polling rate 1000 Hz: movement reports went from 8 ms apart after `0d 11 08` to 1 ms after `0d 11 01`, and the mouse echoed `0d 91 01`
- [ ] Lift-off distance, motion sync, angle snapping
- [ ] Lighting: off, steady colour, breathing, rainbow, brightness, speed

Settings are stored on the mouse: DPI (400) and lighting (static red) written by OpenMouse were still applied after the receiver was unplugged and the mouse switched off at its power switch.

Open questions:

- Whether settings can be written over the 2.4 GHz receiver. Configuration was only captured over USB, and the receiver's product id has not been recorded.
- Battery: `a0 xx 07 yy 94 00 94` arrives on endpoint `0x84` while the mouse moves. `xx` falls as the battery drains (earlier notes: `4d` at 57%, `48` at 54%, `45` at 53%), and `yy` was seen as `00` and `04`. More samples across the range are needed to decode it.
- Earlier notes record `0d 96 80`-`84` for DPI stages 1-5. It is not in the saved captures, so its direction and meaning are unconfirmed.
