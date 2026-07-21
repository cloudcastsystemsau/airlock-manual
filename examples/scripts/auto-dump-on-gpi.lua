-- Lua · trigger: gpi (index 0)
-- Panic dump: when the studio GPI fires, dump channel 1 immediately.
-- Bound with trigger kind = gpi, GPI index = 0. Called as main(trigger, channel, event).
function main(trigger, channel, event)
  air:Log("warn", "panic GPI " .. event .. " — dumping channel 1")
  if air:Dump(1) then
    air:Log("info", "channel 1 dumped, state=" .. air:State(1))
  else
    air:Log("error", "dump refused (channel 1 not in delay?)")
  end
end
