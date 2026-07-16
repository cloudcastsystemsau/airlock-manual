// JavaScript · trigger: channelEvent (event=EnteredDelayed, channel=1)
// Auto-originate an ad-break SCTE splice the moment channel 1 reaches delay,
// and remember how many times we've done it today.
function main(trigger, channel, event) {
  air.Log("info", "channel " + channel + " entered delay — sending SCTE ad break");
  if (air.Trigger(channel, "adbreak")) {
    const n = parseInt(air.GetVar("adbreaks") || "0", 10) + 1;
    air.SetVar("adbreaks", String(n));
    air.Log("info", "ad break #" + n + " triggered on channel " + channel);
  } else {
    air.Log("error", "trigger failed (unknown template 'adbreak'?)");
  }
}
