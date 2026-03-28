import { cleanTmpDir, getTmpDirSummary } from "./tmp-maintenance.js";

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const command = (process.argv[2] ?? "status").trim().toLowerCase();

switch (command) {
  case "status":
    printJson({
      ok: true,
      command: "status",
      summary: getTmpDirSummary(),
    });
    break;
  case "clean":
    printJson({
      ok: true,
      command: "clean",
      report: cleanTmpDir(undefined, "normal"),
    });
    break;
  case "prune":
    printJson({
      ok: true,
      command: "prune",
      report: cleanTmpDir(undefined, "prune"),
    });
    break;
  default:
    process.stderr.write("Usage: node dist/tmp-clean.js <status|clean|prune>\n");
    process.exitCode = 1;
    break;
}
