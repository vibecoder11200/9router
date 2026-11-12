import { register } from "node:module";
register(new URL("../scripts/lib/alias-loader.mjs", import.meta.url).href, import.meta.url);
const { opencodeFreeLaneFetch } = await import("open-sse/services/opencodeBunLane.js");
const url = process.argv[2];
const timeoutMs = Number(process.argv[3] || 5000);
await opencodeFreeLaneFetch(url, { method: "GET" }, { timeoutMs });
console.log("victim settled (should NOT happen before the kill)");