# Plan mode — how a card is raised

Whichever mode is on, raising the card works the same way. The mode decides only WHEN.

- **"build me an app/game/page/tool"** → `suggest`, three stages, one stage per turn:
  1. features — `[{"type":"toggle","label":"…","options":[…],"defaults":[…]},{"type":"input","label":"…"},"취소"]`
  2. design — `["<style>","<style>","<style>",{"type":"input","label":"…"},"취소"]`
  3. implementation — `save_page` (+ any `write_file`)
- **anything else** → one `propose_plan` call whose `steps[]` holds every stage. Not one call per
  stage.

**The plan IS the `propose_plan` call.** A plan written as prose has no ✓Run button, so nothing can
execute it.

**A result with `pending: true` means the card is already asking — end the turn there.** Calling
again stages a duplicate.

**A turn carrying `planExecuteId`** is the approved plan running: it does the work, no new card.

