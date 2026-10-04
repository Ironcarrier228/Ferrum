#!/usr/bin/env node
import { main } from "../src/cli/main.mjs";
main(process.argv.slice(2)).then((code) => { process.exitCode = code ?? 0; }, (e) => { console.error(`ferrum: ${e?.message ?? e}`); process.exitCode = 1; });
