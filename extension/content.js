"use strict";

/*
 * BálnaSkip content script.
 *
 * Runs on YouTube pages, but only activates on the configured channel.
 * The trigger is read from YouTube's timedtext data, so subtitles do not have
 * to be enabled and the player UI is never modified.
 */
(function () {
  const core = globalThis.BalnaCore;
  const STATUS_LABELS = {
    inactive: "Nem YouTube-videó",
    loading: "Felirat keresése…",
    "other-channel": "Nem a Súlytalan csatorna",
    disabled: "Kikapcsolva",
    "no-captions": "Nincs magyar felirat",
    "no-trigger": "Nem található a trigger",
    armed: "Figyelem a trigger mondatot",
    skipped: "Reklám átugorva",
    undone: "Visszavonva",
    missed: "A trigger már elhangzott",
    error: "Hiba",
  };
  const RETRYABLE_ERRORS = new Set([
    "api-error",
    "fetch-error",
    "internal-error",
    "empty-captions",
    "panel-error",
  ]);
  const TOAST_HOST_ID = "balna-skip-toast-host";
  const PUBLIC_INNERTUBE_KEY =
    "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  const ANDROID_CLIENT_VERSION = "20.10.38";
  const DEFAULT_WEB_CLIENT_VERSION = "2.20261023.01.00";
  const PANEL_ID = "PAmodern_transcript_view";
  const PANEL_START_OFFSET_SECONDS = 0.5;
  const PANEL_PAUSE_BIAS_SECONDS = 1;
  const FETCH_TIMEOUT_MS = 20000;
  const TRANSCRIPT_CACHE_MS = 5 * 60 * 1000;
  const transcriptCache = new Map();

  const state = {
    enabled: true,
    skipSeconds: core.DEFAULT_SKIP_SECONDS,
    activeVideoId: null,
    navToken: 0,
    videoId: null,
    video: null,
    channelId: null,
    channelMatch: false,
    title: null,
    status: "inactive",
    detail: "",
    source: null,
    trigger: null,
    armed: false,
    watchTimer: null,
    seekHandler: null,
    lastTime: 0,
    lastSkip: null,
    hasSkipped: false,
    skipCount: 0,
    toastTitle: null,
    suppress: false,
    suppressUntil: 0,
    toastHost: null,
    toastTimer: null,
    lastHref: location.href,
  };

  function sleep(milliseconds) {
    return new Promise(function (resolve) {
      setTimeout(resolve, milliseconds);
    });
  }

  function formatSeconds(value) {
    return String(value).replace(".", ",");
  }

  function setDataAttribute(name, value) {
    try {
      if (value == null || value === "") {
        document.documentElement.removeAttribute(name);
      } else {
        document.documentElement.setAttribute(name, String(value));
      }
    } catch (error) {
      // The document can disappear during a YouTube navigation.
    }
  }

  function setStatus(status, detail) {
    state.status = status;
    state.detail = detail || "";
    setDataAttribute("data-balna-skip-status", status);
    setDataAttribute("data-balna-skip-video", state.videoId || "");
    setDataAttribute(
      "data-balna-skip-trigger",
      state.trigger ? state.trigger.triggerTime : ""
    );
    setDataAttribute("data-balna-skip-source", state.source || "");
    setDataAttribute("data-balna-skip-message", state.detail);
    console.info(
      "[BálnaSkip] " +
        status +
        (state.detail ? " – " + state.detail : "") +
        (state.videoId ? " (" + state.videoId + ")" : "")
    );
  }

  function getMainVideo() {
    return (
      document.querySelector("#movie_player video.html5-main-video") ||
      document.querySelector("video.html5-main-video") ||
      document.querySelector("#movie_player video") ||
      document.querySelector("video")
    );
  }

  function parseVideoId(href) {
    let url;
    try {
      url = new URL(href);
    } catch (error) {
      return null;
    }
    if (!/(^|\.)youtube\.com$/i.test(url.hostname)) {
      return null;
    }
    if (url.pathname === "/watch") {
      const videoId = url.searchParams.get("v");
      return videoId && /^[A-Za-z0-9_-]{11}$/.test(videoId)
        ? videoId
        : null;
    }
    const match = url.pathname.match(/^\/(?:live|shorts|embed)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
    return match ? match[1] : null;
  }

  function readPageApiKey() {
    try {
      const page = window.wrappedJSObject;
      if (!page) {
        return null;
      }
      const ytcfg = page.ytcfg;
      if (!ytcfg) {
        return null;
      }
      const data = ytcfg.data_;
      if (data && typeof data.INNERTUBE_API_KEY === "string") {
        return data.INNERTUBE_API_KEY;
      }
      // This call can be blocked by the Xray wrapper, so it is only a fallback.
      if (typeof ytcfg.get === "function") {
        const key = ytcfg.get("INNERTUBE_API_KEY");
        if (typeof key === "string") {
          return key;
        }
      }
    } catch (error) {
      // The public fallback key in the background page handles this.
    }
    return null;
  }

  function readPageClientVersion() {
    try {
      const page = window.wrappedJSObject;
      const data = page && page.ytcfg && page.ytcfg.data_;
      if (data && typeof data.INNERTUBE_CLIENT_VERSION === "string") {
        return data.INNERTUBE_CLIENT_VERSION;
      }
    } catch (error) {
      // A built-in fallback client version is used below.
    }
    return null;
  }

  function isValidApiKey(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{20,}$/.test(value);
  }

  function getApiKeys() {
    const keys = [];
    const pageApiKey = readPageApiKey();
    if (isValidApiKey(pageApiKey)) {
      keys.push(pageApiKey);
    }
    if (!keys.includes(PUBLIC_INNERTUBE_KEY)) {
      keys.push(PUBLIC_INNERTUBE_KEY);
    }
    return keys;
  }

  function delay(milliseconds) {
    return new Promise(function (resolve) {
      setTimeout(resolve, milliseconds);
    });
  }

  async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(function () {
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, Object.assign({}, options, {
        signal: controller.signal,
      }));
    } finally {
      clearTimeout(timer);
    }
  }

  function chooseHungarianTrack(tracks) {
    if (!Array.isArray(tracks) || !tracks.length) {
      return null;
    }
    const hungarian = tracks.filter(function (track) {
      return (
        track &&
        typeof track.languageCode === "string" &&
        /^hu(?:-|$)/i.test(track.languageCode)
      );
    });
    if (!hungarian.length) {
      return null;
    }
    return (
      hungarian.find(function (track) {
        return track.kind !== "asr";
      }) ||
      hungarian.find(function (track) {
        return track.kind === "asr" && track.languageCode === "hu";
      }) ||
      hungarian[0]
    );
  }

  function innertubeOrigin() {
    if (/^https:\/\/(?:www\.)?youtube\.com$/.test(location.origin)) {
      return location.origin;
    }
    return "https://www.youtube.com";
  }

  async function requestPlayer(videoId) {
    const body = JSON.stringify({
      context: {
        client: {
          clientName: "ANDROID",
          clientVersion: ANDROID_CLIENT_VERSION,
          androidSdkVersion: 30,
          hl: "hu",
          gl: "HU",
        },
      },
      videoId: videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    });
    let lastError = null;
    for (const apiKey of getApiKeys()) {
      try {
        const response = await fetchWithTimeout(
          innertubeOrigin() + "/youtubei/v1/player?key=" +
            encodeURIComponent(apiKey) +
            "&prettyPrint=false",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "X-YouTube-Client-Name": "3",
              "X-YouTube-Client-Version": ANDROID_CLIENT_VERSION,
            },
            body: body,
            credentials: "same-origin",
            cache: "no-store",
          }
        );
        if (!response.ok) {
          throw new Error(
            "A YouTube player API " + response.status + " hibát adott."
          );
        }
        const data = await response.json();
        const status =
          data && data.playabilityStatus && data.playabilityStatus.status;
        if (status && status !== "OK") {
          throw new Error(
            (data.playabilityStatus && data.playabilityStatus.reason) ||
              "A videó nem játszható le."
          );
        }
        return data;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Nem sikerült elérni a YouTube-ot.");
  }

  function stripCaptionFormat(rawUrl) {
    const url = new URL(rawUrl, "https://www.youtube.com");
    url.searchParams.delete("fmt");
    return url.href;
  }

  async function fetchTimedTextCues(track) {
    if (!track || typeof track.baseUrl !== "string" || !track.baseUrl) {
      throw new Error("A felirat URL-je hiányzik.");
    }
    if (/[?&]exp=xpe(?:&|$)/.test(track.baseUrl)) {
      const error = new Error(
        "A YouTube PO-token védelmet kér ehhez a felirathoz."
      );
      error.code = "pot-required";
      throw error;
    }
    const response = await fetchWithTimeout(stripCaptionFormat(track.baseUrl), {
      method: "GET",
      headers: {
        Accept: "text/xml,application/xml,text/plain,*/*",
      },
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      const error = new Error(
        "A felirat letöltése " + response.status + " hibával zárult."
      );
      error.code = "fetch-error";
      throw error;
    }
    const xml = await response.text();
    if (!xml.trim()) {
      const error = new Error("A YouTube üres feliratot küldött.");
      error.code = "empty-captions";
      throw error;
    }
    const cues = core.parseTimedText(xml);
    if (!cues.length) {
      const error = new Error("A feliratot nem sikerült feldolgozni.");
      error.code = "parse-error";
      throw error;
    }
    return cues;
  }

  function buildPanelParams(videoId) {
    const bytes = [0xaa, 0x09, 0x0f, 0x0a, 0x0b];
    for (let i = 0; i < videoId.length; i++) {
      bytes.push(videoId.charCodeAt(i));
    }
    bytes.push(0x18, 0x01);
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  async function fetchPanelCues(videoId) {
    const pageVersion = readPageClientVersion();
    const clientVersion = /^\d+(?:\.\d+){2,3}$/.test(pageVersion || "")
      ? pageVersion
      : DEFAULT_WEB_CLIENT_VERSION;
    const response = await fetchWithTimeout(
      innertubeOrigin() + "/youtubei/v1/get_panel?key=" +
        encodeURIComponent(PUBLIC_INNERTUBE_KEY) +
        "&prettyPrint=false",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-YouTube-Client-Name": "1",
          "X-YouTube-Client-Version": clientVersion,
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "WEB",
              clientVersion: clientVersion,
              hl: "hu",
              gl: "HU",
            },
          },
          panelId: PANEL_ID,
          params: buildPanelParams(videoId),
        }),
        credentials: "same-origin",
        cache: "no-store",
      }
    );
    if (!response.ok) {
      const error = new Error(
        "A YouTube átiratpanel " + response.status + " hibát adott."
      );
      error.code = "panel-error";
      throw error;
    }
    const data = await response.json();
    const cues = core.parsePanelTranscript(data, {
      startOffset: PANEL_START_OFFSET_SECONDS,
    });
    if (!cues.length) {
      const error = new Error(
        "Az átiratpanel nem adott használható szöveget."
      );
      error.code = "parse-error";
      throw error;
    }
    return cues;
  }

  function findPanelTrigger(cues) {
    const trigger = core.findTrigger(cues, {
      maxTime: core.SEARCH_WINDOW_SECONDS,
    });
    if (!trigger) {
      return null;
    }
    // The panel rounds segment starts down to whole seconds. If the trigger
    // starts after a short pause word at the beginning of its segment, add one
    // more second to avoid starting the skip before the sentence is finished.
    const pauseBias =
      trigger.firstCueStart === trigger.finalCueStart &&
      trigger.firstCharStart > 0 &&
      trigger.firstCharStart <= 12
        ? PANEL_PAUSE_BIAS_SECONDS
        : 0;
    const bias = PANEL_START_OFFSET_SECONDS + pauseBias;
    trigger.triggerTime =
      Math.round((trigger.triggerTime + bias) * 1000) / 1000;
    trigger.timingBiasSeconds = bias;
    trigger.timingSource = "panel";
    return trigger;
  }

  function getCachedTranscript(videoId) {
    const item = transcriptCache.get(videoId);
    if (!item) {
      return null;
    }
    if (Date.now() - item.storedAt > TRANSCRIPT_CACHE_MS) {
      transcriptCache.delete(videoId);
      return null;
    }
    return item.result;
  }

  function storeCachedTranscript(videoId, result) {
    transcriptCache.set(videoId, {
      storedAt: Date.now(),
      result: result,
    });
    if (transcriptCache.size > 40) {
      const oldestKey = transcriptCache.keys().next().value;
      transcriptCache.delete(oldestKey);
    }
  }

  async function fetchTranscriptOnce(videoId) {
    let track = null;
    let timedTextError = null;
    let cues = null;

    try {
      const playerData = await requestPlayer(videoId);
      const captions =
        playerData.captions &&
        playerData.captions.playerCaptionsTracklistRenderer;
      track = chooseHungarianTrack(captions && captions.captionTracks);
    } catch (error) {
      // The transcript panel can still work without player metadata.
      timedTextError = error;
    }

    if (track) {
      try {
        cues = await fetchTimedTextCues(track);
      } catch (error) {
        timedTextError = error;
      }
    }

    if (cues && cues.length) {
      return {
        ok: true,
        source: "timedtext",
        track: {
          languageCode: track.languageCode,
          kind: track.kind || null,
          name:
            (track.name &&
              (track.name.simpleText || track.name.runs?.[0]?.text)) ||
            null,
        },
        cueCount: cues.length,
        trigger: core.findTrigger(cues, {
          maxTime: core.SEARCH_WINDOW_SECONDS,
        }),
      };
    }

    if (!track && timedTextError && timedTextError.code === "no-captions") {
      throw timedTextError;
    }

    try {
      const panelCues = await fetchPanelCues(videoId);
      return {
        ok: true,
        source: "panel",
        track: track
          ? {
              languageCode: track.languageCode,
              kind: track.kind || null,
              name:
                (track.name &&
                  (track.name.simpleText || track.name.runs?.[0]?.text)) ||
                null,
            }
          : null,
        cueCount: panelCues.length,
        trigger: findPanelTrigger(panelCues),
      };
    } catch (panelError) {
      const error = new Error(
        "A felirat sem a timedtext, sem az átiratpanel felületén nem érhető el."
      );
      error.code =
        panelError.code === "parse-error" ? "parse-error" : "fetch-error";
      error.cause = timedTextError || panelError;
      throw error;
    }
  }

  function transcriptErrorResult(error) {
    return {
      ok: false,
      code: (error && error.code) || "fetch-error",
      message:
        error && error.message
          ? error.message
          : "Nem sikerült a feliratot leolvasni.",
    };
  }

  async function requestTranscript(videoId, token) {
    const cached = getCachedTranscript(videoId);
    if (cached) {
      return cached;
    }
    let lastResult = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (token !== state.navToken || !state.enabled) {
        return null;
      }
      try {
        const result = await fetchTranscriptOnce(videoId);
        storeCachedTranscript(videoId, result);
        return result;
      } catch (error) {
        lastResult = transcriptErrorResult(error);
      }
      const code = lastResult && lastResult.code;
      if (!RETRYABLE_ERRORS.has(code) || attempt === 3) {
        return lastResult;
      }
      setStatus(
        "loading",
        "Újrapróbálom a feliratot (" + attempt + "/3)…"
      );
      await delay(attempt * 2500);
    }
    return lastResult;
  }

  function getOwnerHref() {
    const selectors = [
      "ytd-video-owner-renderer #channel-name a[href]",
      "ytd-video-owner-renderer a[href^='/@']",
      "ytd-watch-metadata #owner #channel-name a[href]",
      "ytd-watch-metadata #owner a[href^='/@']",
      "#owner #channel-name a[href]",
      "#owner a[href^='/@']",
    ];
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        const href = element.getAttribute("href");
        if (href) {
          return href;
        }
      }
    }
    return null;
  }

  function getDomVideoId() {
    const watchFlexy = document.querySelector("ytd-watch-flexy");
    if (!watchFlexy) {
      return null;
    }
    const attribute = watchFlexy.getAttribute("video-id");
    if (attribute) {
      return attribute;
    }
    return typeof watchFlexy.videoId === "string" ? watchFlexy.videoId : null;
  }

  function readVideoInfo(videoId) {
    let channelId = null;
    let handle = null;
    let title = document.title || null;
    let confirmed = false;

    try {
      const page = window.wrappedJSObject;
      const playerResponse = page && page.ytInitialPlayerResponse;
      const details = playerResponse && playerResponse.videoDetails;
      if (details && details.videoId === videoId) {
        confirmed = true;
        if (typeof details.channelId === "string") {
          channelId = details.channelId;
        }
        if (typeof details.title === "string") {
          title = details.title;
        }
      }
    } catch (error) {
      // Fall back to the watch page DOM below.
    }

    const domVideoId = getDomVideoId();
    const domMatches = domVideoId === videoId;
    if (domMatches) {
      confirmed = true;
    }
    // Do not read the owner box while YouTube is still showing the previous
    // SPA video. Without a matching video-id, use it only as a last resort.
    if (domMatches || !domVideoId) {
      const ownerHref = getOwnerHref();
      if (ownerHref) {
        const handleMatch = ownerHref.match(/^\/@([^/?#]+)/);
        if (handleMatch) {
          handle = decodeURIComponent(handleMatch[1]);
        }
        const channelMatch = ownerHref.match(/^\/channel\/(UC[A-Za-z0-9_-]{20,})/);
        if (!channelId && channelMatch) {
          channelId = channelMatch[1];
        }
      }
    }

    return {
      channelId: channelId,
      handle: handle,
      title: title,
      confirmed: confirmed,
    };
  }

  function isTargetChannel(info) {
    if (!info) {
      return false;
    }
    if (info.channelId) {
      return info.channelId === core.TARGET_CHANNEL_ID;
    }
    if (info.handle) {
      return (
        info.handle.toLowerCase() ===
        core.TARGET_CHANNEL_HANDLE.toLowerCase()
      );
    }
    return false;
  }

  function cleanupSession() {
    if (state.watchTimer) {
      clearInterval(state.watchTimer);
      state.watchTimer = null;
    }
    if (state.video && state.seekHandler) {
      try {
        state.video.removeEventListener("seeked", state.seekHandler, true);
      } catch (error) {
        // Ignore detached video elements.
      }
    }
    removeToast();
    state.video = null;
    state.seekHandler = null;
    state.channelId = null;
    state.channelMatch = false;
    state.title = null;
    state.source = null;
    state.trigger = null;
    state.armed = false;
    state.toastTitle = null;
    state.lastTime = 0;
    state.lastSkip = null;
    state.hasSkipped = false;
    state.skipCount = 0;
    state.suppress = false;
    state.suppressUntil = 0;
    state.status = "inactive";
    state.detail = "";
  }

  async function waitForVideoInfo(videoId, token) {
    const startedAt = Date.now();
    const deadline = startedAt + 12000;
    let lastInfo = null;
    let lastVideo = null;
    while (Date.now() < deadline) {
      if (token !== state.navToken) {
        return null;
      }
      const video = getMainVideo();
      const info = readVideoInfo(videoId);
      lastInfo = info;
      lastVideo = video;
      if (
        video &&
        (info.channelId || info.handle) &&
        (info.confirmed || Date.now() - startedAt > 5000)
      ) {
        return { video: video, info: info };
      }
      await sleep(200);
    }
    return lastVideo ? { video: lastVideo, info: lastInfo } : null;
  }

  function seekToTime(video, target) {
    try {
      video.currentTime = target;
    } catch (error) {
      // Fall through to the player API below.
    }
    setTimeout(function () {
      if (state.video !== video) {
        return;
      }
      if (Math.abs(video.currentTime - target) <= 1.5) {
        return;
      }
      try {
        const player = document.getElementById("movie_player");
        const pagePlayer = player && player.wrappedJSObject;
        if (pagePlayer && typeof pagePlayer.seekTo === "function") {
          pagePlayer.seekTo(target, true);
        }
      } catch (error) {
        console.warn("[BálnaSkip] A player seekTo hívása nem sikerült.", error);
      }
    }, 250);
  }

  function toastParent() {
    return document.fullscreenElement || document.body || document.documentElement;
  }

  function placeToast() {
    if (!state.toastHost) {
      return;
    }
    const parent = toastParent();
    if (parent && state.toastHost.parentNode !== parent) {
      parent.appendChild(state.toastHost);
    }
    state.toastHost.style.bottom = document.fullscreenElement ? "80px" : "24px";
  }

  function removeToast() {
    if (state.toastTimer) {
      clearTimeout(state.toastTimer);
      state.toastTimer = null;
    }
    if (state.toastHost) {
      try {
        state.toastHost.remove();
      } catch (error) {
        // Already detached.
      }
      state.toastHost = null;
    }
    state.toastTitle = null;
  }

  function styleElement(element, styles) {
    Object.assign(element.style, styles);
    return element;
  }

  function createToast(skipSeconds) {
    removeToast();
    const host = document.createElement("div");
    host.id = TOAST_HOST_ID;
    host.setAttribute("data-balna-skip-toast", "1");
    styleElement(host, {
      position: "fixed",
      left: "50%",
      bottom: "24px",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      pointerEvents: "none",
      maxWidth: "calc(100vw - 24px)",
    });

    const shadow = host.attachShadow({ mode: "open" });
    const card = styleElement(document.createElement("div"), {
      display: "flex",
      alignItems: "center",
      gap: "12px",
      boxSizing: "border-box",
      maxWidth: "440px",
      padding: "11px 12px 11px 14px",
      border: "1px solid rgba(45, 212, 191, 0.38)",
      borderRadius: "14px",
      background: "rgba(9, 15, 27, 0.96)",
      boxShadow: "0 18px 60px rgba(0, 0, 0, 0.45)",
      color: "#f8fafc",
      font: "13px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif",
      pointerEvents: "auto",
    });
    card.setAttribute("role", "status");
    card.setAttribute("aria-live", "polite");

    const icon = styleElement(document.createElement("div"), {
      flex: "0 0 auto",
      width: "34px",
      height: "34px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: "10px",
      background: "rgba(45, 212, 191, 0.16)",
      color: "#5eead4",
      font: "700 15px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif",
      letterSpacing: "-1px",
    });
    icon.textContent = ">>";

    const copy = styleElement(document.createElement("div"), {
      minWidth: "0",
      flex: "1 1 auto",
    });
    const title = styleElement(document.createElement("div"), {
      color: "#f8fafc",
      font: "650 13px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif",
    });
    title.textContent = "Reklám átugorva";
    const subtitle = styleElement(document.createElement("div"), {
      marginTop: "2px",
      color: "#94a3b8",
      font: "11px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif",
      whiteSpace: "nowrap",
    });
    subtitle.textContent = formatSeconds(skipSeconds) + " másodperccel előre";
    copy.appendChild(title);
    copy.appendChild(subtitle);

    const undo = styleElement(document.createElement("button"), {
      flex: "0 0 auto",
      appearance: "none",
      border: "1px solid rgba(45, 212, 191, 0.42)",
      borderRadius: "9px",
      padding: "7px 10px",
      background: "rgba(45, 212, 191, 0.12)",
      color: "#5eead4",
      font: "600 11px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif",
      cursor: "pointer",
      whiteSpace: "nowrap",
    });
    undo.type = "button";
    undo.textContent = "Visszavonás";
    undo.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      const undone = undoLastSkip();
      if (undone) {
        title.textContent = "Visszavonva";
        subtitle.textContent = "A reklám újra látható";
        undo.remove();
        if (state.toastTimer) {
          clearTimeout(state.toastTimer);
        }
        state.toastTimer = setTimeout(removeToast, 2600);
      }
    });

    card.appendChild(icon);
    card.appendChild(copy);
    card.appendChild(undo);
    shadow.appendChild(card);

    state.toastHost = host;
    state.toastTitle = title;
    placeToast();
    state.toastTimer = setTimeout(removeToast, 10000);
  }

  function performSkip(video) {
    if (!state.enabled || !state.trigger || !state.video) {
      return false;
    }
    const from = video.currentTime;
    if (!Number.isFinite(from)) {
      return false;
    }
    const maxTime =
      Number.isFinite(video.duration) && video.duration > 0
        ? video.duration - 0.25
        : from + state.skipSeconds;
    const target = Math.min(from + state.skipSeconds, maxTime);
    if (!Number.isFinite(target) || target <= from + 0.5) {
      return false;
    }

    state.lastSkip = {
      from: from,
      to: target,
      at: Date.now(),
      undone: false,
    };
    state.hasSkipped = true;
    state.skipCount += 1;
    state.suppress = false;
    state.suppressUntil = 0;
    state.lastTime = target;
    setStatus("skipped", formatSeconds(state.skipSeconds) + " mp-es ugrás");
    seekToTime(video, target);
    createToast(state.skipSeconds);
    console.info(
      "[BálnaSkip] Ugrás: " +
        from.toFixed(2) +
        " → " +
        target.toFixed(2) +
        " mp"
    );
    return true;
  }

  function undoLastSkip() {
    const video = state.video;
    const lastSkip = state.lastSkip;
    if (!video || !lastSkip || lastSkip.undone) {
      return false;
    }
    lastSkip.undone = true;
    state.suppress = true;
    state.suppressUntil = Math.max(
      lastSkip.to + 2,
      lastSkip.from + state.skipSeconds + 2
    );
    state.lastTime = lastSkip.from;
    seekToTime(video, lastSkip.from);
    setStatus("undone", "A skip visszavonva");
    if (state.toastTitle) {
      state.toastTitle.textContent = "Visszavonva";
    }
    if (state.toastHost) {
      if (state.toastTimer) {
        clearTimeout(state.toastTimer);
      }
      state.toastTimer = setTimeout(removeToast, 2600);
    }
    console.info("[BálnaSkip] Skip visszavonva.");
    return true;
  }

  function restartWatchTimer(token) {
    if (state.watchTimer || !state.video) {
      return;
    }
    state.watchTimer = setInterval(function () {
      watchTick(token);
    }, 250);
  }

  function handleBackwardPosition(now) {
    if (!state.trigger || state.suppress) {
      return;
    }
    if (now < state.trigger.triggerTime - 0.5) {
      if (!state.video) {
        return;
      }
      const wasArmed = state.armed;
      state.armed = true;
      if (state.hasSkipped || !wasArmed) {
        hideToastForRewind();
        setStatus("armed", "Visszatekertél – újra figyelem a triggert");
        restartWatchTimer(state.navToken);
        console.info("[BálnaSkip] Visszatekertél a trigger elé, újra figyelek.");
      }
    }
  }

  function hideToastForRewind() {
    if (state.toastHost) {
      removeToast();
    }
  }

  function watchTick(token) {
    if (token !== state.navToken || !state.trigger) {
      return;
    }
    if (!state.enabled) {
      return;
    }
    const currentVideo = getMainVideo();
    if (currentVideo && currentVideo !== state.video) {
      // YouTube occasionally replaces the media element after a seek or when
      // switching between an ad and the main video.
      attachWatcher(currentVideo, token);
      return;
    }
    const video = state.video;
    if (!video) {
      return;
    }
    const now = video.currentTime;
    if (!Number.isFinite(now) || now < 0) {
      return;
    }

    const player = document.getElementById("movie_player");
    if (player && player.classList.contains("ad-showing")) {
      // Do not treat the ad-to-video time reset as a manual rewind, and do not
      // skip while an ad is on screen.
      state.lastTime = now;
      return;
    }

    const previousTime = state.lastTime;
    const jumpedForward = now - previousTime > 2.5;
    if (now < previousTime - 1.0) {
      handleBackwardPosition(now);
    }
    state.lastTime = now;

    if (state.suppress) {
      if (now > state.suppressUntil) {
        state.suppress = false;
      }
      return;
    }

    if (state.armed) {
      const triggerTime = state.trigger.triggerTime;
      if (now >= triggerTime) {
        if (!jumpedForward || now - triggerTime <= 0.5) {
          if (performSkip(video)) {
            state.armed = false;
            return;
          }
        }
        state.armed = false;
        setStatus("missed", "A trigger már elhangzott, nem ugrok oda vissza.");
        return;
      }
    }

    if (
      now > core.SEARCH_WINDOW_SECONDS + 45 &&
      state.watchTimer &&
      !state.armed
    ) {
      clearInterval(state.watchTimer);
      state.watchTimer = null;
    }
  }

  function attachWatcher(video, token) {
    if (state.video && state.seekHandler && state.video !== video) {
      try {
        state.video.removeEventListener("seeked", state.seekHandler, true);
      } catch (error) {
        // Ignore detached media elements.
      }
    }
    state.video = video;
    state.lastTime = video.currentTime;
    state.seekHandler = function () {
      if (token !== state.navToken || state.video !== video) {
        return;
      }
      const now = video.currentTime;
      if (!Number.isFinite(now)) {
        return;
      }
      if (now < state.lastTime - 1.0) {
        handleBackwardPosition(now);
      }
      state.lastTime = now;
    };
    video.addEventListener("seeked", state.seekHandler, true);
    restartWatchTimer(token);
  }

  async function activateVideo(videoId, token) {
    setStatus("loading", "Csatorna ellenőrzése…");
    const player = await waitForVideoInfo(videoId, token);
    if (token !== state.navToken) {
      return;
    }
    if (!player) {
      setStatus("error", "Nem találtam a videót az oldalon.");
      return;
    }
    state.title = player.info.title || state.title;
    state.channelId = player.info.channelId || null;
    state.channelMatch = isTargetChannel(player.info);
    if (!state.channelMatch) {
      setStatus("other-channel", "Ez a videó nem a Súlytalan csatornáról van.");
      return;
    }
    if (!state.enabled) {
      setStatus("disabled");
      return;
    }

    setStatus("loading", "Felirat letöltése…");
    const result = await requestTranscript(videoId, token);
    if (token !== state.navToken) {
      return;
    }
    if (!state.enabled) {
      setStatus("disabled");
      return;
    }
    if (!result) {
      setStatus("error", "A felirat lekérése megszakadt.");
      return;
    }
    if (!result.ok) {
      const code = result.code || "error";
      if (code === "no-captions") {
        setStatus("no-captions", result.message || undefined);
      } else if (code === "pot-required") {
        setStatus(
          "no-captions",
          "A YouTube most nem adta ki a feliratot (PO-token)."
        );
      } else if (code === "bad-video-id") {
        setStatus("error", result.message || "Hibás videóazonosító.");
      } else {
        setStatus("error", result.message || "Nem sikerült a feliratot lekérni.");
      }
      return;
    }
    if (!result.trigger) {
      setStatus(
        "no-trigger",
        "Az első " + Math.round(core.SEARCH_WINDOW_SECONDS / 60) + " percben nincs trigger."
      );
      return;
    }

    state.source = result.source || null;
    state.trigger = result.trigger;
    state.armed = true;
    setStatus("armed");
    attachWatcher(player.video, token);

    const now = player.video.currentTime;
    if (
      Number.isFinite(now) &&
      now >= state.trigger.triggerTime &&
      now - state.trigger.triggerTime <= 12
    ) {
      if (performSkip(player.video)) {
        state.armed = false;
      }
    } else if (Number.isFinite(now) && now > state.trigger.triggerTime + 12) {
      state.armed = false;
      setStatus("missed", "A videó a trigger után indult.");
    }
  }

  async function startForLocation(force) {
    const currentVideoId = parseVideoId(location.href);
    if (
      !force &&
      currentVideoId &&
      state.activeVideoId === currentVideoId &&
      state.status !== "inactive"
    ) {
      state.lastHref = location.href;
      return;
    }

    const token = ++state.navToken;
    cleanupSession();
    state.activeVideoId = currentVideoId;
    state.lastHref = location.href;

    if (!currentVideoId) {
      state.videoId = null;
      setStatus("inactive");
      return;
    }

    state.videoId = currentVideoId;
    setStatus("loading", "Csatorna ellenőrzése…");
    try {
      await activateVideo(currentVideoId, token);
    } catch (error) {
      if (token === state.navToken) {
        console.error("[BálnaSkip] Váratlan hiba:", error);
        setStatus("error", String(error && error.message ? error.message : error));
      }
    }
  }

  let navigationTimer = null;
  function scheduleNavigation() {
    if (location.href === state.lastHref && state.status !== "inactive") {
      return;
    }
    clearTimeout(navigationTimer);
    navigationTimer = setTimeout(function () {
      startForLocation(false).catch(function (error) {
        console.error("[BálnaSkip] Navigációs hiba:", error);
      });
    }, 220);
  }

  function installNavigationHooks() {
    document.addEventListener("yt-navigate-finish", scheduleNavigation, true);
    document.addEventListener("yt-page-data-updated", scheduleNavigation, true);
    window.addEventListener("popstate", scheduleNavigation);
    document.addEventListener("fullscreenchange", placeToast, true);
    setInterval(function () {
      if (location.href !== state.lastHref) {
        scheduleNavigation();
      }
    }, 1500);
  }

  function loadSettings() {
    return browser.storage.local
      .get({ enabled: true, skipSeconds: core.DEFAULT_SKIP_SECONDS })
      .then(function (settings) {
        state.enabled = settings.enabled !== false;
        const requestedSkip = Number(settings.skipSeconds);
        state.skipSeconds =
          Number.isFinite(requestedSkip) && requestedSkip >= 1 && requestedSkip <= 60
            ? requestedSkip
            : core.DEFAULT_SKIP_SECONDS;
      })
      .catch(function () {
        state.enabled = true;
        state.skipSeconds = core.DEFAULT_SKIP_SECONDS;
      });
  }

  function getStatus() {
    return {
      enabled: state.enabled,
      status: state.status,
      statusLabel: STATUS_LABELS[state.status] || state.status,
      detail: state.detail,
      videoId: state.videoId,
      title: state.title,
      channelMatch: state.channelMatch,
      source: state.source,
      triggerTime: state.trigger ? state.trigger.triggerTime : null,
      canUndo: Boolean(state.lastSkip && !state.lastSkip.undone && state.video),
      skipCount: state.skipCount,
      skipSeconds: state.skipSeconds,
      searchedUntil: core.SEARCH_WINDOW_SECONDS,
    };
  }

  browser.runtime.onMessage.addListener(function (message) {
    if (!message) {
      return undefined;
    }
    if (message.type === "BALNA_GET_STATUS") {
      return Promise.resolve(getStatus());
    }
    if (message.type === "BALNA_UNDO_SKIP") {
      const undone = undoLastSkip();
      return Promise.resolve({
        ok: undone,
        status: getStatus(),
      });
    }
    return undefined;
  });

  browser.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local" || !changes.enabled) {
      return;
    }
    const wasEnabled = state.enabled;
    state.enabled = changes.enabled.newValue !== false;
    if (state.enabled && !wasEnabled) {
      startForLocation(true).catch(function (error) {
        console.error("[BálnaSkip] Újraindítási hiba:", error);
      });
    } else if (!state.enabled && wasEnabled) {
      if (state.watchTimer) {
        clearInterval(state.watchTimer);
        state.watchTimer = null;
      }
      state.armed = false;
      removeToast();
      setStatus("disabled");
    }
  });

  function bootstrap() {
    try {
      const staleToast = document.getElementById(TOAST_HOST_ID);
      if (staleToast) {
        staleToast.remove();
      }
    } catch (error) {
      // Ignore stale overlays from a previous injection.
    }
    loadSettings().then(function () {
      installNavigationHooks();
      startForLocation(false).catch(function (error) {
        console.error("[BálnaSkip] Indítási hiba:", error);
      });
    });
  }

  bootstrap();
})();
