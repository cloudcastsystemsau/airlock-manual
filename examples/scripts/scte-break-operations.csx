// Bind with trigger "manual" (Run) — a reference card for ORIGINATING SCTE cues.
// C# uses Trig(...) (Trigger is the context variable). Everything static lives in a
// saved trigger template ("break"); the dictionary overrides it per call — the same
// vocabulary as the REST endpoint: operation, preRollMs, breakDurationMs,
// breakDurationFrames (AIR-151). SCTE 104 §11.3: pre-roll >= 4000 ms for timed
// splices, zero only for immediates. Originated splices never set auto_return —
// the RETURN cue is what ends the break, so always plan to send one.
var ch = 1;

// timed break start: downstream splices out 4 s after this cue airs, 30 s planned
if (Trig(ch, "break", new Dictionary<string, string> {
        ["operation"] = "spliceStartNormal", ["preRollMs"] = "4000", ["breakDurationMs"] = "30000" }))
    Log("info", $"break start signalled on ch{ch}");

// the other operations, same shape:
// Trig(ch, "break", new Dictionary<string, string> { ["operation"] = "spliceEndNormal",  ["preRollMs"] = "4000" });
// Trig(ch, "break", new Dictionary<string, string> { ["operation"] = "spliceStartImmediate" });
// Trig(ch, "break", new Dictionary<string, string> { ["operation"] = "spliceEndImmediate" });
// Trig(ch, "break", new Dictionary<string, string> { ["operation"] = "spliceCancel" });
