"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../extension/shared/core.js");

function cue(start, duration, text) {
  return { start, duration, text, order: 0 };
}

test("uses a 5.5 second default skip", () => {
  assert.equal(core.DEFAULT_SKIP_SECONDS, 5.5);
});

test("normalizes Hungarian accents, punctuation and censored words", () => {
  assert.equal(
    core.normalizeText(">> Bálna, te súlytalan [ __ ] vagy."),
    "balna te sulytalan vagy"
  );
  assert.equal(
    core.normalizeText("Bálla, te sújtalan [\u00a0__\u00a0] vagy!"),
    "balla te sujtalan vagy"
  );
  assert.equal(core.normalizeText("BÁLNA – TE SÚLYTALAN"), "balna te sulytalan");
});

test("parses the legacy timedtext XML used by YouTube", () => {
  const xml =
    '<?xml version="1.0" encoding="utf-8" ?><transcript>' +
    '<text start="51.84" dur="7.4">Bálna, te súlytalan [&nbsp;__&nbsp;] vagy.</text>' +
    '<text start="59.24" dur="5.44">Ipon.hu, ahol a vásárlás</text>' +
    "</transcript>";
  const cues = core.parseTimedText(xml);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 51.84);
  assert.equal(cues[0].duration, 7.4);
  assert.equal(cues[0].text, "Bálna, te súlytalan [ __ ] vagy.");
});

test("parses srv3 XML (the format Android clients sometimes return)", () => {
  const xml =
    '<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">' +
    '<body><p t="399" d="4360" w="1"><s ac="0">Való</s>' +
    '<s t="320" ac="0"> igaz,</s><s t="641"> hogy</s></p>' +
    '<p t="6510" d="3209" w="1"><s>Bálna, te súlytalan vagy.</s></p>' +
    "</body></timedtext>";
  const cues = core.parseTimedText(xml);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 0.399);
  assert.equal(cues[0].text, "Való igaz, hogy");
  assert.equal(cues[1].start, 6.51);
  assert.equal(cues[1].text, "Bálna, te súlytalan vagy.");
});

test("parses json3 transcripts", () => {
  const json = JSON.stringify({
    events: [
      {
        tStartMs: 1000,
        dDurationMs: 2000,
        segs: [{ utf8: "Bálna, te " }, { utf8: "súlytalan vagy." }],
      },
    ],
  });
  const cues = core.parseTimedText(json);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].text, "Bálna, te súlytalan vagy.");
});

test("parses the modern transcript panel (get_panel) cues", () => {
  const data = {
    content: {
      engagementPanelSectionListRenderer: {
        content: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: [
                    {
                      macroMarkersPanelItemViewModel: {
                        item: {
                          timelineItemViewModel: {
                            contentItems: [
                              {
                                transcriptSegmentViewModel: {
                                  timestamp: "0:48",
                                  simpleText: "Mi a [ __ ]",
                                },
                              },
                              {
                                transcriptSegmentViewModel: {
                                  timestamp: "0:51",
                                  simpleText:
                                    "Bálna, te súlytalan [ __ ] vagy.",
                                },
                              },
                              {
                                transcriptSegmentViewModel: {
                                  timestamp: "0:56",
                                  simpleText: "Ipon.hu, ahol a vásárlás",
                                },
                              },
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  };
  const cues = core.parsePanelTranscript(data, { startOffset: 0.5 });
  assert.equal(cues.length, 3);
  assert.equal(cues[1].start, 51.5);
  assert.equal(cues[1].duration, 5);
  assert.equal(cues[1].text, "Bálna, te súlytalan [ __ ] vagy.");

  const trigger = core.findTrigger(cues);
  assert.ok(trigger);
  assert.equal(trigger.firstCharStart, 0);
  assert.equal(trigger.triggerTime, 53.417);
  assert.equal(core.parseTimestamp("1:02:03"), 3723);
  assert.equal(core.parseTimestamp("0:00"), 0);
  assert.equal(core.parseTimestamp("nope"), null);
});

test("reports the pause before a trigger inside a panel segment", () => {
  const data = {
    contentItems: [
      {
        transcriptSegmentViewModel: {
          timestamp: "0:32",
          simpleText: "Tomról Bálna, te súlytalan [ __ ] vagy.",
        },
      },
      {
        transcriptSegmentViewModel: {
          timestamp: "0:39",
          simpleText: "Ipon.hu",
        },
      },
    ],
  };
  const cues = core.parsePanelTranscript(data, { startOffset: 0.5 });
  const trigger = core.findTrigger(cues);
  assert.ok(trigger);
  assert.equal(trigger.firstCharStart, 7);
  assert.equal(trigger.triggerTime, 35);
});

test("detects the normal trigger and estimates a sensible skip point", () => {
  const cues = [
    cue(26.08, 4.72, "Bálna, te súlytalan vagy."),
    cue(30.8, 6.36, "Ipon.hu, ahol a vásárlás közösséget"),
  ];
  const result = core.findTrigger(cues);
  assert.ok(result);
  assert.equal(result.matchedText, "balna te sulytalan vagy");
  assert.equal(result.confidence, 1);
  assert.ok(result.triggerTime > 27.5 && result.triggerTime < 29.2);
});

test("detects ASR variants: Bálla, Bál, Bála and sújtalan", () => {
  const variants = [
    "Bálla, te súlytalan [ __ ] vagy.",
    "Bál, te súlytalan [ __ ] vagy.",
    "Bála, te sújtalan [ __ ] vagy.",
    "Bálna, te súlytalan fasz vagy.",
  ];
  for (const text of variants) {
    const result = core.findTrigger([
      cue(37.39, 7.4, text),
      cue(42.12, 4.75, "Ipon.hu"),
    ]);
    assert.ok(result, "should detect: " + text);
  }
});

test("detects the trigger when the sentence is split across cues", () => {
  const cues = [
    cue(36.04, 3.0, "Bálna, te súlytalan [ __ ]"),
    cue(39.36, 2.3, "vagy."),
    cue(41.96, 4.75, "Ipon.hu, ahol a vásárlás"),
  ];
  const result = core.findTrigger(cues);
  assert.ok(result);
  assert.equal(result.lastWord, "vagy");
  assert.ok(result.triggerTime >= 39.36 && result.triggerTime <= 40.1);
});

test("does not fire on the introduction or unrelated Balázs mentions", () => {
  const cues = [
    cue(0.12, 6.08, "Sziasztok, Bálna vagyok, és nagyon elfáradtam."),
    cue(6.2, 4, "Német Balázsban is, hogy totál mindegy"),
    cue(10.2, 4, "súlytalan dolog történt a neten"),
    cue(14.2, 4, "de ez nem a keresett mondat."),
  ];
  assert.equal(core.findTrigger(cues), null);
});

test("does not fire when the components are too far apart", () => {
  const cues = [
    cue(0.2, 2, "Bálna vagyok."),
    cue(20.2, 2, "Ez a sztori teljesen súlytalan."),
    cue(24.2, 2, "Szerintem ez vagy az."),
  ];
  assert.equal(core.findTrigger(cues), null);
});

test("ignores trigger-like text after the five minute search window", () => {
  const cues = [
    cue(301, 5, "Bálna, te súlytalan vagy."),
    cue(306, 5, "Ipon.hu"),
  ];
  assert.equal(core.findTrigger(cues), null);
});

test("rejects an unrelated use of súlytalan without the phrase", () => {
  const cues = [
    cue(5, 3, "A bálna egy súlytalan állat, mondjuk."),
    cue(10, 3, "Ez a videó viszont nem az."),
  ];
  assert.equal(core.findTrigger(cues), null);
});
