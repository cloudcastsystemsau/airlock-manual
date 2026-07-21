-- Bind with trigger "manual" (Run) — a reference card for ORIGINATING SCTE cues.
-- Everything static lives in a saved trigger template (Triggers page; here "break").
-- The third argument overrides it per call: operation, preRollMs, breakDurationMs,
-- breakDurationFrames — the same vocabulary as the REST trigger endpoint (AIR-151).
-- SCTE 104 §11.3: pre-roll must be >= 4000 ms for timed splices, zero only for
-- immediates. Originated splices never set auto_return: the RETURN cue is what
-- actually ends the break, so always plan to send one (see the After examples).
function main(trigger, channel, event, args)
  local ch = 1

  -- timed break start: downstream splices out 4 s after this cue airs, 30 s planned
  if air:Trigger(ch, "break", { operation = "spliceStartNormal", preRollMs = 4000, breakDurationMs = 30000 }) then
    air:Log("info", "break start signalled on ch" .. ch)
  end

  -- the other operations, same shape:
  -- air:Trigger(ch, "break", { operation = "spliceEndNormal",  preRollMs = 4000 })  -- timed return
  -- air:Trigger(ch, "break", { operation = "spliceStartImmediate" })                -- splice out NOW
  -- air:Trigger(ch, "break", { operation = "spliceEndImmediate" })                  -- early termination
  -- air:Trigger(ch, "break", { operation = "spliceCancel" })                        -- cancel a signalled event
end
