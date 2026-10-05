# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
