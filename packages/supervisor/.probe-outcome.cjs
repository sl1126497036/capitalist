const { mkdtempSync, mkdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const cap = require("./dist/core/record/supervisor");
const cmds = require("./dist/core/dispatch/commands");
const { createTaskRoot } = require("./dist/core/contract/init");

const base = mkdtempSync(join(tmpdir(), "probe-outcome-"));
for (const d of ["runtime", "ledger", "model", "board", "config", "meta", "workers", "sessions", "inbox", "mq", "guard", "brain", "reload", "locks", "archive", ".root"]) {
  mkdirSync(join(base, ".capitalist", d), { recursive: true });
}
createTaskRoot({ target: "探针", contractSpec: "minimal", root: base });
cap.appendDispatch(base, {
  id: "D-e",
  at: new Date().toISOString(),
  stage: "S0",
  shard: "",
  action: "做 D-e",
  status: "claimed",
  lineage: "D-e",
});
const rec = cmds.appendDirective(base, { text: "这条做完了", stage: "S0" });
const taken = cmds.claimDirectives(base, { shard: "", stage: "S0", dispatchId: "D-e", lineage: "D-e" });
console.log("claimed =", taken.length);
console.log("ref =", cmds.directiveRef(rec));
const r = cmds.markDirectiveOutcome(base, cmds.directiveRef(rec), "done", { note: "改了 styles.css", by: "D-e" });
console.log("result =", JSON.stringify(r));
