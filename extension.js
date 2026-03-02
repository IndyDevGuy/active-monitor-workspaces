/*
 * Active Monitor Workspaces
 *
 * Portions of this project were derived from
 * gnome-shell-extension-simulate-switching-workspaces-on-active-monitor
 * Copyright (c) 2019 Xiaoguang Wang
 *
 * Used under the MIT License.
 */

import Clutter from "gi://Clutter";
import Shell from "gi://Shell";
import St from "gi://St";
import Meta from "gi://Meta";
import GLib from "gi://GLib";
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

function findMonitorIndexForPoint(x, y) {
    const monitors = Main.layoutManager.monitors || [];
    for (let i = 0; i < monitors.length; i++) {
        const m = monitors[i];
        if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) {
            return i;
        }
    }

    // If pointer is in a gap (rare), choose nearest monitor by distance to its rect.
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

/**
 * Active monitor resolver:
 * - pointer mode: computed from pointer coords against monitor rects (reliable)
 * - focus mode: monitor of focused normal window, fallback to pointer
 *
 * Also: fast poll loop keeps it responsive even if motion events are delayed.
 */
class MonitorResolver {
    constructor(settings, onActiveMonitorChanged) {
        this.settings = settings;
        this._onActiveMonitorChanged = onActiveMonitorChanged;

        this._lastPointerMonitor = this._computePointerMonitor();
        this._lastResolvedMonitor = this._lastPointerMonitor;

        this._motionId = 0;
        this._pollId = 0;

        // Motion helps, but we do not trust it alone on Wayland.
        this._motionId = global.stage.connect("motion-event", () => {
            this._updatePointerMonitor(true);
            return Clutter.EVENT_PROPAGATE;
        });

        // Poll to avoid “delayed / missed motion updates”
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
                // In pointer mode, this should immediately refresh pill.
                // In focus mode, it's still useful to keep the UI in sync.
                this._onActiveMonitorChanged(cur);
            }
        } else if (forceNotify) {
            // sometimes UI can lag; force a refresh on real motion
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
    constructor(labeler) {
        this.labeler = labeler;
        this._button = null;

        this._pillBox = null;      // container with background/padding
        this._labels = [];         // one label per monitor segment
        this._separators = [];     // spacing labels between segments

        this._activeMonitorIndex = 0;
        this._activeColor = "#4ade80";
    }

    enable() {
        if (this._button) return;

        const btn = new PanelMenu.Button(0.0, "Per-monitor workspaces", false);

        // One rounded “pill” container
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

        // If count matches, nothing to do
        if (this._labels.length === count) return;

        // Rebuild cleanly (simple + reliable)
        this._pillBox.destroy_all_children();
        this._labels = [];
        this._separators = [];

        for (let i = 0; i < count; i++) {
            if (i > 0) {
                const sep = new St.Label({ text: "   " });
                // keep separators slightly dimmer if you want; optional
                sep.set_style(`opacity: 0.85;`);
                this._pillBox.add_child(sep);
                this._separators.push(sep);
            }

            const seg = new St.Label({ text: "" });
            seg.set_y_align(Clutter.ActorAlign.CENTER);
            // give each segment a tiny breathing room so kerning looks nice
            seg.set_style(`margin: 0; padding: 0;`);
            this._pillBox.add_child(seg);
            this._labels.push(seg);
        }
    }

    update({ virtualByMonitor0, focusedMonitorIndex, focusedVisibleCount }) {
        if (!this._pillBox) return;

        const pillMode = this.labeler.getPillMode();

        // Focused mode: show ONE segment only
        if (pillMode === "focused") {
            this._ensureSegments(1);

            const disp = this.labeler.getLabel(focusedMonitorIndex);
            const ws = (virtualByMonitor0?.[focusedMonitorIndex] ?? 0) + 1;
            const w = focusedVisibleCount ?? 0;

            const isActive = focusedMonitorIndex === this._activeMonitorIndex;
            const text = isActive ? `● D${disp} · WS${ws} · ${w}w` : `D${disp} · WS${ws} · ${w}w`;

            this._labels[0].set_text(text);
            this._labels[0].set_style(`
        color: ${isActive ? this._activeColor : "rgba(255,255,255,0.95)"};
        font-weight: 700;
      `);
            return;
        }

        // All mode: one segment per monitor
        const count = (virtualByMonitor0 ?? []).length;
        this._ensureSegments(count);

        for (let idx = 0; idx < count; idx++) {
            const d = this.labeler.getLabel(idx);
            const ws = (virtualByMonitor0?.[idx] ?? 0) + 1;
            const isActive = idx === this._activeMonitorIndex;

            this._labels[idx].set_text(isActive ? `● D${d}:WS${ws}` : `D${d}:WS${ws}`);
            this._labels[idx].set_style(`
        color: ${isActive ? this._activeColor : "rgba(255,255,255,0.95)"};
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
    constructor({ configurationService, osd, tracker, labeler, monitorResolver }) {
        this.configurationService = configurationService;
        this.osd = osd;
        this.tracker = tracker;
        this.labeler = labeler;
        this.monitorResolver = monitorResolver;

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
            .forEach((w) => this.moveWindowByDirection(w, shift));

        const visibleNowCount = this.countNormalWindowsOnMonitorInWorkspace(
            activeMonitorIndex,
            nextWorkspace
        );
        this.tracker.updatePanel(activeMonitorIndex, visibleNowCount);

        this.activeWorkspaceIndex = nextWorkspace;
    }

    switchWorkspaceOnActiveMonitor(direction) {
        const activeMonitorIndex = this.monitorResolver.resolve();
        const n = global.workspace_manager.get_n_workspaces();
        const activeWs = global.workspace_manager.get_active_workspace_index();

        const currentVirtual = this.tracker.getVirtual(activeMonitorIndex);
        const targetVirtual = wrapIndex0Based(currentVirtual + direction, n);

        const sourceWsThatBecomesVisible = wrapIndex0Based(activeWs - direction, n);

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

        wrappers.forEach((w) => this.moveWindowByDirection(w, direction));

        this.tracker.shiftMonitor(activeMonitorIndex, direction);
        this.tracker.updatePanel(activeMonitorIndex, willBeVisibleCount);
    }
}

export default class SwitchWorkspacesExtension extends Extension {
    enable() {
        if (this.state) return;

        const settings = this.getSettings();
        const labeler = new MonitorLabeler(settings);
        const panelIndicator = new WorkspacePanelIndicator(labeler);
        panelIndicator.enable();

        const tracker = new VirtualWorkspaceTracker(panelIndicator);
        tracker.initToActiveAll();

        const osd = new WorkspaceOsd();
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

        // Monitor resolver uses pointer coords + poll for responsiveness
        monitorResolver = new MonitorResolver(settings, () => refreshPill());

        const workspaceService = new WorkSpacesService({
            configurationService,
            osd,
            tracker,
            labeler,
            monitorResolver,
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

        refreshPill();

        this.state = {
            settings,
            monitorResolver,
            panelIndicator,
            tracker,
            osd,
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

        this.state.osd.destroy();
        this.state.panelIndicator.disable();
        this.state.monitorResolver.destroy();

        this.state = null;
    }
}
