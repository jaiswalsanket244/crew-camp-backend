// Shared model clients and retry policy for EVERY AI feature in this backend.
// A new feature reuses a client from here rather than declaring its own, so
// provider details, keys, temperature and retry behaviour are defined once.

// Transient 429s and 5xx are the common failure. Backoff rather than a flat
// delay so a rate-limited burst spreads out instead of retrying in lockstep.
retry_policy Standard {
  max_retries 2
  strategy {
    type exponential_backoff
    delay_ms 500
    multiplier 2
    max_delay_ms 8000
  }
}

// Extraction, classification, summarising from supplied facts — cheap and
// fast, and enough for everything so far. A feature needing a stronger model
// declares its own client here, justified against an eval.
//
// The model is named here rather than read from the environment: the prompts
// in baml_src are tuned against this specific model, so changing it is a code
// change that belongs in review next to them, not a server setting someone can
// flip underneath a prompt that was never evaluated against the new model.
client<llm> Fast {
  provider openai
  retry_policy Standard
  options {
    model "gpt-5.4-mini"
    api_key env.OPENAI_API_KEY
    temperature 0
    // Restores the cap the hand-written service had. gpt-5.x and the o-series
    // reject max_tokens, so the completion-tokens form is the portable one.
    // It must also cover hidden reasoning tokens on models that produce them.
    max_completion_tokens 3000
  }
}
