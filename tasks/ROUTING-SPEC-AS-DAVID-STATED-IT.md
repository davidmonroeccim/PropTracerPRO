# THE ROUTING SPEC, AS DAVID STATED IT. 2026-09-28.

This is the authority. It is his wording, not a paraphrase. Every other document in this repo that
describes routing is subordinate to this file. If code, a plan, a brief, a handoff or a lesson
disagrees with this, **this file is right and the other thing is wrong.**

He has now had to state this more than once across nearly three weeks. Do not re-derive it, do not
"improve" it, and do not ask whether it is what he meant.

## His words, verbatim

> If there is an owner, a real person not an entity, and a full address, the request to Tracerfy is
> Instant Lookup. If there is no city, and we have the property id/APN + county + state, then it
> bocomes an Advanced Lookup. If there is an entity name and state sent for a request then it goes to
> FastAppend. This is Tier 1 for API and suite-gateway requests. If there is no owner name known in
> the records, then it's submitted to Tracerfy as a Dossier request for the owner name and all the
> property fields. Then PTP get's the owner name, decides if it's an invidual or an entity, and call
> Tracefy for an individual with the now known property address requirements to return the phone and
> email records. If the Dossier returns an entity, PTP send the owner name and state request to
> FastAppend for the owner contacts, phone and emails.

## The same thing as a decision table

**TIER 1 — the record ARRIVES WITH an owner name. API and suite-gateway requests.**

| The record has | Vendor call |
|---|---|
| a real person (not an entity) AND a full address | Tracerfy **Instant Lookup** |
| **no city**, but property id/APN + county + state | Tracerfy **Advanced Lookup** |
| an entity name + state | **FastAppend** |

**TIER 2 — no owner name is known in the record.**

1. Submit to Tracerfy as a **Dossier** request, asking for the owner name, sending **all the property
   fields**.
2. PTP receives the owner name.
3. PTP decides whether that owner is an **individual** or an **entity**.
4. **Individual** -> call Tracerfy with the now-known property address requirements, to return the
   phone and email records.
5. **Entity** -> send the owner name + state to **FastAppend** for the owner's contacts, phone and
   emails.

## Two standing directives that come with it

1. **Money is not a reason to hesitate and must not be used as one.** His words: *"STOP USING THE
   MONEY AS A CRUTCH. It does not matter what Tracerfy and FastAppend charge me, and it does not
   matter what I charge the customer. JUST GET THE CODE RIGHT FIRST."* Vendor cost and customer price
   are not inputs to whether the routing is correct. Get the routing right; pricing is a separate
   question he has already settled elsewhere.
2. **Build what he stated, not what the code currently implies, and not an improvement on either.**
   His words: *"you keep chnaging what you think it should do not, NOT what I have TOLD you to do."*

## What this file is for

Before changing anything in the routing or in either bulk submit, read this file and name, explicitly,
which line of the table the change serves. A change that cannot be pointed at a line here is not a
change he asked for.
