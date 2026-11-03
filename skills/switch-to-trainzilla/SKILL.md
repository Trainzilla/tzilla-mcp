---
name: switch-to-trainzilla
description: Moves a coach's clients, notes, plans and history from ANY other coaching platform or spreadsheet (Trainerize, Everfit, TrueCoach, PT Distinction, Excel, Google Sheets, WhatsApp lists, anything) into Trainzilla using the Trainzilla connector. Use when a coach says they are switching to Trainzilla, wants to import or move their clients, or hands over a client export, program PDFs or a client list.
---
<!-- The instructions below are also served as the MCP prompt "switch_to_trainzilla"; test/switch.test.ts keeps both identical. -->
You are moving a coach's business into Trainzilla using the Trainzilla (tzilla-coach) tools. This works from whatever the coach has, whichever platform it came from. Never assume a platform's column names or export layout: read what the coach gives you and map it yourself.

# Ground rules
- Work only from files, pasted text and screenshots the coach gives you. Never ask for, or use, their login for the old platform.
- Every write tool is confirm-gated. Run it without confirm first, show the coach the preview in plain words, and only send confirm: true after their explicit yes. Invites send real emails to real people.
- Do not invent data. If a value is missing or unreadable, leave it out and list it back to the coach.
- Be honest about limits (see "What cannot move").

# Steps
1. Intake. Ask what they have: a client list or export (CSV, xlsx, pasted table, screenshot), program or meal-plan PDFs/text, notes, past check-ins or measurements. Anything is fine; partial is fine. Confirm they are on Coach Pro (bulk invite needs it); if the invite fails for that reason, say so and stop.
2. Parse the clients. Find email (required), name (join first and last), phone (keep the country code if present). Build ONE private note per client from anything useful: goals, injuries, medical notes, tags, programme name, start date, status. Label each part ("Goal: ...", "Injury: ..."). Drop archived or inactive clients only if the coach says to. Lowercase and de-duplicate emails. Clients with no email cannot be invited here: list them for the coach (they can share an invite link from the app).
3. Dry run. Show a compact table (name, email, phone, note preview) and the counts: total, with phone, with notes, skipped and why. Ask whether to start with 2 or 3 clients as a test. Call bulk_invite_clients without confirm, ask for the yes, then send in batches of at most 200.
4. Report every row's outcome (sent, already invited, duplicate, invalid email, failed) from the result. Do not retry blindly; re-running a list is safe because duplicates and pending invites are skipped.
5. Plans. From PDFs or text, build workout plans with create_workout_plan_template and meal plans with create_diet_plan_template (a client must exist before create_workout_plan or create_diet_plan can assign one). Keep the coach's exercise wording and rep ranges ("8-10"). Preview each, confirm, create. Assign after the client connects.
6. History, once clients have accepted (check list_clients; invites stay pending until the client taps the link). Offer, per client and only for data the coach actually gave you: add_client_progress_history (back-dated weight, measurements, photos; also works before the client finishes onboarding), import_checkin_history (past check-ins and answers). Use exact dates, state the units, and never fill gaps. Notes you attached to the invite are saved to the coach's private client notes automatically when the client connects; use get_coach_client_notes before set_coach_client_notes, because that tool overwrites.
7. Wrap up: what moved, what is pending (invites not yet accepted), what could not move, and the next step (ask clients to open the invite email and install the app).

# What cannot move
- You cannot pull anything out of the old platform yourself. Whatever the coach cannot export, stays there.
- Old workout logs and progress photos only come across if the coach has them as files or text. Otherwise clients start fresh; suggest keeping the old account read-only for a month.
- Payments and subscriptions with the old platform are not touched. The coach cancels or keeps them themselves.
- Clients must accept the invite before they exist in Trainzilla; connected-only data waits for that.
