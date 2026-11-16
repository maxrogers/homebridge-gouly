# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.5] - 2026-11-15

### Fixed
- When the controller silently dropped off Wi-Fi, the plugin kept a dead connection for about 17
  minutes (until Linux gave up on it): HomeKit changes went nowhere and the Home app did not show
  No Response. The controller answers every state query, so after about 2.5 query intervals
  (2.5 minutes by default) without a reply the plugin now drops the connection and reconnects,
  and the outage counts from the last reply.

## [1.0.4] - 2026-10-22

### Fixed
- A controller that refuses connections after a Wi-Fi drop-out was reported as having a new Local
  Key. If the key worked within the last day, the log now says the controller is probably holding
  an old connection and to power-cycle it once, and no network search is run.
- HomeKit changes made while the controller was unreachable were queued and all replayed when it
  came back. Changes older than 30 seconds are now dropped, and after 15 seconds offline the Home
  app shows No Response.
- Find said "Add the Local Key" for a controller that announced itself while its port was busy;
  it now says it is not accepting connections right now.
- Find listed phones and computers with private (randomized) MAC addresses as probable Tuya devices.
- After a short outage the log said to check the controller is powered; it now says the controller
  was working recently and has probably dropped off Wi-Fi.

### Changed
- Docs: the controller does send occasional UDP announcements with its Device ID; troubleshooting
  for stale connections and weak Wi-Fi.

## [1.0.3] - 2026-10-18

### Fixed
- Renaming a controller or pattern group in the settings now renames its cached accessory in
  Homebridge (uses `updateDisplayName`). Previously the light kept its old name, and a renamed
  group only partly updated. Names you set in the Home app are not changed.

### Changed
- README shows the Verified by Homebridge badge.

## [1.0.2] - 2026-10-15

### Fixed
- Settings schema: required fields are listed at the object level (JSON Schema), and the platform
  has a name property, as the Homebridge verification checks require.
- package.json declares the `supports-hap` keyword.

## [1.0.1] - 2026-10-15

### Fixed
- A slow controller handshake was reported as a wrong key ("Check device key or version"), which
  made the plugin think the controller was gone and search the network. The bridge now allows
  5 seconds to connect and negotiate, then reads with a short timeout as before.
- Find missed slow controllers (0.8 s port timeout) and scanned Docker and VPN networks. It now uses
  3 seconds, retries slow hosts that exist, and skips virtual interfaces.
- Settings and README said gouly-keys does not work on Apple Silicon Macs. It does, when run natively
  (not under Rosetta).

### Changed
- Find lists every device answering on the Tuya port, with or without keys, each with its MAC
  address, a short note and a Use this IP button: your controller, a Tuya device that did not accept
  this Local Key, or a probable Tuya device when no key is entered yet.
- Find recognises Tuya devices without a key (protocol fingerprint, Tuya MAC prefixes, UDP
  announcements) and checks a key with a single handshake.
- When the controller answers but refuses the key, the log says so plainly instead of "not
  answering", and the plugin checks once whether the controller moved to another address.

## [1.0.0] - 2026-10-01

First public release.

- Local control of GOULY controllers (Tuya protocol 3.4): power, brightness, color, warm white
- Color temperature mapped onto the warm white LEDs; optional Adaptive Lighting
- Separate power switch for one-tap on/off
- Pattern recording from the Gouly app, pattern editor with animated previews, Show on house
- Pattern switches in their own accessory, with optional named groups shown as tabs
- Pattern switches show off while the lights are off and come back on with them
- Detailed logging option and a startup summary line for bug reports
- Download debug report (settings, controller info, recent commands, network search, log lines; key never included)
- Controller info panel with Refresh from controller
- Find explains each step: Tuya devices found, MAC addresses, key check, controller type
- Rapid HomeKit changes coalesced and paced
- Automatic controller discovery and IP change handling
- Pattern editor offers only the directions the Gouly app allows for each effect
- Tuya protocol 3.3 and 3.5 tried automatically when 3.4 is rejected
- Experimental Gouly Pro support (power, brightness, color), with guidance to send a controller report
