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

Gouly controllers announce themselves on UDP only occasionally (the announcement carries the
Device ID, so it identifies the controller without a key) and are slow to accept connections, so
`src/discovery.ts` combines the methods of ha-gouly's gouly-keys and tinytuya's scanner:

1. **Networks.** The /24 of each real LAN interface. Docker, VPN (Tailscale, WireGuard) and other
   virtual interfaces, and 100.64.0.0/10, are skipped: a controller is never behind them.
2. **Port sweep.** The saved IP and ARP-known Tuya MAC addresses first (6 s timeout), then the
   rest for TCP 6668 with a 3 s timeout and 32 at a time (ha-gouly uses the same: an aggressive scan
   misses these controllers). Hosts in the ARP table that timed out get a second, 6 s try.
3. **Probe** (`python/gouly_probe.py`, one process per search, hosts streamed to it as they are
   found). Without a key: an unencrypted status query, which protocol 3.1/3.3 devices answer and
   3.4/3.5 devices (Gouly) answer by closing the connection. With a key: a protocol 3.4 session
   handshake signed with it; only a device holding that key answers with a correctly signed reply.
   A 3.3 (and, with AES-GCM available, 3.5) status request is the fallback. Meanwhile it listens on
   UDP 6666/6667/7000 for announcements (and asks 3.5 devices to announce).
4. **Labels.** MAC from the ARP table, matched against Tuya Smart Inc.'s registered prefixes (a
   Tuya module, not proof of Gouly), and the reverse DNS name.
5. **Ranking.** Each device gets a status and one plain sentence: confirmed (the key works),
   connected (the running plugin holds a session to it, so it is not probed again), wrong key (a
   Tuya device that refused this key), probable (Tuya-like, no key to check), possible (port open,
   not Tuya-like) or other (announced a different Device ID). Confirmed devices are connected once
   through the bridge to identify the controller type; if none passed the quick check, the three
   most likely get that full test too.

The settings page lists the results with Use this IP; the narrated log is saved for the debug
report. The plugin runs the same search, stopping as soon as the controller is confirmed, when no
IP is set, when the controller stops answering (DHCP change), or once when the device at its
address refuses the key (the address may now belong to another device). Automatic searches back
off from 5 minutes to 1 hour.

**Connection timing.** tinytuya uses one timeout for connecting, the session handshake and reads.
A short one turns a slow handshake into "Check device key or version" (Err 914), the same error
as a wrong key. The bridge connects and negotiates with 5 s and switches the socket to 0.5 s reads
once the session is up. Err 914 means something answered at the address, so the bridge reports it
as `rejected` rather than counting it towards `unreachable`. If the controller accepted the key
within the last day (`lastStateAt` in the diagnostics, kept across restarts), a rejection is
reported as a stale connection (power-cycle the controller once) and no network search is run;
otherwise as a key problem, followed by one search in case the address now belongs to another
device.

**Silent connections.** When the controller drops off Wi-Fi, TCP does not notice for about 15
minutes. The plugin queries the controller's state every poll interval and the controller always
answers, so after 2.5 intervals (at least 2 minutes) without anything received it tells the bridge to
drop the connection and reconnect, dating the outage from the last reply.

**While unreachable.** HomeKit writes in the first 15 seconds of an outage are queued; after that
they fail with No Response, so the Home app shows the real state of things. The bridge drops
queued sends older than 30 seconds instead of replaying them late, and the plugin re-reads the
controller's state on reconnecting.

## Settings UI

Custom Homebridge UI with two tabs:

- **Patterns**: toolbar with Record and + New pattern. Every pattern is a card with an animated two-roof house (LED 0 bottom left, along the lower roof to the right, then top left to top right; "Left" runs the reverse) and an editable name. *In HomeKit* cards: Edit, Remove, and a Group menu when groups are on. *Recorded* cards: Add to HomeKit, Edit, Delete. Recording shows a banner with instructions and a 15 minute countdown; new patterns appear live with a "New" badge; exact duplicates are skipped. Edit and + New pattern open the same editor (effect, speed, direction, up to 15 colors with a warm white slider each, background) with a live preview. Each card has its own *Show on house* switch that plays it on the real lights (one at a time); turning it off restores what was showing. Edits go to Homebridge's pending config and are written by its Save button.
- **Settings**: built in the plugin's own page rather than the generated Homebridge form, which cannot express the per-controller Advanced section. Name, Device ID, Local Key (masked, Show), IP with an inline Find, power switch, pattern-off behavior, and the gouly-keys link; a collapsed Advanced section at the bottom holds protocol, controller type, Adaptive Lighting, groups, detailed logging, poll interval, Python path and Add another controller. Deleting a controller is the trash button next to the controller picker; it confirms, then saves immediately. One controller picker at the top, shared by both tabs, shown only with several controllers; entries read "name · IP · N patterns" and flag incomplete ones.

Previews are recreations of the firmware effects: simple motion effects are close, sparkle-style ones approximate. Show on house is the ground truth.
