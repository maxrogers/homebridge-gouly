# Contributing

Thanks for helping. Bug reports, controller reports and pull requests are all welcome.

## Reporting

- **Bugs**: use the [bug report form](../../issues/new?template=bug_report.yml). Include the plugin
  version, your Homebridge setup and the relevant log lines, with Detailed logging turned on under Settings, Advanced.
- **Other controllers or firmware**: use the [controller report form](../../issues/new?template=controller_report.yml)
  with output from `python/sniff.py`.
- **Never post your Local Key**, and check logs and config snippets before pasting them.

## Development

```bash
git clone https://github.com/maxrogers/homebridge-gouly.git
cd homebridge-gouly
npm install        # also builds via the prepare script
npm run lint       # ESLint
npm test           # builds, then runs the test suite
```

Tests run without hardware: a mock `tinytuya` in `test/fixtures` stands in for the controller.
They need Python 3 on the PATH.

To try a local build in Homebridge: `npm install /path/to/homebridge-gouly` from the Homebridge
storage directory, then restart Homebridge.

### Layout

| Path | What |
|---|---|
| `src/protocol/` | Frame building and parsing (`classic.ts` for GOULY, `pro.ts` for Gouly Pro) |
| `src/connection.ts` | Runs `python/gouly_bridge.py` and exchanges frames with it |
| `src/scheduler.ts` | Coalesces rapid HomeKit changes |
| `src/accessory.ts`, `src/platform.ts` | HomeKit services and accessories |
| `homebridge-ui/` | The settings page (patterns, editor, previews, settings) |
| `python/` | The tinytuya bridge, `check_bridge.py` and `sniff.py`; `vendor/` holds bundled libraries |
| `assets/` | The logo: `logo.svg` (vector source) and `make_logo.py`, which generates it; `icon.png` and the settings page icon are made from it |

See [ARCHITECTURE.md](ARCHITECTURE.md) and [PROTOCOL.md](PROTOCOL.md).

### Pull requests

- Keep changes focused, add or update tests, and run `npm test`.
- Update `CHANGELOG.md` under *Unreleased*.
- Protocol changes should be backed by captured frames (add them as test cases).
