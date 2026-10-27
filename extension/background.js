"use strict";

/*
 * BálnaSkip background page.
 *
 * The transcript requests are intentionally made from the content script.
 * YouTube answers InnerTube requests made from an extension origin with a
 * 403 "Sorry..." page, while the same-origin fetch from the YouTube tab works.
 * The content script also keeps the trigger state, so closing the popup cannot
 * interrupt playback.
 */

function ensureDefaultSettings() {
  return browser.storage.local.get("enabled").then(function (settings) {
    if (typeof settings.enabled !== "boolean") {
      return browser.storage.local.set({ enabled: true });
    }
    return undefined;
  });
}

browser.runtime.onInstalled.addListener(function () {
  ensureDefaultSettings().catch(function (error) {
    console.warn("[BálnaSkip] A beállítás inicializálása nem sikerült.", error);
  });
});

browser.runtime.onStartup.addListener(function () {
  ensureDefaultSettings().catch(function () {
    // The content script also defaults to enabled if storage is unavailable.
  });
});
