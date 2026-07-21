// C# · trigger: schedule (cron, e.g. every 5 min "*/5 * * * *")
// Log a one-line status snapshot for channels 1 and 2. C# runs the whole body;
// the trigger context is available as Trigger / Channel / Event.
Log("info", $"status report ({Trigger}):");
foreach (var ch in new[] { 1, 2 })
    Log("info", $"  ch{ch}: state={State(ch)} depth={Depth(ch)}f encoder={(GetEncoder(ch)?.Running == true ? "up" : "down")}");
