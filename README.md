# Active Monitor Workspaces

[![Version](https://img.shields.io/github/v/release/IndyDevGuy/active-monitor-workspaces?display_name=tag)](https://github.com/IndyDevGuy/active-monitor-workspaces/releases)
![Last Release](https://img.shields.io/github/release-date/IndyDevGuy/active-monitor-workspaces)
[![GNOME Shell](https://img.shields.io/badge/dynamic/json?color=blue&label=GNOME&query=%24.shell-version[0]&url=https://raw.githubusercontent.com/IndyDevGuy/active-monitor-workspaces/main/metadata.json)](#requirements)
[![License](https://img.shields.io/github/license/IndyDevGuy/active-monitor-workspaces)](LICENSE)
[![Release](https://github.com/IndyDevGuy/active-monitor-workspaces/actions/workflows/release-please.yml/badge.svg)](https://github.com/IndyDevGuy/active-monitor-workspaces/actions)
[![Build](https://github.com/IndyDevGuy/active-monitor-workspaces/actions/workflows/build-zip-on-release.yml/badge.svg)](...)
![Stars](https://img.shields.io/github/stars/IndyDevGuy/active-monitor-workspaces?style=social)

A GNOME Shell extension that enables **independent workspace switching per monitor**.

GNOME normally treats workspaces globally across displays. This extension introduces per-monitor workspace control, allowing you to switch workspaces on one display without affecting the others — while keeping GNOME’s native workflow intact.

![Workspace Overlay](https://github.com/IndyDevGuy/active-monitor-workspaces/blob/main/docs/images/all-monitors-view.png?raw=true)

---

## ✨ Features

- Switch workspaces independently on the active monitor
- Pointer-based or focus-based monitor selection
- Clean visual panel indicator
- Optional OSD feedback when switching
- Automatic window shifting when GNOME workspace settings allow
- Lightweight and performance-friendly
- Proper enable/disable lifecycle (no lingering signals or leaks)

---

## 🖥 How It Works

Each monitor maintains its own **virtual workspace index**.

When you switch workspaces:

- Only windows on the active monitor move
- Other monitors remain unchanged
- The panel indicator updates to reflect each display’s state

### Monitor Selection Modes

- **Pointer Mode** — Active monitor is determined by mouse position
- **Focus Mode** — Active monitor is determined by focused window

You can toggle between these modes using a configurable keyboard shortcut.

---

## 🔎 Panel Indicator

Example:

```
● D1:WS2 D2:WS1
```

- `D#` = Display number
- `WS#` = Workspace number
- ● + green highlight = Active monitor

Optional compact mode shows only the focused monitor.

---

## ⌨ Keyboard Shortcuts

Configurable via extensions settings:

- Switch to next workspace on active monitor
- Switch to previous workspace on active monitor
- Toggle monitor selection mode

---

## 🎬 Demo

> Add a GIF here once you record one.

---

## 📦 Installation
### Official (Recommended)

Install from:

https://extensions.gnome.org

Search for **Active Monitor Workspaces**

---

## ⚙ Requirements

GNOME Shell 49+ (Not tested with older versions)

Static workspaces enabled

Workspaces span displays enabled

The extension adapts automatically to your workspace configuration.

---

## 🧠 Why This Exists

Multi-monitor workflows often demand separation:

- Coding on one display
- Browser or documentation on another
- Terminal persistent on a third

GNOME’s default workspace model synchronizes displays globally.  
This extension introduces display-aware workspace switching without breaking GNOME’s design philosophy.

---

## 🗺 Roadmap

Planned enhancements:

- Indicator styling customization
- Animation tuning options
- Indicator position configuration
- Improved workspace persistence logic
- Optional per-monitor locking
- Optional window pinning behavior

---

## 🤝 Contributing

Issues and pull requests are welcome.

Please include:

- GNOME version
- Wayland or X11
- Steps to reproduce
- Relevant logs:

```bash
journalctl -f /usr/bin/gnome-shell
```

---

## 📜 License

MIT License

This project includes portions of MIT-licensed code from:
https://github.com/micheledaros/gnome-shell-extension-simulate-switching-workspaces-on-active-monitor

---

## 👤 Author

Developed and maintained by IndyDevGuy

GitHub: https://github.com/IndyDevGuy

---

## Acknowledgements

This extension was originally inspired by:

https://github.com/micheledaros/gnome-shell-extension-simulate-switching-workspaces-on-active-monitor

While the implementation has since been heavily refactored and expanded, the original project helped establish the foundational concept of per monitor workspace switching.

Thank you to the original author for contributing to the GNOME ecosystem.

---

### What Changed (and Why)

- Cleaned up hierarchy and spacing
- Made section structure consistent
- Tightened phrasing for professionalism
- Improved bullet formatting
- Added stronger demo guidance
- Made roadmap read like future vision instead of a list
- Improved attribution tone (confident, not apologetic)
