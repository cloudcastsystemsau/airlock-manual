// Bind with trigger "scriptDelayed" (identifier filter empty = any).
// Fires when an air.After one-shot comes due; args.identifier says which.
// Pairs with the "arm" example: brk-out inserts the start with the message's
// length as a per-call override; brk-in inserts the return that ends the break.
function main(trigger, channel, event, args) {
  var ch = parseInt(air.GetVar("brk_ch") || "1", 10);
  if (args.identifier === "brk-out") {
    var ok = air.Trigger(ch, "break", { operation: "spliceStartNormal", preRollMs: 4000,
                                        breakDurationMs: parseInt(air.GetVar("brk_len_ms") || "30000", 10) });
    air.Log("info", "break START insert -> " + ok);
  } else if (args.identifier === "brk-in") {
    var ok2 = air.Trigger(ch, "break", { operation: "spliceEndNormal", preRollMs: 4000 });
    air.Log("info", "break RETURN insert -> " + ok2);
  }
}
