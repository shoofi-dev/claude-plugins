# How to file a task to the Shoofi agents

For whoever is asking for the work — product, ops, or engineering. **You do not need to
know which agent, which repo, or which file.** Describe the outcome; the routing is
automatic.

## The loop

1. You describe what you want, in plain language.
2. The main agent picks the domain owner(s) — menu-catalog, orders, payments, accountant,
   delivery, customers — from what you wrote.
3. That agent loads its context doc, does the work, runs the checks.
4. It opens a **pull request and stops. It never merges.**
5. A human reviews and merges. **That review is the only gate**, so nothing reaches
   production unseen.

## Write the outcome, not the implementation

| Instead of | Write |
|---|---|
| "add a tip field to orderDoc" | "customers should be able to tip the driver at checkout" |
| "fix the cache clear in byCategory" | "the menu still shows items after the owner marks a whole category out of stock" |
| "change DELIVERY_STATUS in partner" | "the store sees the order as delivered while the driver is still on the way" |

The right-hand column routes better *and* lets the agent fix the actual cause rather than
the symptom you guessed at.

## A good task has three things

1. **What someone should be able to do** (or what's going wrong).
2. **Who it's for** — customer, store owner, driver, admin. This alone usually decides
   which app is involved.
3. **How you'd know it worked** — the observable result.

> *"Store owners are getting paid for cancelled orders. On the monthly report, an order
> the customer cancelled still counts in the store's revenue. It should be excluded — the
> report total should drop by the cancelled amount."*

That's enough. It routes to `accountant`, and the "how you'd know" gives a check to verify against.

## For a bug, add whatever you have

An order number, a store name, a screenshot, when it started, whether it's every time or
sometimes. There's an `investigate-order` skill that can pull a full order timeline from an
order number — so an order number is worth a lot.

## Bigger requests

For anything touching more than one area, ask for the plan first:

> **"Which domains does this touch?"**

You'll get the decomposition before any code is written — a chance to catch a missing piece
(*"…and it needs to reach the driver payout"*) while it's still free.

## What comes back

A PR with: what changed, what was verified (lint/tests/checks with real output), and
anything deliberately left untouched. Money and identity changes arrive as **drafts marked
HIGH-RISK**, with extra tests and a "what could break" section — read those closely.

## What the agents will not do

- **Merge anything.** Ever.
- **Touch payments/auth internals** without an explicit decision from a human.
- **Delete legacy code.** It's known and deliberately parked.
- **Guess past a real ambiguity** — they'll ask instead.
- **Act on a "known" issue** (planned JWT rotation, OTP hardening) — those are scheduled
  work, not bugs to be discovered again.

## When to expect a question

If the request is ambiguous enough that guessing wrong wastes the work, you'll get one
question instead of a wrong PR. Answer it and the work continues — you won't be pinged
again mid-task.
