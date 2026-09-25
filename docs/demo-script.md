# One-minute demo script

Total: 60 seconds. Two screens side by side: Telegram on the left, Supabase table editor on the right. Have the strong note copied to the clipboard before you start.

## Setup (before recording)

1. `npm run telegram:webhook-info` and confirm `matches expected: true`.
2. Open the private Telegram channel where the bot is an administrator.
3. Open Supabase, table editor, `drafts` table, sorted by `created_at` descending.
4. Clear the Telegram channel view so the new messages are the only thing on screen.

## 0:00 to 0:10, the problem in one sentence

> "Meera records skincare notes in a private Telegram channel. She has sixty unused notes, forty abandoned drafts, and has not posted on LinkedIn in eleven weeks. This turns a note into a reviewable draft in under a minute, and it never posts anything."

## 0:10 to 0:20, send a real note

Paste into the Telegram channel and send:

```
Batch fourteen came back from the manufacturer and the pH stability data looked off. The supplier had quietly changed the preservative blend. The new system lowered the finished-product pH by about 0.4 units, enough to move the formula outside the optimal range for the emollient blend. The batch is not unsafe, but the texture changed. A same-formula reorder is not always the same formula. If you do not compare every CoA against a baseline, the customer may catch the change before you do.
```

Say while it sends:

> "The raw note is written to Postgres before any model is called, so nothing is ever lost."

## 0:20 to 0:40, the response arrives

The bot replies with a message shaped like this:

```
DRAFT 7K2QF9
SCORE: 9/10
WHY: A specific manufacturing observation with a measured pH shift and a clear implication.

[the draft, in Meera's voice, roughly 200 to 300 words]

NEWS SOURCE: Preservative supply shifts hit small skincare brands
FROM: Cosmetics Business | 2026-09-22
LINK: https://...
CHECK BEFORE PUBLISHING: You are the author of this claim.

Nothing is sent anywhere until you decide. Use the buttons below, or reply APPROVE 7K2QF9 or REJECT 7K2QF9.
                        [ Approve ]  [ Reject ]
```

Point at the screen and say:

> "Score first, with the reason, so she knows why it was worth drafting. Then the draft. If a news angle was used, the source block names the publication, the date and the link, and reminds her that she is the author of the claim. We only ever pass the headline and the RSS description to the model, so it cannot summarise an article nobody read."

## 0:40 to 0:50, show the gate, then the rejection path

Tap **Approve**. The buttons disappear, the bot confirms, and the post comes back on its own:

> "Draft 7K2QF9 is approved and saved. The post is in the next message, ready to copy into LinkedIn. This bot does not post anything."

The next message is the post body alone, in a code block with a one-tap copy control. Tap copy and say:

> "That is the handover. No id, no score, no source block, nothing to trim. She pastes it into LinkedIn herself, which is the whole point: the approval moved a row in Postgres, it did not publish anything."

Immediately send the weak note:

```
Remind me to reorder cartons tomorrow.
```

The bot replies:

```
SCORED 2/10, so no draft was written.

WHY: This is a personal reminder, not a point with evidence behind it.
```

Say:

> "That one never reached the drafting model at all. The scoring gate is the thing that protects her fifteen minutes."

## 0:50 to 1:00, show the record and the boundary

Switch to Supabase. Point at the `drafts` row, `status = approved`, then at `draft_reviews` showing who decided, when, and from which Telegram update.

Close with:

> "Every note, score, draft and decision is stored. Rejected drafts are kept, never deleted. And there is no LinkedIn credential anywhere in this system: approval marks a row in Postgres, and Meera does the posting."

## If something goes wrong on stage

- No reply within about fifteen seconds: run `curl -s https://<your-app>/api/health | jq` and show `checks.database.ok`.
- A `Something went wrong` message: it carries a request id. Show it in the Vercel logs filtered by that id. This is a legitimate part of the demo: the note is still stored and the failure is classified.
