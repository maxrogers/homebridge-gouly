# Architecture

## Overview

```
Home app / Siri
      │ HAP
┌─────▼──────────────────────────────────────────────────────┐
│ GoulyAccessory                                             │
│   Lightbulb: On, Brightness, Hue, Saturation, ColorTemp    │
│   AdaptiveLightingController                               │
│   Pattern switches in "<name> Patterns" accessories        │
│   state: on, brightness, last solid colour, active pattern │
├───────────────┬──────────────────────┬─────────────────────┤
│ Driver        │ PatternStore         │ colour.ts           │
│  Classic  ✔   │  inbox of every F6   │  HS → RGBW          │
│  Pro (exp.)   │  frame echoed, with  │  mired → RGBW       │
│  build/parse  │  auto description    │  RGBW → HomeKit     │
├───────────────┴──────────────────────┴─────────────────────┤
│ GoulyConnection -> python/gouly_bridge.py (tinytuya)       │
│   persistent socket, reconnect with backoff,               │
│   paced send queue (200 ms, like the app), frame events    │
└─────▲──────────────────────────────────────────────────────┘
      │ DP 101, base64 Gouly frames      ▲ echoes of app commands too
   Controller  ◄──────────────────────── Gouly app
```

**State is echo driven.** The controller echoes every command it accepts, whoever sent it. The accessory updates HomeKit from echoes rather than from what it sent, so changes made in the Gouly app appear in the Home app. Because echoes are occasionally missed, the accessory also sends a state query (`FC`) on connect and every `pollSeconds` (default 60).

**Controller detection.** With `controllerType: auto` the plugin sends both query commands on connect; the family that answers with a `0xBB` report wins. Both queries are harmless on the other family (the classic controller just echoes `B6`).

## Transport: why a Python bridge

The first versions used tuyapi (Node). On protocol 3.4, tuyapi tracks reply sequence
numbers itself, and this controller pushes unsolicited status and heartbeat packets that
knock that tracking out of step (codetheweb/tuyapi#634). The result: commands went out,
nothing happened, no echoes. tinytuya (Python) handles these devices correctly and is also
what ha-gouly uses.

So the plugin runs `python/gouly_bridge.py`, which holds the tinytuya connection and speaks
JSON lines over stdin/stdout. tinytuya 1.20.0 and pure-Python AES (pyaes) are bundled in
`python/vendor`, so the only requirement is Python 3 (present in the Homebridge Docker
image). Protocol 3.5 would need a GCM-capable crypto library (cryptography or pycryptodome)
installed alongside. `python/check_bridge.py` tests the bridge against the real controller
using the saved Homebridge config.

## Pattern groups (Advanced)

With "Organize patterns into groups" on, each non-empty group is its own accessory
("<name> <group>") holding that group's pattern switches. Group ids are stable, so renaming a
group keeps its HomeKit accessory (room, position, scenes). The default group keeps the
original "Patterns" accessory ID. Moving a pattern between groups recreates its switch in the
new accessory; the settings page asks for confirmation and explains that scenes using it need
updating. Deleting a group moves its patterns to the default group. Empty groups have no
accessory. Only one pattern can be active across all groups.

## Pacing: coalescing rapid changes

HomeKit sends a write for every step of a slider drag, and quick flipping produces bursts.
`CommandScheduler` keeps only the latest wanted power, brightness and look (color or
pattern, newest wins), sends 150 ms after the last change (at least every 500 ms during a
continuous drag), adds one commit per batch, and never starts a batch before the controller
has had time for the previous one (~220 ms per frame). A color, pattern or
brightness change while off turns the lights on; the latest action wins (change then off stays
off). HomeKit state is
updated immediately; only traffic to the lights is paced.

## HomeKit mapping

| HomeKit | Classic controller |
|---|---|
| On | `F1 01/00` |
| Brightness 1-100% | `F3` 1-255 |
| Hue + Saturation | `F2 R G B 0`, full value (brightness is separate); the two writes are debounced into one command |
| Color Temperature 140-500 mired | 140 = RGB white ("CW") blending to 255 = RGB+W ("PW"), fading RGB out to 370 (~2700K), then W only ("WW") to 500 |
| Adaptive Lighting | optional (off by default); disabled automatically when a pattern is turned on so it cannot overwrite it |
| Power switch | separate on/off Switch on the light's accessory (one-tap tile via "Show as Separate Tiles") |
| Pattern switch on | replays the recorded `F6` frame (powers on first if needed); pattern switches live on their own "<name> Patterns" accessory so the light holds only the slider and power switch |
| Pattern switch off | configurable: restore last solid color (default), turn off, or leave running |

## Patterns: user flow

1. Apply patterns in the Gouly app as usual: built-in, custom, downloaded.
2. Each unique pattern is saved to the recorded list (Homebridge storage, not the config) with a description such as *Follow · red/cool white/green/yellow · right · speed 2*.
3. On the plugin's **Patterns** page: rename, adjust speed and direction, **Add to HomeKit**.
4. Save and restart Homebridge. Each one appears as a switch in the "<name> Patterns" accessory.

Why record instead of downloading from Gouly's library: downloads come from Gouly's cloud (not visible on the controller), would mean depending on an undocumented, possibly pinned API, and would redistribute their content. Recording covers downloaded patterns anyway: download in the app, apply once.

Favourites are stored in the plugin config (backed up with Homebridge, editable by hand). The recorded list is scratch data and can be cleared.

## Diagnostics

`ControllerDiagnostics` (src/diagnostics.ts) keeps what the controller reported (type, firmware
from the clock reply, pixel count, LED IC, color order), connection history, unrecognized
commands, recent events and the last 150 frames, and saves them to `<storage>/gouly/info-<id>.json`.
The settings page shows them under Controller info; "Refresh from controller" asks the plugin, via
the control channel, to re-query the state report. The debug report (homebridge-ui/server.js)
combines this with the settings, the last network search and the plugin's log lines, and replaces
every configured key value before returning it. Echoes of frames the plugin sent itself within the
last 5 seconds are never recorded as patterns.

## Discovery

The controller does not broadcast, so setup finds it by scanning the local /24 for TCP 6668 and
trying the device id and key against each candidate: only the right controller completes the
encrypted handshake. The same search runs automatically if the controller stops answering at its
known address (DHCP change). A port scan alone can say "a Tuya device is here", not which one;
the key check identifies it, and a state query identifies the controller type. The search
narrates each step (shown live by Find, and saved for the debug report). Automatic searches run
once per outage and back off from 5 minutes to 1 hour while the controller stays missing.
MAC prefixes are Tuya-wide and do not identify the model; the Tuya product id does.

## Settings UI

Custom Homebridge UI with two tabs:

- **Patterns**: toolbar with Record and + New pattern. Every pattern is a card with an animated two-roof house (LED 0 bottom left, along the lower roof to the right, then top left to top right; "Left" runs the reverse) and an editable name. *In HomeKit* cards: Edit, Remove, and a Group menu when groups are on. *Recorded* cards: Add to HomeKit, Edit, Delete. Recording shows a banner with instructions and a 15 minute countdown; new patterns appear live with a "New" badge; exact duplicates are skipped. Edit and + New pattern open the same editor (effect, speed, direction, up to 15 colors with a warm white slider each, background) with a live preview. Each card has its own *Show on house* switch that plays it on the real lights (one at a time); turning it off restores what was showing. Edits go to Homebridge's pending config and are written by its Save button.
- **Settings**: built in the plugin's own page rather than the generated Homebridge form, which cannot express the per-controller Advanced section. Name, Device ID, Local Key (masked, Show), IP with an inline Find, power switch, pattern-off behavior, and the gouly-keys link; a collapsed Advanced section at the bottom holds protocol, controller type, Adaptive Lighting, groups, detailed logging, poll interval, Python path and Add another controller. Deleting a controller is the trash button next to the controller picker; it confirms, then saves immediately. One controller picker at the top, shared by both tabs, shown only with several controllers; entries read "name · IP · N patterns" and flag incomplete ones.

Previews are recreations of the firmware effects: simple motion effects are close, sparkle-style ones approximate. Show on house is the ground truth.
