# Repository Guidelines

## Project structure

- `index.html` loads `src/main.jsx`, which mounts the React workbench in `src/App.jsx`. UI styles and images live in `src/flasher.css` and `src/assets/`.
- For board or firmware catalog changes, start with `boards.json` (board models and releases), `public/boards-source.json` (runtime catalog location), and `src/catalog.mjs` (catalog loading and firmware downloads). See the catalog section in `README.md` for manual updates and Release-based generation.
- For firmware input changes, follow `src/firmware.mjs` from the selected release or local BIN to image validation in `src/flash-image.mjs` (ESP32) or `src/bk7258-image.mjs` (BK7258). Supported ESP32 chip names live in `src/chips.mjs`.
- For device communication, start with `src/useWorkbench.js` for connection, flashing, and serial log lifecycle. The chip-specific protocols live in `src/esp32.mjs` and `src/bk7258.mjs`. Serial control-line handling lives in `src/serial-signals.mjs`.

## Local development

Use npm and a Node.js version matching `engines.node` in `package.json`. Run these commands from the repository root.

| Task | Command |
| --- | --- |
| Install locked dependencies | `npm ci` |
| Start the local workbench | `npm run dev` |
| Run the Node.js test suite | `npm test` |
| Build the static site in `dist/` | `npm run build` |

## Flashing changes

Follow the formatting of the files you edit. Keep board, chip, and operation names consistent across the catalog, code, UI, and documentation.

Use the existing `test/*.test.mjs` suites for automated checks. Exercise relevant failure paths, such as an incompatible image, a device disconnect, or a verification failure.

For hardware checks, use desktop Chrome or Edge on localhost or HTTPS, the target board, its matching firmware, and a data-capable USB connection with a working serial driver. BK7258 downloads use DL_UART0. Record the board model, firmware version, and which connection, write, verification, reset, or log scenarios you exercised. See `README.md` for board-specific procedures and compatibility records.

## Commits and pull requests

Use a short imperative commit subject. In the pull request, describe the affected behavior, link the issue when available, and summarize verification. Include screenshots for visible changes and hardware results for device-specific fixes.
