// JavaScript · trigger: scteReceived (optionally event=spliceStart, channel=1)
//
// AIR-144 — react to an inbound SCTE-104 cue arriving from the source.
//
// scteReceived fires the moment the cue arrives at the INPUT of the delay; scteAired fires
// when that same cue actually reaches air. The gap between them is the delay depth, and it
// is the whole point: on a 60-second delay you learn an ad break is coming a full minute
// before the audience sees it, which is enough time to arm something.
//
// args: channel, cueType (spliceStart | spliceEnd | spliceCancel), immediate,
//       spliceEventId, uniqueProgramId, preRollMs, breakDurationSeconds, autoReturn,
//       absolute.  (All strings — this is the same args bag every trigger gets.)
//
// Scripts observe cues; they cannot alter or suppress one. To stop cues reaching air, use
// the channel's SCTE policy or the operator's Block SCTE control (AIR-143).
function main(trigger, channel, event, args) {
  if (trigger === "ScteAired") {
    air.Log("info", "ch" + channel + ": cue " + args.spliceEventId + " (" + args.cueType + ") is on air now");
    return;
  }

  if (args.cueType !== "spliceStart") return;

  air.Log("info",
    "ch" + channel + ": ad break " + args.spliceEventId + " incoming — " +
    args.breakDurationSeconds + "s long, pre-roll " + args.preRollMs + "ms");

  // An absolute-timestamped cue names a wall-clock instant the delay has already carried us
  // past, so Airlock drops it rather than tell the plant to splice at a moment that is gone.
  if (args.absolute === "true") {
    air.Log("warn", "ch" + channel + ": cue carries an absolute timestamp — it will NOT be re-aired");
  }

  // Count the breaks we have seen today (persistent script variables, AIR-59).
  const n = parseInt(air.GetVar("inbound_breaks") || "0", 10) + 1;
  air.SetVar("inbound_breaks", String(n));
}
