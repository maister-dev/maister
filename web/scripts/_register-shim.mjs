import { register } from "node:module";

register("./_server-only-shim.mjs", import.meta.url);
