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

import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import GObject from "gi://GObject";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

function asAccelStrv(accelString) {
    const s = String(accelString ?? "").trim();
    return s.length ? [s] : [];
}

function accelStrvToSingle(strv) {
    if (!strv || !strv.length) return "";
    return String(strv[0] ?? "");
}

function bindAccelEntryToStrvSetting(settings, keyName, entry) {
    // Initialize from current setting
    entry.set_text(accelStrvToSingle(settings.get_strv(keyName)));

    const commit = () => {
        settings.set_strv(keyName, asAccelStrv(entry.get_text()));
    };

    // Save on Enter
    entry.connect("activate", commit);

    // Save when focus is lost (GTK4 way)
    entry.connect("notify::has-focus", () => {
        if (!entry.get_has_focus()) commit();
    });

    // If setting changes elsewhere, reflect it in the UI
    const changedId = settings.connect(`changed::${keyName}`, () => {
        const current = accelStrvToSingle(settings.get_strv(keyName));
        if (entry.get_text() !== current) entry.set_text(current);
    });

    return changedId;
}

export default class Prefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_title("Active Monitor Workspaces Settings");
        window.set_default_size(600, 560);

        const page = new Adw.PreferencesPage();
        window.add(page);

        // Keep ids to disconnect on close
        const disconnectIds = [];

        // -------------------------
        // General
        // -------------------------
        const general = new Adw.PreferencesGroup({ title: "General" });
        page.add(general);

        const useCustomRow = new Adw.SwitchRow({
            title: "Use custom display labels",
            subtitle:
                "Override GNOME’s internal monitor numbering with your own labels (e.g. Display 1 / Display 2).",
        });
        general.add(useCustomRow);
        settings.bind(
            "use-custom-monitor-labels",
            useCustomRow,
            "active",
            GObject.BindingFlags.DEFAULT
        );

        const selModeRow = new Adw.ComboRow({
            title: "Active monitor selection",
            subtitle:
                "Pointer is most stable. Focus can jump when a monitor becomes empty.",
            model: Gtk.StringList.new(["pointer (mouse)", "focus (active window)"]),
        });
        general.add(selModeRow);

        const selChoices = ["pointer", "focus"];
        selModeRow.set_selected(
            Math.max(0, selChoices.indexOf(settings.get_string("monitor-selection-mode")))
        );
        selModeRow.connect("notify::selected", () => {
            settings.set_string("monitor-selection-mode", selChoices[selModeRow.get_selected()]);
        });

        const pillModeRow = new Adw.ComboRow({
            title: "Top bar indicator",
            model: Gtk.StringList.new(["all monitors", "focused monitor only"]),
        });
        general.add(pillModeRow);

        const pillChoices = ["all", "focused"];
        pillModeRow.set_selected(
            Math.max(0, pillChoices.indexOf(settings.get_string("pill-mode")))
        );
        pillModeRow.connect("notify::selected", () => {
            settings.set_string("pill-mode", pillChoices[pillModeRow.get_selected()]);
        });

        // -------------------------
        // Shortcuts
        // -------------------------
        const shortcuts = new Adw.PreferencesGroup({
            title: "Shortcuts",
            description:
                "Use GNOME accelerator strings like <Control><Alt>Up. Press Enter or click away to save.",
        });
        page.add(shortcuts);

        const makeShortcutRow = (title, keyName) => {
            const row = new Adw.ActionRow({ title, subtitle: keyName });

            const entry = new Gtk.Entry({
                width_chars: 24,
                hexpand: false,
            });

            // bind entry to strv setting
            const id = bindAccelEntryToStrvSetting(settings, keyName, entry);
            disconnectIds.push(id);

            row.add_suffix(entry);
            row.set_activatable_widget(entry);
            return row;
        };

        shortcuts.add(
            makeShortcutRow(
                "Previous (rotate up)",
                "switch-to-previous-workspace-on-active-monitor"
            )
        );
        shortcuts.add(
            makeShortcutRow(
                "Next (rotate down)",
                "switch-to-next-workspace-on-active-monitor"
            )
        );
        shortcuts.add(
            makeShortcutRow(
                "Toggle Pointer/Focus mode",
                "toggle-monitor-selection-mode"
            )
        );

        // -------------------------
        // Monitor label mapping
        // -------------------------
        const mapGroup = new Adw.PreferencesGroup({
            title: "Display label mapping",
            description:
                "These labels are indexed by GNOME monitor index (0, 1, 2…). If your labels appear swapped, set them here.",
        });
        page.add(mapGroup);

        const listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ["boxed-list"],
        });

        const listRow = new Adw.PreferencesRow();
        listRow.set_child(listBox);
        mapGroup.add(listRow);

        const buttonRow = new Adw.ActionRow({
            title: "Actions",
            subtitle: "Quick tools for editing the mapping",
        });
        mapGroup.add(buttonRow);

        const swapBtn = new Gtk.Button({ label: "Swap first two" });
        const addBtn = new Gtk.Button({ label: "Add label" });
        const clearBtn = new Gtk.Button({ label: "Clear mapping" });

        const btnBox = new Gtk.Box({ spacing: 8 });
        btnBox.append(swapBtn);
        btnBox.append(addBtn);
        btnBox.append(clearBtn);
        buttonRow.add_suffix(btnBox);

        const rebuild = () => {
            let child;
            while ((child = listBox.get_first_child())) listBox.remove(child);

            const labels = settings.get_strv("monitor-labels");
            const rows = Math.max(labels.length, 2);

            for (let i = 0; i < rows; i++) {
                const label = labels[i] ?? `${i + 1}`;

                const row = new Adw.ActionRow({
                    title: `GNOME monitor index ${i}`,
                    subtitle: "Label shown in the pill/OSD for this monitor index.",
                });

                const entry = new Gtk.Entry({
                    text: label,
                    width_chars: 8,
                    hexpand: false,
                });

                entry.connect("changed", () => {
                    const updated = settings.get_strv("monitor-labels");
                    while (updated.length <= i) updated.push("");
                    updated[i] = entry.get_text();
                    settings.set_strv("monitor-labels", updated);
                });

                row.add_suffix(entry);
                row.set_activatable_widget(entry);

                const deleteBtn = new Gtk.Button({ label: "Remove" });
                deleteBtn.connect("clicked", () => {
                    const updated = settings.get_strv("monitor-labels");
                    if (i < updated.length) {
                        updated.splice(i, 1);
                        settings.set_strv("monitor-labels", updated);
                        rebuild();
                    }
                });
                row.add_suffix(deleteBtn);

                listBox.append(row);
            }
        };

        rebuild();

        const labelsChangedId = settings.connect("changed::monitor-labels", rebuild);
        disconnectIds.push(labelsChangedId);

        swapBtn.connect("clicked", () => {
            const labels = settings.get_strv("monitor-labels");
            while (labels.length < 2) labels.push("");
            [labels[0], labels[1]] = [labels[1], labels[0]];
            settings.set_strv("monitor-labels", labels);
        });

        addBtn.connect("clicked", () => {
            const labels = settings.get_strv("monitor-labels");
            labels.push(`${labels.length + 1}`);
            settings.set_strv("monitor-labels", labels);
        });

        clearBtn.connect("clicked", () => settings.set_strv("monitor-labels", []));

        // Disconnect signals when window closes
        window.connect("close-request", () => {
            for (const id of disconnectIds) {
                try {
                    settings.disconnect(id);
                } catch (_) {}
            }
            disconnectIds.length = 0;
            return false;
        });
    }
}
