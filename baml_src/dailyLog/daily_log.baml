// Stage 1 of the daily-log pipeline: crew notes -> structured facts.
//
// The type below replaces three hand-maintained things in the TypeScript
// service: the IExtractedJob interface, the JSON schema literal, and the
// per-field String(x ?? "").trim() parsing.

class ExtractedJob {
  area string @description("The room, zone or trade the work belongs to, as the notes name it.")
  item string @description("The thing being worked on, as a short noun phrase: 'the kitchen wall units', 'the strike plate on the master bedroom door'. A room is not an item.")
  done string @description("What was actually completed. Empty string if NOTHING was completed.")
  todo string @description("The outstanding work as one finished, actionable instruction. Empty string if nothing is outstanding.")
}

function ExtractJobs(photo_notes: string) -> ExtractedJob[] {
  client Fast
  prompt #"
    You read the notes a construction crew attached to a day's photos and turn
    them into structured facts. You do NOT write prose.

    Rules:
    - SEVERAL PHOTOS OFTEN SHOW THE SAME ITEM. Crews shoot one fitting from two
      or three angles. That is ONE entry, not two.
    - A note usually contains BOTH halves: "wall units hung and levelled, but the
      doors are not adjusted yet" is one entry — done is "hung and levelled off
      the laser line", todo is "Adjust the wall unit doors."
    - done HOLDS ONLY THE FINISHED HALF. If the note says "Mortise lock fitted,
      brushed steel, keyed both sides. Latch engages but the strike plate needs
      shimming", then done stops at "keyed both sides; latch engages" and the
      shimming goes in todo. Never carry an outstanding clause into done.
    - SOME NOTES DESCRIBE ONLY A DEFECT AND NO COMPLETED WORK. "Paint touch-up
      needed around the switch plate", "socket box sits proud of the tile by
      2mm". Nothing was finished, so done MUST be the empty string. Writing the
      defect into done makes the report claim work was completed when it was not.
    - THE TODO IS A FINISHED LINE, not a fragment. It goes into the report
      EXACTLY as you write it — nothing downstream rewrites it, so anything you
      leave out is lost. Start with the verb and name the item and where it is:
      "Shim the strike plate on the master bedroom door and pack out the frame."
      NOT "Shim the strike plate." NOT "Tape the plasterboard." — a reader who
      was not on site cannot act on those.
    - KEEP THE TIMING AND THE DEPENDENCY: who is coming and when, how long a
      delivery takes, what is booked, what has to be decided first. "once the
      tiler is back Thursday", "the hood is on a 10 day lead", "the sparky is
      booked for Wednesday", "price it up before committing", "the client wants
      it by Friday". These tell the crew when the job can actually happen.
    - STATE A MEASUREMENT AS THE REASON, NEVER THE GOAL. Write "Adjust the wall
      unit doors and shim behind the last carcass; the left-hand run is 2mm out
      at the end." NEVER "adjust the units so the run is 2mm out" — that tells
      the crew to create the fault.
    - A NOTE ABOUT MATERIALS OR STORAGE IS NOT A TASK. "Two boxes left over,
      stored in the garage" is neither done work nor a todo — skip it.
    - Never invent. Every word must be supported by the notes. A photo marked
      [no notes recorded] produces no entry.
    - Do not translate proper nouns or identifiers ("Bldg C", "Unit 214", model
      numbers). Keep trade terms exactly as the notes wrote them.
    - Copy the specifics across. Losing "300x300" or "2mm" here loses it from
      the report.

    {{ _.role("user") }}
    {{ photo_notes }}

    {{ ctx.output_format }}
  "#
}
