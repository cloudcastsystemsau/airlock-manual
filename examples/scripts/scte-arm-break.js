// Bind with trigger "dataReceived" (receiver = your automation feed).
// Message: "BREAK <channel> <noticeSec> <lengthSec>", e.g. "BREAK 1 30 60".
// Verified live 2026-07-13: cues landed frame-exact on NDI and 4.4 s notice on
// the SRT SCTE-35 rail, break length on the wire matching the message.
// The cue must AIR when the content the notice refers to airs, so the insert
// waits notice + depth - preRoll; the return waits length longer. air.After
// one-shots are named: re-arming the same name REPLACES it (a moved break is
// just another message), and air.CancelAfter(name) drops it.
function main(trigger, channel, event, args) {
  var m = /^BREAK\s+(\d+)\s+(\d+)\s+(\d+)/.exec(args.data.trim());
  if (!m) return;
  var ch = parseInt(m[1], 10), notice = parseInt(m[2], 10), len = parseInt(m[3], 10);
  var FPS = 50, P = 4;
  var depthS = air.Depth(ch) / FPS;                      // read the REAL depth — never assume it
  air.SetVar("brk_ch", String(ch));
  air.SetVar("brk_len_ms", String(len * 1000));
  air.After(Math.round((notice + depthS - P) * 1000), "brk-out");
  air.After(Math.round((notice + depthS + len - P) * 1000), "brk-in");
  air.Log("info", "armed ch" + ch + ": break in " + notice + "s for " + len + "s (depth " + depthS + "s)");
}
