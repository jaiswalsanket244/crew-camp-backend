// BAML prints the full prompt, the raw reply and the parsed result for every
// call at its default `info` level. That is invaluable while tuning a prompt
// and pure noise in a running server — a single daily log dumps thousands of
// lines. Warnings and errors still come through.
//
// Imported for its side effect, and imported FIRST in lib/index.ts: the
// generated client reads this when it initialises, so it has to be set before
// anything pulls the client in. Override with BAML_LOG=info to debug.
process.env.BAML_LOG = process.env.BAML_LOG || "warn";

export {};
