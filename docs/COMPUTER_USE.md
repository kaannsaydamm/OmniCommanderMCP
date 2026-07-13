# Computer Use

Omni Commander exposes both pixel-level and semantic UI control.

## Observation tools

- `computer_observe`: screenshot returned as MCP image content.
- `monitor_list`: display topology.
- `window_list`: visible windows and geometry.
- `accessibility_snapshot`: semantic controls from UI Automation, Accessibility, or AT-SPI.
- `screen_ocr`: local Tesseract text/word extraction.
- `screen_find_text`: OCR matches with click-ready center coordinates.

## Action tools

- Mouse: move, click, drag, scroll.
- Keyboard: text, individual key, hotkey.
- Window: focus, minimize, maximize, restore, close, move, resize.
- Application: launch and close.
- `accessibility_invoke`: semantic Windows UI Automation invoke/select.
- `computer_sequence`: up to 100 ordered actions.
- `computer_act_and_observe`: one action followed by a screenshot.
- `computer_click_text`: OCR target, click, and post-action screenshot.

## Recommended autonomous loop

Use small verified steps:

```text
observe → identify semantic/pixel target → act → observe → validate
```

Prefer accessibility elements over OCR, and OCR over hard-coded coordinates. Use coordinates only when the UI provides no semantic signal.

## Coordinate system

Coordinates are absolute virtual-desktop coordinates. Multi-monitor layouts can include negative X/Y coordinates. `monitor_list` should be called before assuming screen geometry.

A screenshot region returns region-relative OCR coordinates. Omni Commander converts `screen_find_text` and `computer_click_text` results back to virtual-desktop coordinates.

## Permissions and session boundaries

- Windows: UI actions generally work only at the same or lower integrity level. Run elevated when controlling elevated applications.
- macOS: grant Accessibility and Screen Recording permissions to the actual executable/terminal launching Node.
- Linux/X11: tools require access to `DISPLAY` and usually `XAUTHORITY`.
- Linux/Wayland: synthetic input is compositor-dependent. A secure compositor may intentionally reject generic automation.
- Services running outside the interactive login session cannot normally see or control the user's desktop.

## OCR

OCR is local and requires the `tesseract` executable plus language data. Example languages:

```text
eng
deu
fra
tur
```

Use the relevant installed language or a combined value supported by Tesseract, such as `eng+tur`.
