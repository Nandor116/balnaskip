"use strict";

/*
 * BálnaSkip popup.
 *
 * The popup is only a remote control for the content script: the transcript,
 * trigger detection, skip and undo state all live in the content script so the
 * popup can be closed at any time without interrupting playback.
 */
(function () {
  const POLL_INTERVAL_MS = 1000;
  const STATUS_FALLBACKS = {
    inactive: {
      label: "Nem YouTube-videó",
      detail: "Nyiss meg egy Súlytalan-videót a YouTube-on.",
    },
    loading: {
      label: "Felkészülés…",
      detail: "A kiegészítő keresi a trigger mondatot.",
    },
    "other-channel": {
      label: "Nem a Súlytalan csatorna",
      detail: "A kiegészítő csak a Súlytalan videóin aktív.",
    },
    disabled: {
      label: "Kikapcsolva",
      detail: "A kiegészítő nem figyel a videókon.",
    },
    "no-captions": {
      label: "Nincs magyar felirat",
      detail: "A trigger felismeréséhez magyar felirat szükséges.",
    },
    "no-trigger": {
      label: "Nem található a trigger",
      detail: "A videó elején nem hangzott el a trigger mondat.",
    },
    armed: {
      label: "Figyelem a trigger mondatot",
      detail: "A felismerés után 5,5 másodpercet ugrik előre.",
    },
    skipped: {
      label: "Reklám átugorva",
      detail: "5,5 másodperccel előrébb jársz.",
    },
    undone: {
      label: "Visszavonva",
      detail: "A reklám újra látható.",
    },
    missed: {
      label: "A trigger már elhangzott",
      detail: "A videó a trigger után indult, ezért nem ugrottam.",
    },
    error: {
      label: "Hiba",
      detail: "Nem sikerült feldolgozni a videót.",
    },
  };
  const TONE_BY_STATUS = {
    inactive: "neutral",
    "other-channel": "neutral",
    disabled: "neutral",
    loading: "active",
    armed: "active",
    skipped: "success",
    undone: "warn",
    missed: "warn",
    "no-captions": "warn",
    "no-trigger": "warn",
    error: "error",
  };

  const statusCard = document.getElementById("statusCard");
  const statusLabel = document.getElementById("statusLabel");
  const statusDetail = document.getElementById("statusDetail");
  const undoButton = document.getElementById("undoButton");
  const enabledToggle = document.getElementById("enabledToggle");

  let enabled = true;
  let settingsVersion = 0;
  let pollTimer = null;
  let pollInFlight = false;
  let undoInFlight = false;

  function formatTimestamp(value) {
    const totalSeconds = Math.max(0, Math.round(Number(value) || 0));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes + ":" + String(seconds).padStart(2, "0");
  }

  function isYouTubeUrl(url) {
    if (typeof url !== "string" || !url) {
      return false;
    }
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return hostname === "youtube.com" || /\.youtube\.com$/.test(hostname);
    } catch (error) {
      return false;
    }
  }

  function setStatusView(label, detail, tone) {
    statusCard.dataset.tone = tone || "neutral";
    statusLabel.textContent = label;
    statusDetail.textContent = detail || "";
  }

  function setUndoVisible(visible) {
    undoButton.hidden = !visible;
    undoButton.disabled = !visible || undoInFlight;
  }

  function describeStatus(data) {
    const status = data && data.status ? data.status : "inactive";
    const fallback = STATUS_FALLBACKS[status] || {
      label: status || "Ismeretlen állapot",
      detail: "",
    };
    let label = data && data.statusLabel ? data.statusLabel : fallback.label;
    let detail = data && data.detail ? data.detail : fallback.detail;

    if (status === "armed" && data && Number.isFinite(data.triggerTime)) {
      detail =
        "A trigger kb. " +
        formatTimestamp(data.triggerTime) +
        "-nél várható · utána 5,5 mp ugrás.";
    } else if (status === "skipped" && data) {
      detail =
        "A reklám átugorva" +
        (Number.isFinite(data.triggerTime)
          ? " (trigger: " + formatTimestamp(data.triggerTime) + ")"
          : "") +
        ".";
    }

    return {
      label: label,
      detail: detail,
      tone: TONE_BY_STATUS[status] || "neutral",
      canUndo: Boolean(data && data.canUndo),
    };
  }

  function renderStatus(data) {
    if (!enabled) {
      renderDisabled();
      return;
    }
    const view = describeStatus(data);
    setStatusView(view.label, view.detail, view.tone);
    setUndoVisible(view.canUndo);
  }

  function renderDisabled() {
    const fallback = STATUS_FALLBACKS.disabled;
    setStatusView(fallback.label, fallback.detail, "neutral");
    setUndoVisible(false);
  }

  function renderNoPage() {
    const fallback = STATUS_FALLBACKS.inactive;
    setStatusView(fallback.label, fallback.detail, "neutral");
    setUndoVisible(false);
  }

  function renderUnreachable() {
    setStatusView(
      "Az oldal nem válaszol",
      "Töltsd újra a YouTube-oldalt, vagy ellenőrizd, hogy engedélyezve van-e a kiegészítő.",
      "warn"
    );
    setUndoVisible(false);
  }

  function getActiveTab() {
    return browser.tabs
      .query({ active: true, currentWindow: true })
      .then(function (tabs) {
        return tabs && tabs[0] ? tabs[0] : null;
      });
  }

  function sendToTab(tabId, message) {
    return browser.tabs.sendMessage(tabId, message);
  }

  async function refreshStatus() {
    if (pollInFlight) {
      return;
    }
    const version = settingsVersion;
    pollInFlight = true;
    try {
      const tab = await getActiveTab();
      if (version !== settingsVersion) {
        return;
      }
      if (!enabled) {
        renderDisabled();
        return;
      }
      if (!tab) {
        renderNoPage();
        return;
      }
      if (tab.url && !isYouTubeUrl(tab.url)) {
        renderNoPage();
        return;
      }
      if (typeof tab.id !== "number") {
        renderUnreachable();
        return;
      }

      let status = null;
      try {
        status = await sendToTab(tab.id, { type: "BALNA_GET_STATUS" });
      } catch (error) {
        // No content script in this tab, or the page is still loading.
        status = null;
      }
      if (version !== settingsVersion) {
        return;
      }
      if (!status) {
        if (!tab.url) {
          renderNoPage();
        } else {
          renderUnreachable();
        }
        return;
      }
      renderStatus(status);
    } catch (error) {
      console.error("[BálnaSkip] A popup állapotfrissítése nem sikerült.", error);
      renderUnreachable();
    } finally {
      pollInFlight = false;
    }
  }

  function applyLocalEnabled(value, detail) {
    enabled = value;
    enabledToggle.checked = value;
    enabledToggle.setAttribute("aria-checked", value ? "true" : "false");
    if (value) {
      setStatusView("Bekapcsolva", detail || "Állapot ellenőrzése…", "active");
      setUndoVisible(false);
    } else {
      renderDisabled();
    }
  }

  function loadSettings() {
    return browser.storage.local
      .get({ enabled: true })
      .then(function (settings) {
        enabled = settings.enabled !== false;
        enabledToggle.checked = enabled;
        enabledToggle.setAttribute("aria-checked", enabled ? "true" : "false");
      })
      .catch(function () {
        enabled = true;
        enabledToggle.checked = true;
        enabledToggle.setAttribute("aria-checked", "true");
      });
  }

  function saveEnabled(value) {
    settingsVersion += 1;
    applyLocalEnabled(
      value,
      value ? "A videó újraellenőrzése…" : undefined
    );
    browser.storage.local.set({ enabled: value }).catch(function (error) {
      console.error("[BálnaSkip] A beállítás mentése nem sikerült.", error);
      settingsVersion += 1;
      enabled = !value;
      enabledToggle.checked = enabled;
      enabledToggle.setAttribute("aria-checked", enabled ? "true" : "false");
      setStatusView(
        "A beállítást nem sikerült menteni",
        String(error && error.message ? error.message : error),
        "error"
      );
      setUndoVisible(false);
    });
  }

  async function undoLastSkip() {
    if (undoInFlight) {
      return;
    }
    undoInFlight = true;
    setUndoVisible(true);
    undoButton.disabled = true;
    try {
      const tab = await getActiveTab();
      if (!tab || typeof tab.id !== "number") {
        renderNoPage();
        return;
      }
      const response = await sendToTab(tab.id, { type: "BALNA_UNDO_SKIP" });
      if (response && response.status) {
        renderStatus(response.status);
        if (!response.ok) {
          statusDetail.textContent =
            "A visszavonás már nem lehetséges ehhez az ugráshoz.";
        }
      } else {
        statusDetail.textContent = "A visszavonás nem sikerült.";
      }
    } catch (error) {
      setStatusView(
        "Az oldal nem válaszol",
        "A visszavonáshoz nyisd meg újra a YouTube-oldalt.",
        "warn"
      );
      setUndoVisible(false);
    } finally {
      undoInFlight = false;
      if (undoButton.hidden !== true) {
        undoButton.disabled = false;
      }
    }
  }

  enabledToggle.addEventListener("change", function () {
    saveEnabled(enabledToggle.checked);
  });

  undoButton.addEventListener("click", function () {
    undoLastSkip().catch(function (error) {
      console.error("[BálnaSkip] A visszavonás nem sikerült.", error);
    });
  });

  browser.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local" || !changes.enabled) {
      return;
    }
    const next = changes.enabled.newValue !== false;
    if (next === enabled) {
      return;
    }
    settingsVersion += 1;
    enabled = next;
    enabledToggle.checked = next;
    enabledToggle.setAttribute("aria-checked", next ? "true" : "false");
    refreshStatus();
  });

  function bootstrap() {
    loadSettings().then(function () {
      if (!enabled) {
        renderDisabled();
      }
      refreshStatus();
      pollTimer = setInterval(function () {
        refreshStatus();
      }, POLL_INTERVAL_MS);
    });
  }

  window.addEventListener("unload", function () {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });

  bootstrap();
})();
