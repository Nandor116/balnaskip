/*
 * BálnaSkip – shared transcript and trigger logic.
 *
 * This file deliberately has no browser APIs so it can run in the
 * background page, in a content script, and in the Node test suite.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.BalnaCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TARGET_CHANNEL_ID = "UCJ1iwRdRH6GgT8l_oNd02ag";
  const TARGET_CHANNEL_HANDLE = "sulytalanbalna";
  const SEARCH_WINDOW_SECONDS = 300;
  const DEFAULT_SKIP_SECONDS = 5.5;
  const CHARACTERS_PER_SECOND = 12;

  const BALNA_EXACT = new Set(["balna", "balla", "bala", "bal"]);
  const BALNA_FUZZY_TARGET = "balna";
  const SULYTALAN_EXACT = new Set(["sulytalan", "sujtalan"]);
  const SULYTALAN_FUZZY_TARGET = "sulytalan";
  const TAIL_WORDS = new Set([
    "vagy",
    "fasz",
    "faszt",
    "faszom",
    "faszod",
    "faszos",
    "bassz",
    "bassza",
    "basszam",
    "geci",
    "kurva",
  ]);

  function stripAnnotations(value) {
    return String(value == null ? "" : value)
      .replace(/<[^>]*>/g, " ")
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/[>]{2,}/g, " ")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeText(value) {
    return stripAnnotations(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function decodeEntities(value) {
    const named = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      nbsp: " ",
      quot: '"',
    };
    return String(value == null ? "" : value).replace(
      /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
      function (match, entity) {
        if (entity[0] === "#") {
          const isHex = entity[1] && entity[1].toLowerCase() === "x";
          const codePoint = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
          if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
            try {
              return String.fromCodePoint(codePoint);
            } catch (error) {
              return match;
            }
          }
          return match;
        }
        const replacement = named[entity.toLowerCase()];
        return Object.prototype.hasOwnProperty.call(named, entity.toLowerCase())
          ? replacement
          : match;
      }
    );
  }

  function parseAttributes(raw) {
    const attributes = {};
    const regex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
    let match;
    while ((match = regex.exec(raw))) {
      attributes[match[1]] = match[2];
    }
    return attributes;
  }

  function cleanCaptionText(value) {
    return decodeEntities(String(value == null ? "" : value).replace(/<[^>]*>/g, " "))
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseJsonTranscript(data) {
    const events = Array.isArray(data && data.events) ? data.events : [];
    const cues = [];
    let position = 0;
    for (const event of events) {
      if (!event || !Array.isArray(event.segs)) {
        continue;
      }
      const text = event.segs
        .map(function (segment) {
          return segment && typeof segment.utf8 === "string" ? segment.utf8 : "";
        })
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) {
        continue;
      }
      const start = Number(event.tStartMs) / 1000;
      if (!Number.isFinite(start)) {
        continue;
      }
      const duration = Number(event.dDurationMs) / 1000;
      cues.push({
        start: start,
        duration: Number.isFinite(duration) && duration > 0 ? duration : 0.01,
        text: text,
        order: position++,
      });
    }
    return cues;
  }

  function parseSrv3Transcript(xml) {
    const cues = [];
    const paragraphRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    let paragraph;
    let order = 0;
    while ((paragraph = paragraphRegex.exec(xml))) {
      const attributes = parseAttributes(paragraph[1]);
      if (attributes.t == null) {
        continue;
      }
      const start = Number(attributes.t) / 1000;
      const duration = attributes.d == null ? 0.01 : Number(attributes.d) / 1000;
      if (!Number.isFinite(start)) {
        continue;
      }
      const segmentRegex = /<s\b[^>]*>([\s\S]*?)<\/s>/gi;
      let segment;
      let text = "";
      while ((segment = segmentRegex.exec(paragraph[2]))) {
        text += segment[1];
      }
      if (!text.trim()) {
        text = paragraph[2];
      }
      text = cleanCaptionText(text);
      if (!text) {
        continue;
      }
      cues.push({
        start: start,
        duration:
          Number.isFinite(duration) && duration > 0 ? duration : 0.01,
        text: text,
        order: order++,
      });
    }
    return cues;
  }

  function parseLegacyTranscript(xml) {
    const cues = [];
    const textRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let element;
    let order = 0;
    while ((element = textRegex.exec(xml))) {
      const attributes = parseAttributes(element[1]);
      const start = Number(attributes.start);
      const duration = attributes.dur == null ? 0.01 : Number(attributes.dur);
      if (!Number.isFinite(start)) {
        continue;
      }
      const text = cleanCaptionText(element[2]);
      if (!text) {
        continue;
      }
      cues.push({
        start: start,
        duration:
          Number.isFinite(duration) && duration > 0 ? duration : 0.01,
        text: text,
        order: order++,
      });
    }
    return cues;
  }

  function parseTimedText(raw) {
    const source = String(raw == null ? "" : raw).trim();
    if (!source) {
      return [];
    }
    if (source[0] === "{") {
      try {
        return parseJsonTranscript(JSON.parse(source));
      } catch (error) {
        return [];
      }
    }
    let cues = parseLegacyTranscript(source);
    if (!cues.length) {
      cues = parseSrv3Transcript(source);
    }
    cues.sort(function (a, b) {
      return a.start - b.start || a.order - b.order;
    });
    return cues;
  }

  function parseTimestamp(value) {
    const parts = String(value == null ? "" : value).trim().split(":");
    if (parts.length < 2 || parts.length > 3) {
      return null;
    }
    let total = 0;
    for (const part of parts) {
      if (!/^\d+$/.test(part)) {
        return null;
      }
      total = total * 60 + Number(part);
    }
    return total;
  }

  function collectPanelSegments(node, output) {
    if (!node || typeof node !== "object") {
      return output;
    }
    if (
      node.transcriptSegmentViewModel &&
      typeof node.transcriptSegmentViewModel === "object"
    ) {
      output.push(node.transcriptSegmentViewModel);
    }
    for (const key of Object.keys(node)) {
      collectPanelSegments(node[key], output);
    }
    return output;
  }

  /*
   * Parses the watch page's modern "Átirat" panel (youtubei/v1/get_panel).
   * Segment timestamps are rounded down to whole seconds by YouTube, so the
   * caller can pass startOffset to compensate for that truncation.
   */
  function parsePanelTranscript(raw, options) {
    const settings = Object.assign({ startOffset: 0 }, options || {});
    let data = raw;
    if (typeof raw === "string") {
      try {
        data = JSON.parse(raw);
      } catch (error) {
        return [];
      }
    }
    const segments = collectPanelSegments(data, []);
    if (!segments.length) {
      return [];
    }
    const cues = [];
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (!segment) {
        continue;
      }
      const start = parseTimestamp(segment.timestamp);
      if (start == null) {
        continue;
      }
      const text = cleanCaptionText(segment.simpleText);
      if (!text) {
        continue;
      }
      let nextStart = null;
      if (segments[i + 1]) {
        nextStart = parseTimestamp(segments[i + 1].timestamp);
      }
      const duration =
        nextStart != null && nextStart > start ? nextStart - start : 0.01;
      cues.push({
        start: start + settings.startOffset,
        duration: duration,
        text: text,
        order: cues.length,
      });
    }
    return cues;
  }

  function levenshtein(a, b, maxDistance) {
    const left = String(a);
    const right = String(b);
    if (left === right) {
      return 0;
    }
    if (Math.abs(left.length - right.length) > maxDistance) {
      return maxDistance + 1;
    }
    let previous = new Array(right.length + 1);
    let current = new Array(right.length + 1);
    for (let j = 0; j <= right.length; j++) {
      previous[j] = j;
    }
    for (let i = 1; i <= left.length; i++) {
      current[0] = i;
      let rowMinimum = current[0];
      for (let j = 1; j <= right.length; j++) {
        const substitution = left[i - 1] === right[j - 1] ? 0 : 1;
        current[j] = Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + substitution
        );
        if (current[j] < rowMinimum) {
          rowMinimum = current[j];
        }
      }
      if (rowMinimum > maxDistance) {
        return maxDistance + 1;
      }
      const swap = previous;
      previous = current;
      current = swap;
    }
    return previous[right.length];
  }

  function isBalnaToken(token) {
    if (BALNA_EXACT.has(token)) {
      return true;
    }
    if (token.length < 4) {
      return false;
    }
    return levenshtein(token, BALNA_FUZZY_TARGET, 1) <= 1;
  }

  function isSulytalanToken(token) {
    if (SULYTALAN_EXACT.has(token)) {
      return true;
    }
    if (token.length < 7) {
      return false;
    }
    return (
      levenshtein(token, SULYTALAN_FUZZY_TARGET, 2) <= 2
    );
  }

  function isTailToken(token) {
    if (TAIL_WORDS.has(token)) {
      return true;
    }
    return (
      token.indexOf("fasz") === 0 ||
      token.indexOf("bassz") === 0 ||
      token.indexOf("geci") === 0
    );
  }

  function buildTokenTimeline(cues, maxTime) {
    const tokens = [];
    for (let cueIndex = 0; cueIndex < cues.length; cueIndex++) {
      const cue = cues[cueIndex];
      if (!cue || cue.start > maxTime) {
        continue;
      }
      const normalized = normalizeText(cue.text);
      if (!normalized) {
        continue;
      }
      const wordRegex = /\S+/g;
      let word;
      while ((word = wordRegex.exec(normalized))) {
        tokens.push({
          word: word[0],
          cueIndex: cueIndex,
          cueStart: cue.start,
          cueDuration: cue.duration,
          charEnd: word.index + word[0].length,
        });
      }
    }
    return tokens;
  }

  function estimateTriggerTime(cue, charEnd) {
    const speechLength = Math.max(0.35, charEnd / CHARACTERS_PER_SECOND);
    const duration = Number.isFinite(cue.duration) && cue.duration > 0
      ? cue.duration
      : speechLength;
    const offset = Math.max(0.2, Math.min(speechLength, duration));
    return cue.start + offset;
  }

  function findTrigger(cues, options) {
    const settings = Object.assign(
      {
        maxTime: SEARCH_WINDOW_SECONDS,
        maxTokenGap: 7,
        maxPhraseSeconds: 12,
      },
      options || {}
    );
    if (!Array.isArray(cues) || !cues.length) {
      return null;
    }
    const tokens = buildTokenTimeline(cues, settings.maxTime);
    if (!tokens.length) {
      return null;
    }

    for (let i = 0; i < tokens.length; i++) {
      const first = tokens[i];
      if (!isBalnaToken(first.word)) {
        continue;
      }
      const lastBalnaIndex = Math.min(
        tokens.length - 1,
        i + settings.maxTokenGap
      );
      for (let j = i + 1; j <= lastBalnaIndex; j++) {
        const middle = tokens[j];
        if (!isSulytalanToken(middle.word)) {
          continue;
        }
        if (middle.cueStart - first.cueStart > settings.maxPhraseSeconds) {
          break;
        }
        const lastTailIndex = Math.min(
          tokens.length - 1,
          j + settings.maxTokenGap
        );
        for (let k = j + 1; k <= lastTailIndex; k++) {
          const tail = tokens[k];
          if (!isTailToken(tail.word)) {
            continue;
          }
          if (tail.cueStart - first.cueStart > settings.maxPhraseSeconds) {
            break;
          }
          const finalCue = cues[tail.cueIndex];
          if (!finalCue || finalCue.start > settings.maxTime) {
            continue;
          }
          const triggerTime = estimateTriggerTime(finalCue, tail.charEnd);
          const exactBalna = first.word === "balna" || first.word === "balla";
          const exactSulytalan = SULYTALAN_EXACT.has(middle.word);
          const isVagy = tail.word === "vagy";
          const confidence =
            0.8 + (exactBalna ? 0.1 : 0) + (exactSulytalan ? 0.05 : 0) +
            (isVagy ? 0.05 : 0);
          return {
            matchedText: tokens
              .slice(i, k + 1)
              .map(function (token) {
                return token.word;
              })
              .join(" "),
            triggerTime: Math.round(triggerTime * 1000) / 1000,
            finalCueStart: finalCue.start,
            finalCueEnd: finalCue.start + finalCue.duration,
            firstCueStart: first.cueStart,
            firstCharStart: first.charEnd - first.word.length,
            lastWord: tail.word,
            confidence: Math.round(confidence * 1000) / 1000,
          };
        }
      }
    }
    return null;
  }

  return {
    TARGET_CHANNEL_ID: TARGET_CHANNEL_ID,
    TARGET_CHANNEL_HANDLE: TARGET_CHANNEL_HANDLE,
    SEARCH_WINDOW_SECONDS: SEARCH_WINDOW_SECONDS,
    DEFAULT_SKIP_SECONDS: DEFAULT_SKIP_SECONDS,
    stripAnnotations: stripAnnotations,
    normalizeText: normalizeText,
    decodeEntities: decodeEntities,
    parseTimedText: parseTimedText,
    parsePanelTranscript: parsePanelTranscript,
    parseTimestamp: parseTimestamp,
    findTrigger: findTrigger,
    levenshtein: function (a, b) {
      return levenshtein(a, b, Math.max(String(a).length, String(b).length));
    },
  };
});
