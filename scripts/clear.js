import { runtimePaths } from "../src/config/defaults.js";
import { ResponseStore } from "../src/state/response-store.js";

const paths = runtimePaths(process.env);
const store = new ResponseStore({ filePath: paths.responsesPath });
await store.clear();
console.log(`Cleared response sessions: ${paths.responsesPath}`);
