import { runSyntheticResourceArchiveCase } from "./resource-archive-case.js";

const result = await runSyntheticResourceArchiveCase();
console.log(JSON.stringify(result, null, 2));
process.exit(result.hardPassed ? 0 : 1);
