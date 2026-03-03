/*
 * Active Monitor Workspaces
 *
 * Portions of this project were derived from
 * gnome-shell-extension-simulate-switching-workspaces-on-active-monitor
 * Copyright (c) 2019 Xiaoguang Wang
 * Copyright (c) 2026 IndyDevGuy
 *
 * Used under the MIT License.
 */

import Clutter from "gi://Clutter";
import Shell from "gi://Shell";
import St from "gi://St";
import Meta from "gi://Meta";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

const HOTKEY_NEXT = "switch-to-next-workspace-on-active-monitor";
const HOTKEY_PREVIOUS = "switch-to-previous-workspace-on-active-monitor";
const HOTKEY_TOGGLE_MODE = "toggle-monitor-selection-mode";

const Direction = Object.freeze({
    UP: -1,
    DOWN: 1,
});

function wrapIndex0Based(idx, n) {
    return ((idx % n) + n) % n;
}

function getPointerXY() {
    // returns [x, y, mods]
    const [x, y] = global.get_pointer();
    return [x, y];
}

function _rgba({ r, g, b }, a) {
    return `rgba(${r},${g},${b},${a})`;
}

function _hexToRgb(hex) {
    const h = String(hex).replace("#", "");
    const v = parseInt(h.length === 3 ? h.split("").map(c => c + c).join("") : h, 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

/**
 * Try theme lookup first (best), then fall back to gsettings accent-color mapping.
 */
class AccentColor {
    constructor(extSettings) {
        this._extSettings = extSettings;
        this._iface = new Gio.Settings({ schema_id: "org.gnome.desktop.interface" });

        // Reasonable Adwaita-ish fallback palette
        this._accentMap = {
            blue:   "#3584e4",
            teal:   "#2190a4",
            green:  "#33d17a",
            yellow: "#f6d32d",
            orange: "#ff7800",
            red:    "#e01b24",
            pink:   "#d56199",
            purple: "#9141ac",
            slate:  "#6f8396",
        };
    }

    _useSystem() {
        try { return this._extSettings.get_boolean("use-system-accent-color"); }
        catch (_) { return true; }
    }

    _themeAccentRgb() {
        try {
            const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();

            // GNOME Shell themes often define one of these
            for (const name of ["accent_bg_color", "accent_color"]) {
                const [ok, color] = theme.lookup_color(name);
                if (ok && color) {
                    // St/Clutter colors usually expose red/green/blue as 0..255
                    const r = color.red ?? color.r ?? 0;
                    const g = color.green ?? color.g ?? 0;
                    const b = color.blue ?? color.b ?? 0;
                    return { r, g, b };
                }
            }
        } catch (_) {}
        return null;
    }

    _gsettingsAccentRgb() {
        try {
            const name = this._iface.get_string("accent-color");
            const hex = this._accentMap[name] ?? "#33d17a";
            return _hexToRgb(hex);
        } catch (_) {
            return _hexToRgb("#33d17a");
        }
    }

    rgb() {
        if (!this._useSystem()) return _hexToRgb("#4ade80"); // your old green fallback
        return this._themeAccentRgb() ?? this._gsettingsAccentRgb();
    }

    rgba(alpha) {
        return _rgba(this.rgb(), alpha);
    }
}

function findMonitorIndexForPoint(x, y) {
    const monitors = Main.layoutManager.monitors || [];
    for (let i = 0; i < monitors.length; i++) {
        const m = monitors[i];
        if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) {
            return i;
        }
    }

    // If pointer is in a gap (rare) choose nearest monitor by distance to its rect.
    let bestIdx = 0;
    let bestDist = Number.POSITIVE_INFINITY;

    for (let i = 0; i < monitors.length; i++) {
        const m = monitors[i];
        const cx = Math.max(m.x, Math.min(x, m.x + m.width));
        const cy = Math.max(m.y, Math.min(y, m.y + m.height));
        const dx = x - cx;
        const dy = y - cy;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
        }
    }

    return bestIdx;
}

class MonitorResolver {
    constructor(settings, onActiveMonitorChanged) {
        this.settings = settings;
        this._onActiveMonitorChanged = onActiveMonitorChanged;

        this._lastPointerMonitor = this._computePointerMonitor();
        this._lastResolvedMonitor = this._lastPointerMonitor;

        this._motionId = 0;
        this._pollId = 0;

        this._motionId = global.stage.connect("motion-event", () => {
            this._updatePointerMonitor(true);
            return Clutter.EVENT_PROPAGATE;
        });

        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            this._updatePointerMonitor(false);
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this._motionId) {
            global.stage.disconnect(this._motionId);
            this._motionId = 0;
        }
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
    }

    _getMode() {
        try {
            const m = this.settings.get_string("monitor-selection-mode");
            return m === "focus" ? "focus" : "pointer";
        } catch (_) {
            return "pointer";
        }
    }

    _computePointerMonitor() {
        const [x, y] = getPointerXY();
        return findMonitorIndexForPoint(x, y);
    }

    _updatePointerMonitor(forceNotify) {
        const cur = this._computePointerMonitor();
        if (cur !== this._lastPointerMonitor) {
            this._lastPointerMonitor = cur;
            if (typeof this._onActiveMonitorChanged === "function") {
                this._onActiveMonitorChanged(cur);
            }
        } else if (forceNotify) {
            if (typeof this._onActiveMonitorChanged === "function") {
                this._onActiveMonitorChanged(cur);
            }
        }
    }

    _getFocusedWindowMonitor() {
        try {
            const focusWin =
                global.display.get_focus_window?.() ??
                global.display.focus_window ??
                null;

            if (!focusWin) return null;
            if (focusWin.get_window_type?.() !== Meta.WindowType.NORMAL) return null;

            return focusWin.get_monitor();
        } catch (_) {
            return null;
        }
    }

    resolve() {
        const mode = this._getMode();

        if (mode === "pointer") {
            this._lastResolvedMonitor = this._lastPointerMonitor;
            return this._lastPointerMonitor ?? 0;
        }

        // focus mode
        const focused = this._getFocusedWindowMonitor();
        const result = focused ?? this._lastPointerMonitor ?? 0;
        this._lastResolvedMonitor = result;
        return result;
    }

    toggleMode() {
        const current = this._getMode();
        const next = current === "pointer" ? "focus" : "pointer";
        this.settings.set_string("monitor-selection-mode", next);
        return next;
    }
}

class MonitorLabeler {
    constructor(settings) {
        this.settings = settings;
    }

    getLabel(monitorIndex) {
        try {
            const useCustom = this.settings.get_boolean("use-custom-monitor-labels");
            if (useCustom) {
                const labels = this.settings.get_strv("monitor-labels");
                const raw = labels?.[monitorIndex];
                const trimmed = raw ? String(raw).trim() : "";
                if (trimmed.length) return trimmed;
            }
        } catch (_) {}
        return String(monitorIndex + 1);
    }

    getPillMode() {
        try {
            const mode = this.settings.get_string("pill-mode");
            return mode === "focused" ? "focused" : "all";
        } catch (_) {
            return "all";
        }
    }
}

class WorkspacePanelIndicator {
    constructor(labeler, accent) {
        this.labeler = labeler;
        this.accent = accent;
        this._button = null;

        this._pillBox = null;
        this._labels = [];
        this._separators = [];

        this._activeMonitorIndex = 0;
        this._activeColor = "#4ade80";
    }

    enable() {
        if (this._button) return;

        const btn = new PanelMenu.Button(0.0, "Per-monitor workspaces", false);

        const pill = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });

        pill.set_style(`
            padding: 2px 10px;
            border-radius: 999px;
            background-color: rgba(255,255,255,0.10);
            font-weight: 700;
            font-size: 12px;
        `);

        btn.add_child(pill);
        Main.panel.addToStatusArea("per-monitor-workspaces-indicator", btn, 1, "right");

        this._button = btn;
        this._pillBox = pill;
    }

    disable() {
        if (!this._button) return;
        this._button.destroy();
        this._button = null;

        this._pillBox = null;
        this._labels = [];
        this._separators = [];
    }

    setActiveMonitorIndex(idx) {
        this._activeMonitorIndex = idx;
    }

    _ensureSegments(count) {
        if (!this._pillBox) return;

        if (this._labels.length === count) return;

        this._pillBox.destroy_all_children();
        this._labels = [];
        this._separators = [];

        for (let i = 0; i < count; i++) {
            if (i > 0) {
                const sep = new St.Label({ text: "   " });
                sep.set_style(`opacity: 0.85;`);
                this._pillBox.add_child(sep);
                this._separators.push(sep);
            }

            const seg = new St.Label({ text: "" });
            seg.set_y_align(Clutter.ActorAlign.CENTER);
            seg.set_style(`margin: 0; padding: 0;`);
            this._pillBox.add_child(seg);
            this._labels.push(seg);
        }
    }

    update({ virtualByMonitor0, focusedMonitorIndex, focusedVisibleCount }) {
        if (!this._pillBox) return;

        const pillMode = this.labeler.getPillMode();

        if (pillMode === "focused") {
            this._ensureSegments(1);

            const disp = this.labeler.getLabel(focusedMonitorIndex);
            const ws = (virtualByMonitor0?.[focusedMonitorIndex] ?? 0) + 1;
            const w = focusedVisibleCount ?? 0;

            const isActive = focusedMonitorIndex === this._activeMonitorIndex;
            const text = isActive ? `● D${disp} · WS${ws} · ${w}w` : `D${disp} · WS${ws} · ${w}w`;

            this._labels[0].set_text(text);
            this._labels[0].set_style(`
                color: ${isActive ? this.accent.rgba(1.0) : "rgba(255,255,255,0.95)"};
                font-weight: 700;
            `);
            return;
        }

        const count = (virtualByMonitor0 ?? []).length;
        this._ensureSegments(count);

        for (let idx = 0; idx < count; idx++) {
            const d = this.labeler.getLabel(idx);
            const ws = (virtualByMonitor0?.[idx] ?? 0) + 1;
            const isActive = idx === this._activeMonitorIndex;

            this._labels[idx].set_text(isActive ? `● D${d}:WS${ws}` : `D${d}:WS${ws}`);
            this._labels[idx].set_style(`
                color: ${isActive ? this.accent.rgba(1.0) : "rgba(255,255,255,0.95)"};
                font-weight: 700;
            `);
        }
    }
}

class WorkspaceOsd {
    constructor() {
        this._actor = null;
        this._timeoutId = 0;
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._actor) {
            this._actor.destroy();
            this._actor = null;
        }
    }

    showOnMonitor(monitorIndex, text, direction) {
        this.destroy();

        const monitor =
            Main.layoutManager.monitors?.[monitorIndex] ?? Main.layoutManager.primaryMonitor;

        const box = new St.BoxLayout({ vertical: true, reactive: false, can_focus: false });
        const label = new St.Label({ text });
        box.add_child(label);

        box.set_style(`
            padding: 10px 14px;
            border-radius: 14px;
            background-color: rgba(0,0,0,0.72);
            color: #fff;
            font-weight: 650;
            font-size: 14px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.35);
        `);

        Main.layoutManager.addChrome(box);

        const marginTop = 28;
        const slidePx = 26;
        box.opacity = 0;

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const [w] = box.get_size();
            const baseX = Math.round(monitor.x + (monitor.width - w) / 2);
            const y = Math.round(monitor.y + marginTop);
            const startX = baseX + (direction === Direction.DOWN ? -slidePx : slidePx);
            box.set_position(startX, y);

            box.ease({
                opacity: 255,
                x: baseX,
                duration: 140,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });

            return GLib.SOURCE_REMOVE;
        });

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            this._timeoutId = 0;
            box.ease({
                opacity: 0,
                duration: 170,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this.destroy(),
            });
            return GLib.SOURCE_REMOVE;
        });

        this._actor = box;
    }
}

/**
 * Slick overlay: 2 rows (per monitor), each row shows every workspace with live window clones.
 * Highlights:
 * - active monitor row
 * - current virtual workspace per monitor
 */
class WorkspaceThumbOverlay {
    constructor(labeler, accent, settings) {
        this.labeler = labeler;
        this.accent = accent;
        this.settings = settings;

        this._actors = [];
        this._timeoutId = 0;
        this._hideMs = 4000;

        // visual sizing
        this._cellW = 250;
        this._cellH = 250;
        this._gap = 10;
        this._rowGap = 10;

        // limit per cell to keep it fast
        this._maxClonesPerCell = 4;
        this._gen = 0;               // increment each show/destroy to invalidate callbacks
        this._idleIds = new Set();   // track idle sources we create
    }

    destroy() {
        this._gen++;

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        for (const id of this._idleIds) GLib.source_remove(id);
        this._idleIds.clear();

        for (const a of this._actors) {
            try { a.destroy(); } catch (_) {}
        }
        this._actors = [];
    }

    _showOnAllDisplays() {
        try { return this.settings.get_boolean("overlay-show-on-all-displays"); }
        catch (_) { return false; }
    }

    _showAllMonitorRows() {
        try { return this.settings.get_boolean("overlay-show-all-monitors"); }
        catch (_) { return false; }
    }

    _addIdle(fn) {
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleIds.delete(id);
            return fn();
        });
        this._idleIds.add(id);
        return id;
    }

    _scheduleHide() {
        const gen = this._gen;

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._hideMs, () => {
            this._timeoutId = 0;
            if (gen !== this._gen) return GLib.SOURCE_REMOVE;

            const actors = [...this._actors];

            for (const actor of actors) {
                try {
                    actor.ease({
                        opacity: 0,
                        duration: 140,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                } catch (_) {}
            }

            // Destroy after fade (guard against a newer gen)
            this._addIdle(() => {
                if (gen !== this._gen) return GLib.SOURCE_REMOVE;
                this.destroy();
                return GLib.SOURCE_REMOVE;
            });

            return GLib.SOURCE_REMOVE;
        });
    }

    _getNormalWindows() {
        let wins = [];

        try {
            // Best: list all normal windows across workspaces
            const tabListEnum =
                Meta.TabList?.NORMAL_ALL ??
                Meta.TabList?.NORMAL ??
                null;

            if (tabListEnum !== null) {
                wins = global.display.get_tab_list(tabListEnum, null) ?? [];
            } else {
                // Fallback: use current compositor actors (less complete)
                wins = (global.get_window_actors?.() ?? [])
                    .map(a => a.get_meta_window?.())
                    .filter(Boolean);
            }
        } catch (_) {
            wins = [];
        }

        const items = [];

        for (const mw of wins) {
            try {
                if (!mw) continue;
                if (mw.get_window_type?.() !== Meta.WindowType.NORMAL) continue;

                // Skip "special" windows if you want
                if (mw.skip_taskbar) continue;

                const priv = mw.get_compositor_private?.();
                if (!priv) continue; // cannot preview without compositor actor

                items.push({ meta: mw, actor: priv });
            } catch (_) {}
        }

        return items;
    }

    _buildCellContent(monitorIndex, workspaceIndex, cellW, cellH, virtualByMonitor0, nWorkspaces) {
        const gen = this._gen;
        const stillValid = () => (gen === this._gen) && (this._actors?.length > 0);
        const realIndex = this._realWorkspaceForVirtual(
            monitorIndex,
            workspaceIndex,
            virtualByMonitor0,
            nWorkspaces
        );

        const wsObj = global.workspace_manager.get_workspace_by_index(realIndex);

        const cell = new St.Widget({
            reactive: false,
            can_focus: false,
            layout_manager: new Clutter.BinLayout(),
        });

        // background
        const bg = new St.Widget({
            reactive: false,
            can_focus: false,
        });
        bg.set_style(`
            background-color: rgba(255,255,255,0.06);
            border-radius: 14px;
            border: 1px solid rgba(255,255,255,0.08);
        `);
        cell.add_child(bg);

        // stage for clones (Clutter actors)
        const stage = new Clutter.Actor({
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
            clip_to_allocation: true,
        });
        cell.add_child(stage);

        const applyFixedSizing = () => {
            try {
                cell.set_size(cellW, cellH);
                bg.set_size(cellW, cellH);
                stage.set_size(cellW, cellH);
            } catch (_) {}
        };

    // Apply immediately so preferred size is correct even for empty workspaces
        applyFixedSizing();

        // workspace number overlay label
        const wsLabel = new St.Label({ text: `${workspaceIndex + 1}` });
        wsLabel.set_style(`
            padding: 2px 7px;
            border-radius: 999px;
            background-color: rgba(0,0,0,0.35);
            color: rgba(255,255,255,0.92);
            font-weight: 800;
            font-size: 11px;
        `);

        // container to position label (top-left)
        const wsLabelWrap = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
        });
        wsLabelWrap.add_child(wsLabel);
        cell.add_child(wsLabelWrap);

        // Place label via idle so it has allocation
        this._addIdle(() => {
            if (!stillValid()) return GLib.SOURCE_REMOVE;
            try {
                wsLabelWrap.set_position(10, 10);
            } catch (_) {}
            return GLib.SOURCE_REMOVE;
        });

        //const wsObj = global.workspace_manager.get_workspace_by_index(workspaceIndex);

        const windows = this._getNormalWindows()
            .filter((w) => w.meta.get_monitor?.() === monitorIndex)
            .filter((w) => {
                // Exclude minimized + not actually displayed on its workspace
                if (w.meta.minimized) return false;

                // Sticky windows belong everywhere; if you don't want them in every cell, exclude them:
                if (w.meta.is_on_all_workspaces?.()) return false;

                // Robust membership check
                if (w.meta.located_on_workspace?.(wsObj)) return true;

                const wws = w.meta.get_workspace?.();
                return wws ? wws === wsObj : false;
            })
            .slice(0, this._maxClonesPerCell);

        // If no windows: show a subtle dot/placeholder
        if (!windows.length) {
            const empty = new St.Label({ text: "—" });
            empty.set_style(`
                color: rgba(255,255,255,0.28);
                font-weight: 900;
                font-size: 18px;
            `);
            const wrap = new St.Widget({ layout_manager: new Clutter.BinLayout() });
            wrap.add_child(empty);
            cell.add_child(wrap);

            this._addIdle(() => {
                if (!stillValid()) return GLib.SOURCE_REMOVE;
                try {
                    wrap.set_position(Math.round(cellW / 2) - 6, Math.round(cellH / 2) - 12);
                } catch (_) {}
                return GLib.SOURCE_REMOVE;
            });

            return cell;
        }

        // Adaptive layout:
        // 1 -> full
        // 2 -> 2-up
        // 3 -> 3-up
        // 4+ -> 2x2
        const count = windows.length;

        // Auto-grid: near-square
        const MAX_COLS = 4; // or a setting
        let gridCols = Math.ceil(Math.sqrt(count));
        gridCols = Math.min(MAX_COLS, Math.max(1, gridCols));
        let gridRows = Math.max(1, Math.ceil(count / gridCols));

        if (count === 3) { gridCols = 3; gridRows = 1; } // optional preference

        const pad = 10;
        const usableW = Math.max(1, cellW - pad * 2);
        const usableH = Math.max(1, cellH - pad * 2);

        // Slot size
        const slotW = Math.floor(usableW / gridCols);
        const slotH = Math.floor(usableH / gridRows);

        // Slightly different “fill” depending on layout.
        // - For 1 window, we want it big (closer to 100% of the cell)
        // - For others, keep the current 95% padding vibe
        const fillFactor = (count === 1) ? 0.995 : 0.95;

        for (let i = 0; i < count; i++) {
            const { actor: srcActor, meta } = windows[i];

            // Some actors can become invalid mid-frame; guard it
            try { srcActor.get_parent?.(); } catch (_) { continue; }

            // Frame size is more reliable than actor.get_size() for non-mapped
            let aw = 0, ah = 0;
            try {
                const r = meta.get_frame_rect?.();
                if (r) { aw = r.width; ah = r.height; }
            } catch (_) {}

            // Fallback sizing if we couldn't read frame rect
            if (aw <= 0 || ah <= 0) {
                try { [aw, ah] = srcActor.get_size(); } catch (_) {}
            }
            if (aw <= 0 || ah <= 0) {
                aw = 800; ah = 600;
            }

            // Clone the compositor actor (GNOME thumbnail way)
            const clone = new Clutter.Clone({
                source: srcActor,
                reactive: false,
            });

            // Grid position
            const col = i % gridCols;
            const row = Math.floor(i / gridCols);

            const x = pad + col * slotW;
            const y = pad + row * slotH;

            // Fit-to-slot preserving aspect ratio
            const fitW = Math.max(1, Math.floor(slotW * fillFactor));
            const fitH = Math.max(1, Math.floor(slotH * fillFactor));

            const scale = Math.min(fitW / aw, fitH / ah);

            const drawW = Math.max(1, Math.floor(aw * scale));
            const drawH = Math.max(1, Math.floor(ah * scale));

            clone.set_size(drawW, drawH);
            clone.set_position(
                x + Math.floor((slotW - drawW) / 2),
                y + Math.floor((slotH - drawH) / 2)
            );

            stage.add_child(clone);
        }

        // Make bg fill cell
        this._addIdle(() => {
            if (!stillValid()) return GLib.SOURCE_REMOVE;
            try {
                cell.set_size(cellW, cellH);
                bg.set_size(cellW, cellH);
                stage.set_size(cellW, cellH);
            } catch (_) {}
            return GLib.SOURCE_REMOVE;
        });

        return cell;
    }
    _realWorkspaceForVirtual(monitorIndex, virtualIndex, virtualByMonitor0, nWorkspaces) {
        const activeReal = global.workspace_manager.get_active_workspace_index();
        const currentVirtual = virtualByMonitor0?.[monitorIndex] ?? activeReal;

        const offset = activeReal - currentVirtual;
        return wrapIndex0Based(virtualIndex + offset, nWorkspaces);
    }

    _showOnMonitor({ virtualByMonitor0, monitorIndex, highlightActiveIndex, nWorkspaces }) {
        const gen = this._gen;
        const monitors = Main.layoutManager.monitors ?? [];
        const mon = monitors[monitorIndex] ?? Main.layoutManager.primaryMonitor;
        if (!mon) return;

        const root = new St.BoxLayout({ vertical: true, reactive: false, can_focus: false });
        root.opacity = 0;
        root.set_style(`
            padding: 12px 12px;
            border-radius: 18px;
            background-color: rgba(0,0,0,0.52);
            border: 1px solid rgba(255,255,255,0.10);
            box-shadow: 0 14px 40px rgba(0,0,0,0.45);
        `);

        const rowWrap = new St.BoxLayout({ vertical: false });

        const isActiveRow = monitorIndex === highlightActiveIndex;
        rowWrap.set_style(`
            padding: 8px 8px;
            border-radius: 14px;
            background-color: ${isActiveRow ? "rgba(74,222,128,0.10)" : "rgba(255,255,255,0.03)"};
            border: 1px solid ${isActiveRow ? "rgba(74,222,128,0.22)" : "rgba(255,255,255,0.06)"};
        `);

        const disp = this.labeler.getLabel(monitorIndex);
        const title = new St.Label({ text: `D${disp}` });
        title.set_style(`
            margin-right: 10px;
            padding: 6px 10px;
            border-radius: 999px;
            background-color: rgba(255,255,255,0.06);
            color: rgba(255,255,255,0.92);
            font-weight: 900;
            font-size: 12px;
        `);
        rowWrap.add_child(title);

        const row = new St.BoxLayout({ vertical: false });
        row.set_style(`spacing: ${this._gap}px;`);
        rowWrap.add_child(row);

        const selectedWs = virtualByMonitor0?.[monitorIndex] ?? 0;

        for (let w = 0; w < nWorkspaces; w++) {
            const cell = this._buildCellContent(
                monitorIndex, w,
                this._cellW, this._cellH,
                virtualByMonitor0, nWorkspaces
            );

            const isSelected = w === selectedWs;

            const cellWrap = new St.Widget({
                reactive: false,
                can_focus: false,
                layout_manager: new Clutter.BinLayout(),
            });

            // keep all cells big even if empty
            try { cellWrap.set_size(this._cellW + 4, this._cellH + 4); } catch (_) {}

            cellWrap.add_child(cell);
            cellWrap.set_style(`
                border-radius: 16px;
                padding: 2px;
                background-color: ${isSelected ? "rgba(74,222,128,0.22)" : "rgba(255,255,255,0.00)"};
                border: 1px solid ${isSelected ? "rgba(74,222,128,0.35)" : "rgba(255,255,255,0.00)"};
            `);

            row.add_child(cellWrap);
        }

        root.add_child(rowWrap);

        Main.layoutManager.addChrome(root, { affectsInputRegion: false, trackFullscreen: true });
        this._actors.set(monitorIndex, root);

        // position bottom-center inside that monitor
        this._addIdle(() => {
            const actor = this._actors.get(monitorIndex);
            if (!actor || gen !== this._gen) return GLib.SOURCE_REMOVE;

            const [, natW] = actor.get_preferred_width(-1);
            const [, natH] = actor.get_preferred_height(natW);

            const x = Math.round(mon.x + (mon.width - natW) / 2);
            const y = Math.round(mon.y + mon.height - natH - 36);

            if (!this._actors.get(monitorIndex) || gen !== this._gen) return GLib.SOURCE_REMOVE;

            actor.set_position(x, y);
            actor.opacity = 0;
            actor.ease({
                opacity: 255,
                duration: 120,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });

            return GLib.SOURCE_REMOVE;
        });
    }

    _showImpl({ virtualByMonitor0, activeMonitorIndex, nWorkspaces }) {
        this.destroy();

        const gen = this._gen;

        const monitors = Main.layoutManager.monitors ?? [];
        const monitorCount = monitors.length || 1;

        const showAllDisplays = this._showOnAllDisplays();
        const showAllRows = this._showAllMonitorRows();

        // Decide which overlay roots to create
        const targetMonitors = showAllDisplays
            ? [...Array(monitorCount).keys()]          // 0..N-1
            : [activeMonitorIndex];                   // only active display

        for (const targetMonitorIndex of targetMonitors) {
            // Root container for THIS display
            const root = new St.BoxLayout({
                vertical: true,
                reactive: false,
                can_focus: false,
            });

            root.opacity = 0;

            root.set_style(`
                padding: 12px 12px;
                border-radius: 18px;
                background-color: rgba(0,0,0,0.52);
                border: 1px solid rgba(255,255,255,0.10);
                box-shadow: 0 14px 40px rgba(0,0,0,0.45);
            `);

            // Which rows to show inside this root?
            // - If showing on all displays: ALWAYS only that display’s row
            // - If only on active display: either only active row OR all rows (toggle)
            const rowsToShow = showAllDisplays
                ? [targetMonitorIndex]
                : (showAllRows ? [...Array(monitorCount).keys()] : [activeMonitorIndex]);

            for (const m of rowsToShow) {
                const isActiveMonitorRow = (m === activeMonitorIndex);

                const rowWrap = new St.BoxLayout({ vertical: false });
                rowWrap.set_style(`
                    padding: 8px 8px;
                    border-radius: 14px;
                    background-color: ${isActiveMonitorRow ? this.accent.rgba(0.14) : "rgba(255,255,255,0.03)"};
                    border: 1px solid ${isActiveMonitorRow ? this.accent.rgba(0.30) : "rgba(255,255,255,0.06)"};
                `);

                const disp = this.labeler.getLabel(m);
                const title = new St.Label({ text: `D${disp}` });
                title.set_style(`
                    margin-right: 10px;
                    padding: 6px 10px;
                    border-radius: 999px;
                    background-color: rgba(255,255,255,0.06);
                    color: rgba(255,255,255,0.92);
                    font-weight: 900;
                    font-size: 12px;
                `);
                rowWrap.add_child(title);

                const row = new St.BoxLayout({ vertical: false });
                row.set_style(`spacing: ${this._gap}px;`);
                rowWrap.add_child(row);

                const selectedWs = virtualByMonitor0?.[m] ?? 0;

                for (let w = 0; w < nWorkspaces; w++) {
                    const cell = this._buildCellContent(
                        m, w,
                        this._cellW, this._cellH,
                        virtualByMonitor0, nWorkspaces
                    );

                    const isSelected = w === selectedWs;

                    const cellWrap = new St.Widget({
                        reactive: false,
                        can_focus: false,
                        layout_manager: new Clutter.BinLayout(),
                    });
                    cellWrap.add_child(cell);

                    // Accent highlight for selected workspace
                    cellWrap.set_style(`
                        border-radius: 16px;
                        padding: 2px;
                        background-color: ${isSelected ? this.accent.rgba(0.22) : "rgba(255,255,255,0.00)"};
                        border: 1px solid ${isSelected ? this.accent.rgba(0.40) : "rgba(255,255,255,0.00)"};
                    `);

                    row.add_child(cellWrap);
                }

                root.add_child(rowWrap);

                // Spacer between rows (only if we are showing multiple rows)
                if (rowsToShow.length > 1 && m !== rowsToShow[rowsToShow.length - 1]) {
                    const spacer = new St.Widget({ reactive: false, can_focus: false });
                    spacer.set_style(`height: ${this._rowGap}px;`);
                    root.add_child(spacer);
                }
            }

            Main.layoutManager.addChrome(root, {
                affectsInputRegion: false,
                trackFullscreen: true,
            });

            this._actors.push(root);

            // Position bottom center *of the target monitor*
            this._addIdle(() => {
                if (gen !== this._gen) return GLib.SOURCE_REMOVE;

                const mon = monitors?.[targetMonitorIndex] ?? Main.layoutManager.primaryMonitor;
                if (!mon) return GLib.SOURCE_REMOVE;

                const [, natW] = root.get_preferred_width(-1);
                const [, natH] = root.get_preferred_height(natW);

                const x = Math.round(mon.x + (mon.width - natW) / 2);
                const y = Math.round(mon.y + mon.height - natH - 36);

                try {
                    root.set_position(x, y);
                    root.opacity = 0;
                    root.ease({
                        opacity: 255,
                        duration: 120,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                } catch (_) {}

                return GLib.SOURCE_REMOVE;
            });
        }

        this._scheduleHide();
    }

    show({ virtualByMonitor0, activeMonitorIndex, nWorkspaces }) {
        log(`[AMW] overlay show requested for monitor ${activeMonitorIndex}`);
        try {
            this._showImpl({ virtualByMonitor0:virtualByMonitor0, activeMonitorIndex:activeMonitorIndex, nWorkspaces:nWorkspaces });
        } catch (e) {
            logError(e, "WorkspaceThumbOverlay.show crashed");
        }
    }
}

class VirtualWorkspaceTracker {
    constructor(panelIndicator) {
        this.panel = panelIndicator;
        this.nWorkspaces = 1;
        this.monitorCount = 1;
        this.virtualByMonitor0 = [0];
    }

    refresh() {
        this.nWorkspaces = global.workspace_manager.get_n_workspaces();
        this.monitorCount = Main.layoutManager.monitors?.length || 1;

        if (this.virtualByMonitor0.length !== this.monitorCount) {
            const active = global.workspace_manager.get_active_workspace_index();
            this.virtualByMonitor0 = Array(this.monitorCount).fill(active);
        }
    }

    initToActiveAll() {
        this.refresh();
        const active = global.workspace_manager.get_active_workspace_index();
        this.virtualByMonitor0 = Array(this.monitorCount).fill(active);
    }

    setFocusedToActiveWorkspace(monitorIndex) {
        this.refresh();
        const active = global.workspace_manager.get_active_workspace_index();
        if (monitorIndex >= 0 && monitorIndex < this.monitorCount) {
            this.virtualByMonitor0[monitorIndex] = active;
        }
    }

    shiftMonitor(monitorIndex, direction) {
        this.refresh();
        if (monitorIndex < 0 || monitorIndex >= this.monitorCount) return;
        this.virtualByMonitor0[monitorIndex] = wrapIndex0Based(
            this.virtualByMonitor0[monitorIndex] + direction,
            this.nWorkspaces
        );
    }

    getVirtual(monitorIndex) {
        this.refresh();
        return this.virtualByMonitor0[monitorIndex] ?? 0;
    }

    updatePanel(activeMonitorIndex, visibleCount) {
        this.refresh();
        this.panel.setActiveMonitorIndex(activeMonitorIndex);
        this.panel.update({
            virtualByMonitor0: this.virtualByMonitor0,
            focusedMonitorIndex: activeMonitorIndex,
            focusedVisibleCount: visibleCount,
        });
    }
}

class WindowWrapper {
    constructor(windowActor) {
        this.metaWindow = windowActor.get_meta_window();
        this.windowType = this.metaWindow.get_window_type();
        this.monitorIndex = this.metaWindow.get_monitor();
    }
    isNormal() {
        return this.windowType === Meta.WindowType.NORMAL;
    }
    getWorkspaceIndex() {
        return this.metaWindow.get_workspace().index();
    }
    getMonitorIndex() {
        return this.monitorIndex;
    }
    moveToWorkSpace(nextIndex) {
        this.metaWindow.change_workspace_by_index(nextIndex, false);
    }
}

class ConfigurationService {
    constructor() {
        this.staticWorkspaces = false;
        this.spanDisplays = false;
    }
    conditionallyEnableAutomaticSwitching() {
        this.staticWorkspaces = !Meta.prefs_get_dynamic_workspaces();
        this.spanDisplays = !Meta.prefs_get_workspaces_only_on_primary();
    }
    automaticSwitchingIsEnabled() {
        return this.staticWorkspaces && this.spanDisplays;
    }
}

class WorkSpacesService {
    constructor({ configurationService, osd, tracker, labeler, monitorResolver, overlay }) {
        this.configurationService = configurationService;
        this.osd = osd;
        this.tracker = tracker;
        this.labeler = labeler;
        this.monitorResolver = monitorResolver;
        this.overlay = overlay;

        this.activeWorkspaceIndex = global.workspace_manager.get_active_workspace_index();
    }

    getWindowWrappers() {
        return global.get_window_actors().map((x) => new WindowWrapper(x));
    }

    moveWindowByDirection(windowWrapper, direction) {
        const n = global.workspace_manager.get_n_workspaces();
        const nextWs = (n + windowWrapper.getWorkspaceIndex() + direction) % n;
        windowWrapper.moveToWorkSpace(nextWs);
    }

    countNormalWindowsOnMonitorInWorkspace(monitorIndex, workspaceIndex) {
        return this.getWindowWrappers()
            .filter((w) => w.isNormal())
            .filter((w) => w.getMonitorIndex() === monitorIndex)
            .filter((w) => w.getWorkspaceIndex() === workspaceIndex).length;
    }

    _laterAdd(type, fn) {
        // 1) Older GNOME: Meta.later_add
        if (Meta.later_add) {
            return Meta.later_add(type, fn);
        }

        // 2) Newer GNOME: global.compositor.get_laters().add
        const laters = global.compositor?.get_laters?.();
        if (laters?.add) {
            return laters.add(type, fn);
        }

        // 3) Fallback: just do it next idle (not as good, but never crashes)
        return GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    _showOverlay(activeMonitorIndex) {
        try {
            this.tracker.refresh();
            this.overlay?.show({
                virtualByMonitor0: this.tracker.virtualByMonitor0,
                activeMonitorIndex: activeMonitorIndex,
                nWorkspaces: this.tracker.nWorkspaces,
            });
        } catch (e) {
            logError(e, "WorkspaceThumbOverlay.show failed");
        }
    }

    _showOverlayDeferred(activeMonitorIndex) {
        this._laterAdd(Meta.LaterType.BEFORE_REDRAW, () => {
            this._showOverlay(activeMonitorIndex);
            return GLib.SOURCE_REMOVE;
        });
    }

    onGlobalWorkspaceChanged() {
        if (!this.configurationService.automaticSwitchingIsEnabled()) return;

        const nextWorkspace = global.workspace_manager.get_active_workspace_index();
        const direction =
            nextWorkspace > this.activeWorkspaceIndex ? Direction.DOWN : Direction.UP;

        const diff =
            nextWorkspace > this.activeWorkspaceIndex
                ? nextWorkspace - this.activeWorkspaceIndex
                : this.activeWorkspaceIndex - nextWorkspace;

        const shift = direction * diff;

        const activeMonitorIndex = this.monitorResolver.resolve();
        this.tracker.setFocusedToActiveWorkspace(activeMonitorIndex);

        const wrappers = this.getWindowWrappers();
        wrappers
            .filter((w) => w.isNormal())
            .filter((w) => w.getMonitorIndex() !== activeMonitorIndex)
            .forEach((w) => this.moveWindowByDirection(w, -shift));

        const visibleNowCount = this.countNormalWindowsOnMonitorInWorkspace(
            activeMonitorIndex,
            nextWorkspace
        );
        this.tracker.updatePanel(activeMonitorIndex, visibleNowCount);

        // Show overlay reflecting updated state
        this._showOverlayDeferred(activeMonitorIndex);

        this.activeWorkspaceIndex = nextWorkspace;
    }

    switchWorkspaceOnActiveMonitor(direction) {
        const activeMonitorIndex = this.monitorResolver.resolve();
        const n = global.workspace_manager.get_n_workspaces();
        const activeWs = global.workspace_manager.get_active_workspace_index();

        const currentVirtual = this.tracker.getVirtual(activeMonitorIndex);
        const targetVirtual = wrapIndex0Based(currentVirtual + direction, n);

        const sourceWsThatBecomesVisible = wrapIndex0Based(activeWs + direction, n);

        const willBeVisibleCount = this.countNormalWindowsOnMonitorInWorkspace(
            activeMonitorIndex,
            sourceWsThatBecomesVisible
        );

        const disp = this.labeler.getLabel(activeMonitorIndex);
        const fromHuman = currentVirtual + 1;
        const toHuman = targetVirtual + 1;
        const arrow = direction === Direction.DOWN ? "→" : "←";

        this.osd.showOnMonitor(
            activeMonitorIndex,
            `Display ${disp} · ${fromHuman} ${arrow} ${toHuman}  ·  ${willBeVisibleCount} window${
                willBeVisibleCount === 1 ? "" : "s"
            }`,
            direction
        );

        const wrappers = this.getWindowWrappers()
            .filter((w) => w.isNormal())
            .filter((w) => w.getMonitorIndex() === activeMonitorIndex);

        wrappers.forEach((w) => this.moveWindowByDirection(w, -direction));

        this.tracker.shiftMonitor(activeMonitorIndex, direction);
        this.tracker.updatePanel(activeMonitorIndex, willBeVisibleCount);

        // Show overlay AFTER the move so thumbnails reflect reality
        this._showOverlayDeferred(activeMonitorIndex);
    }
}

export default class SwitchWorkspacesExtension extends Extension {
    enable() {
        if (this.state) return;

        const settings = this.getSettings();
        const accent = new AccentColor(settings);
        const labeler = new MonitorLabeler(settings);
        const panelIndicator = new WorkspacePanelIndicator(labeler, accent);
        panelIndicator.enable();

        const tracker = new VirtualWorkspaceTracker(panelIndicator);
        tracker.initToActiveAll();

        const osd = new WorkspaceOsd();
        const overlay = new WorkspaceThumbOverlay(labeler, accent, settings);

        const configurationService = new ConfigurationService();
        configurationService.conditionallyEnableAutomaticSwitching();

        let monitorResolver = null;

        const workspaceServiceHolder = { svc: null };

        const refreshPill = () => {
            if (!monitorResolver || !workspaceServiceHolder.svc) return;

            const activeMonitorIndex = monitorResolver.resolve();
            const activeWs = global.workspace_manager.get_active_workspace_index();
            const visibleNowCount =
                workspaceServiceHolder.svc.countNormalWindowsOnMonitorInWorkspace(
                    activeMonitorIndex,
                    activeWs
                );

            tracker.updatePanel(activeMonitorIndex, visibleNowCount);
        };

        monitorResolver = new MonitorResolver(settings, () => refreshPill());

        const workspaceService = new WorkSpacesService({
            configurationService,
            osd,
            tracker,
            labeler,
            monitorResolver,
            overlay,
        });
        workspaceServiceHolder.svc = workspaceService;

        const modeType = Shell.ActionMode.ALL;

        Main.wm.addKeybinding(
            HOTKEY_NEXT,
            settings,
            Meta.KeyBindingFlags.NONE,
            modeType,
            () => workspaceService.switchWorkspaceOnActiveMonitor(Direction.DOWN)
        );

        Main.wm.addKeybinding(
            HOTKEY_PREVIOUS,
            settings,
            Meta.KeyBindingFlags.NONE,
            modeType,
            () => workspaceService.switchWorkspaceOnActiveMonitor(Direction.UP)
        );

        Main.wm.addKeybinding(
            HOTKEY_TOGGLE_MODE,
            settings,
            Meta.KeyBindingFlags.NONE,
            modeType,
            () => {
                const newMode = monitorResolver.toggleMode();
                const activeMonitorIndex = monitorResolver.resolve();
                osd.showOnMonitor(
                    activeMonitorIndex,
                    `Monitor select mode: ${newMode === "pointer" ? "Pointer" : "Focus"}`,
                    Direction.DOWN
                );
                refreshPill();
            }
        );

        const activeWsChangedId = global.workspace_manager.connect(
            "active-workspace-changed",
            () => {
                configurationService.conditionallyEnableAutomaticSwitching();
                workspaceService.onGlobalWorkspaceChanged();
                refreshPill();
            }
        );

        const focusChangedId = global.display.connect("notify::focus-window", refreshPill);
        const windowCreatedId = global.display.connect("window-created", refreshPill);

        const monitorsChangedId = Main.layoutManager.connect("monitors-changed", () => {
            tracker.refresh();
            refreshPill();
        });

        const nWorkspacesChangedId = global.workspace_manager.connect(
            "notify::n-workspaces",
            () => {
                tracker.refresh();
                refreshPill();
            }
        );

        const modeChangedId = settings.connect("changed::monitor-selection-mode", refreshPill);
        const pillChangedId = settings.connect("changed::pill-mode", refreshPill);
        const labelsChangedId = settings.connect("changed::monitor-labels", refreshPill);
        const useLabelsChangedId = settings.connect(
            "changed::use-custom-monitor-labels",
            refreshPill
        );

        //refreshPill();
        const accentChanged = () => refreshPill();

        const useAccentChangedId = settings.connect("changed::use-system-accent-color", accentChanged);
        const overlayAllDisplaysChangedId = settings.connect("changed::overlay-show-on-all-displays", accentChanged);
        const overlayAllMonitorsChangedId = settings.connect("changed::overlay-show-all-monitors", accentChanged);

        this.state = {
            settings,
            monitorResolver,
            panelIndicator,
            tracker,
            osd,
            overlay,
            configurationService,
            workspaceService,
            activeWsChangedId,
            focusChangedId,
            windowCreatedId,
            monitorsChangedId,
            nWorkspacesChangedId,
            modeChangedId,
            pillChangedId,
            labelsChangedId,
            useLabelsChangedId,
            useAccentChangedId,
            overlayAllDisplaysChangedId,
            overlayAllMonitorsChangedId,
        };
    }

    disable() {
        if (!this.state) return;

        Main.wm.removeKeybinding(HOTKEY_NEXT);
        Main.wm.removeKeybinding(HOTKEY_PREVIOUS);
        Main.wm.removeKeybinding(HOTKEY_TOGGLE_MODE);

        global.workspace_manager.disconnect(this.state.activeWsChangedId);
        global.workspace_manager.disconnect(this.state.nWorkspacesChangedId);
        Main.layoutManager.disconnect(this.state.monitorsChangedId);
        global.display.disconnect(this.state.focusChangedId);
        global.display.disconnect(this.state.windowCreatedId);

        this.state.settings.disconnect(this.state.modeChangedId);
        this.state.settings.disconnect(this.state.pillChangedId);
        this.state.settings.disconnect(this.state.labelsChangedId);
        this.state.settings.disconnect(this.state.useLabelsChangedId);

        this.state.settings.disconnect(this.state.useAccentChangedId);
        this.state.settings.disconnect(this.state.overlayAllDisplaysChangedId);
        this.state.settings.disconnect(this.state.overlayAllMonitorsChangedId);

        this.state.osd.destroy();
        this.state.overlay.destroy();
        this.state.panelIndicator.disable();
        this.state.monitorResolver.destroy();

        this.state = null;
    }
}