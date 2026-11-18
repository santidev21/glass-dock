<div align="center">

# 🧊 Glass Dock

**A macOS-style dock for GNOME Shell, made of frosted glass.**

![GNOME Shell](https://img.shields.io/badge/GNOME_Shell-51-4A86CF?logo=gnome&logoColor=white)
![Fedora](https://img.shields.io/badge/Fedora-45-51A2DA?logo=fedora&logoColor=white)
![Wayland](https://img.shields.io/badge/Wayland-ready-FFBC00?logo=wayland&logoColor=black)
![JavaScript](https://img.shields.io/badge/GJS-ES_modules-F7DF1E?logo=javascript&logoColor=black)

```
╭──────────────────────────────────────────────────────────╮
│  ⣿   🦊  📝  🖥️  🗂️  ✉️  │  ♻️                          │
│        •   •   •   •                                     │
╰──────────────────────────────────────────────────────────╯
```

</div>

---

## ✨ Features

| | |
|---|---|
| 🧊 **Live frosted glass** | Blurs whatever is behind the dock, windows included, with properly anti-aliased rounded corners. |
| 🔍 **Magnification** | Icons grow smoothly under the pointer, like on macOS. Icons are rendered at full size, so they stay sharp when zoomed. |
| 🙈 **Intellihide** | The dock gets out of the way when a window overlaps it, and comes back when you need it. |
| 🔴 **Notification badges** | Per-app counters from GNOME's notification tray **and** the Unity `LauncherEntry` API (Telegram, Thunderbird, Discord…). |
| 📌 **Pinned & running apps** | Uses your GNOME favorites, shows running apps with a dot, and lets you reorder pinned apps by drag & drop. |
| ⣿ **Show Apps & 🗑️ Trash** | App grid button on the left, Trash on the right (open it or empty it from its menu). |
| 🌗 **Light & dark** | The glass tint adapts to the system theme. |
| 🌐 **Spanish & English** | Follows the system language. |

## ⚙️ Settings

Open them from the **Extensions** app or with:

```sh
gnome-extensions prefs glass-dock@santidev21
```

| Setting | Default | Range |
|---|---|---|
| Icon size | `48` px | 24 – 128 |
| Magnification | `1.6×` | 1.0 (off) – 2.5 |
| Live blur | on | Off = only the wallpaper is blurred (lighter on the GPU) |

Changes apply instantly, no need to restart.

## 📦 Install

```sh
git clone https://github.com/santidev21/glass-dock.git ~/Dev/glass-dock
ln -s ~/Dev/glass-dock ~/.local/share/gnome-shell/extensions/glass-dock@santidev21
# On Wayland, log out and back in, then:
gnome-extensions enable glass-dock@santidev21
```

> [!NOTE]
> On Wayland, GNOME Shell caches extension code: after changing a `.js` file you need to log out
> and back in. CSS changes reload with `gnome-extensions disable/enable`.

If you edit the schema, recompile it:

```sh
glib-compile-schemas schemas/
```

## 🛠️ How it works

| File | What it does |
|---|---|
| `extension.js` | Entry point: reads settings and rebuilds the dock when they change |
| `dock.js` | The dock itself: layout, show/hide, magnification and drag & drop |
| `glass.js` | The frosted glass: a blurred clone of the window group, clipped by a rounded-corner shader |
| `items.js` | Dock items: app icons, Show Apps, Trash and separators |
| `magnifier.js` | Pure math for the zoom curve (tested in `test/`) |
| `intellihide.js` | Detects windows overlapping the dock (throttled to one check every 100 ms) |
| `badges.js` | Notification counters from the message tray and Unity `LauncherEntry` |
| `config.js` | Sizes, timings and blur constants |
| `prefs.js` · `schemas/` | Preferences window and its GSettings schema |
| `i18n.js` | Minimal Spanish/English translation |

### 🚀 Performance notes

- Animations (sliding, zoom) only touch **transforms** (`translation`/`scale`), never layout sizes,
  so Clutter does not relayout on every frame.
- Only a **strip** the size of the dock is blurred, not the whole monitor (about 100× fewer pixels
  on a 3440×1440 screen).
- The blurred strip never moves; its parent does. That keeps the blur **cached**, and it is only
  recomputed when something behind it actually redraws.
- When hidden, the dock is off-screen with opacity 0, so it is not painted at all.

## 🧪 Tests

```sh
gjs -m test/magnifier.test.js
```

## 🤝 Pairs well with

[**Mac Topbar**](https://github.com/santidev21/mac-topbar), a macOS-style top bar with a Fedora
logo menu, the active app name and a global menu, whose menus use the same frosted glass.
