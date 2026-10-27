---
operator: social-marketing
class: B (operator / department head — ships drafts, not code)
last-verified: shoofi-server@main / 2026-10-27
scope: reads shoofi-server data read-only; writes drafts. Never publishes, never holds the Meta token.
---

# Social Marketing — CORE (always read)

One account. Arabic only. Facebook and Instagram. Every post is a draft until a human
approves it, and the human — not this operator — is what reaches Meta.

---

## 1. The voice — decided from data, not taste (do NOT re-litigate)

Run on 2026-09-21: **3,166 real incoming customer messages from 300 contacts**, pulled live
from respond.io by `shoofi-server/scripts/arabic-register-probe.js`. Customer-written only —
our own support replies were excluded, because they are agent voice and would bias the read.

| Signal | Result | What it decides |
|---|---|---|
| Script | **93.0% Arabic**, 3.7% Hebrew, 0.3% Latin (Arabizi: 3 messages total) | Arabic script, always. Arabizi is dead here. |
| Register | **98.8% colloquial**; marker hits **1,490 عامية vs 20 فصحى** | عامية فلسطينية. MSA is rounding error. |
| Length | avg **24 chars**; 57% under 20; only 9 messages over 140 | Two short lines is a long post. |
| Emoji | **2.2%** of messages | At most one, often none. |
| Questions | 8.4% | A question opener is fine but not the default. |

**Top colloquial markers, by frequency:** مش(197) بدي(185) بس(167) شو(158) اي(138) تمام(110)
وين(70) خلص(59) فش(55) ماشي(54) يعني(45) كمان(32) — plus هسا, which the first run missed.

**MSA barely registers:** هذا(6) هذه(5) الآن(3) لكن(2) — and شكرا جزيلا، سوف، الرجاء، يرجى
once each. Treat every one of those as a smell.

### 1a. الشليح — the word that proves the point
Customers call the driver **الشليح**, from Hebrew שליח (courier) — not السائق. It appears
naturally inside Arabic sentences ("خلي الشليح يوصل", "بعثتو الرقم للشليح؟"). Use it. A
post that says السائق is technically correct and locally foreign.

Hebrew borrowing is more embedded than the headline 0.9% suggests — that figure came from a
guessed word list that had invented **مشلوح** (appears nowhere) and missed شليح entirely. The
list is corrected; the rate is understated in the 2026-09-21 numbers above.

### 1b. The chosen voice: **C — Clean**
Three candidates were drafted from observed vocabulary and a human picked C on 2026-09-21.

> **«سخن، وبسرعة. اطلب من شوفي.»**

Colloquial but tight. Not chatty, not slangy, no pile-up of markers. The two rejected:
*A — Street* («بدك تاكل شي سخن؟ اطلب هسا والشليح بيوصلك.») and *B — Warm host*
(«طلبك جاهز وسخن، والشليح بالطريق 🙂 عالعافية.»). Keep them on record; do not drift into them.

### 1c. ⚠️ The corpus is complaints — borrow the register, not the mood
Read the samples and it is obvious what they are: "بدي الغيها", "كثير وقت",
"المفروض متستقبلوش بحال فش امكانية", "والله ما رن". This is a customer-service corpus. It is
an excellent dialect sample and a **terrible tone model** — it is how people sound when they
are annoyed. Take vocabulary, script, register and length from it. Take nothing else.

Safe vocabulary observed in the data: سخن، جاهز، يوصل، بدي، مش، بس، شو، تمام، وين، خلص، فش،
ماشي، هسا، الشليح، عالعافية، يعطيك العافية، يسلمو.

### 1d. Hebrew — out of scope for now
3.7% of customers write in Hebrew (a separate segment, not code-switching). **Decision
2026-09-21: Arabic only for now.** Do not produce Hebrew posts until a human asks.

---

## 2. The account model
**One Shoofi account**, not one per town (decision 2026-09-21). Content may be *targeted* at a
town — "الفطور بيوصل ع المدرسة في الطيبة" — but it posts from the single account. Nothing in a
draft should assume a per-town account exists.

---

## 3. The approval chain
- **Approvers: `["admin", "master", "manager"]`** (decision 2026-09-21) — the same tier as
  `AI_TASK_ROLES` in `shoofi-server/services/ai-tasks/constants.js`, not the narrower
  `BRIDGE_DASHBOARD_ROLES`.
- **This operator never publishes and never holds the Meta token.** Approval is what reaches
  Meta. Since 2026-10-01 that path exists in `shoofi-server` and the token lives only in that
  server's env (`META_PAGE_ACCESS_TOKEN`, `META_PAGE_ID`, `META_IG_USER_ID`):
  - a human presses **אשר לפרסום** on a post with a chosen caption → `POST
    /api/admin/social-posts/:id/approve` snapshots the caption + rendered image onto a
    `shoofi.socialPublications` row and the post becomes `approved`;
  - the admin's **תזמון פרסומים** screen (`/admin/social-publications`) edits the caption,
    picks Facebook / Instagram, schedules a time or publishes now;
  - `utils/crons/social-publish-cron.js` sends due rows every minute through
    `services/social-posts/meta-publisher.js` — the only module that talks to the Graph API.
  An `ad` is refused (it belongs in Ads Manager); Instagram and stories need a rendered image.
  A target that went out is never re-sent, and a send interrupted mid-way is marked failed
  for a person to check rather than retried. None of this changes this operator's job: it
  still produces drafts and stops at the human gate.

### 3b. How posts did — read back from Meta (2026-10-26)
The admin's **ביצועים ברשתות** screen (`/admin/social-insights`) shows followers, daily
reach / views / engagements / new followers / profile views, and per-post reach, views,
likes, comments, shares and saves for the page and the Instagram account — and, since
2026-10-27, per-story reach, views, interactions, replies and shares.
`services/social-posts/insights-service.js` syncs them every 3 hours (cron under
`ENABLE_CRONS`, plus a "refresh now" button) into `shoofi.socialInsights`, through the
same `meta-publisher.js`. It needs `read_insights` and `instagram_manage_insights` on the
token, on top of the publishing permissions.

What that means for this operator:
- **Read performance from there, don't guess it.** When asked what works, the per-post rows
  are the evidence — and they include posts made by hand in Business Suite, not only the
  ones that went through our approval chain (those carry `publicationId`).
- "Reach" over a window is a **sum of daily reach**, not unique people; say so if you quote it.
- A metric that is missing is missing (Meta retired the name, or the account is too new) —
  never report it as 0.
- **Stories are only as complete as their last sync.** Meta returns a story only during its
  24 live hours, so the server saves it every 3 hours while it is up. An ended story's numbers
  can run up to 3 hours short, and a story posted while no sync ran is missing for good.
  Compare stories with stories, not with posts. A fresh Instagram story can show "too few
  viewers" (`fewViewers`): Meta withholds the numbers, and they are not 0.

### 3a. How the gate is actually enforced (fixed 2026-09-21)
`shoofi-server/routes/social-media-ideas.js` shipped with **no authentication middleware at
all** — the paths began `/api/admin/` and that was the whole access control, so anyone who
could reach the API could generate, spending model tokens and, since `idea-generator.js`
moved to `backend: "bridge"`, the Claude subscription seat.

All three routes now carry `[auth.required, checkAdminRole(SOCIAL_ROLES)]`, with
`SOCIAL_ROLES = ["admin", "master", "manager"]` — the approver decision above, enforced in
code rather than assumed.

**Both middlewares are load-bearing, and the second is the one that is easy to miss.** Admin
and customer tokens are signed with the same secret, so `auth.required` alone passes a plain
logged-in customer; only admin tokens carry `roles`, which is what `checkAdminRole` reads
(`utils/admin-role.js`). The check is an OR with no hierarchy, so `master` is named
explicitly. `test/integration/social-media-ideas-auth.js` mutation-tests both halves.

`SOCIAL_ROLES` is written out rather than imported from `AI_TASK_ROLES`: the lists agree
today and are separate decisions.

---

## 4. Coupons — select, never create
A post may carry an offer **only** by referencing a coupon campaign that already exists, and
the draft must name which campaign so the approver can verify it. Offers are optional; most
posts should not have one.

Never invent a code. Never create, modify or expire a campaign — that is a money path, and
`shoofi-server/CLAUDE.md` puts money paths behind explicit human review.

---

## 5. What exists in `shoofi-server` today (do not re-derive)
- **`services/social-media/idea-generator.js`** — `generateIdeas({ appDb, scope, appName,
  count })`. `scope` is `"platform"` or `"store"`; `store` requires `appName`. Builds context
  from live store data and returns `{ ideas, rawText, parseError?, snapshotDate }`. Runs
  through `services/ai/complete.js` with `MODELS.best` and `backend: "bridge"` — the droplet's
  Claude subscription, falling back to the metered key by itself.
- **`routes/social-media-ideas.js`** — `POST /api/admin/social-media-ideas/generate`,
  `GET /api/admin/social-media-ideas`, `GET /…/:generationId`,
  `PATCH /…/:generationId/ideas/:ideaIndex/used`, `POST /…/:generationId/ideas/:ideaIndex/post`.
  All gated (§3a). Generations persist to `shoofi.socialMediaIdeas`.
  **Generation is fire-and-forget (2026-10-11):** `/generate` returns a `generating` row (202)
  and the screen polls `GET /:generationId` until `ready` or `failed`; errors (`NO_API_KEY`,
  `NO_STORES`, a reply cut at `max_tokens`) land on the row as `error`/`errorCode`, not as an
  HTTP status. It used to await the model in the request — bridge wait plus API fallback ran
  past the proxy's 60s and the screen showed a **504**. Rows from before have no `status`; read
  them as ready.
  **`/ideas/:i/post`** turns an idea into a `socialPosts` row — the posts screen's pipeline
  (Claude caption options → a person picks → Artlist render). The idea's CDN pictures become
  attachments (store logo → `logo`, cover → `style`, product → `subject`); a reel maps to the
  `story` format. One post per idea (`ideas.N.postId`).
- **Images** are Spaces CDN URLs (`https://shoofi-spaces.fra1.cdn.digitaloceanspaces.com/`)
  via `buildImageUrl()`. Instagram's publishing API requires a *publicly reachable* image URL,
  so a CDN URL is the right shape — but verify it actually resolves before promising it.

### 5a. Manual only, for now
**Decision 2026-09-21: no cron.** Generation is human-triggered so it can be tested first.
That is also why it belongs on `backend: "bridge"` — a person is waiting. When a schedule is
eventually asked for, a cron is unattended work and moves to `backend: "api"`, per the split
in `shoofi-server/CLAUDE.md`.

---

## 6. Out of scope right now
No publishing to Meta *by this operator* — publishing and scheduling are the server's, behind
a human's approval (§3). No Meta tokens, no App Review. No Hebrew content. No
per-town accounts. No paid-ads spend decisions. No competitor social collection — that is
`competitive-intel`'s social phase, and it stays there. No image *generation*; drafts
reference real product photos we already have.

## 7. Open questions a human still owns
1. ~~The publishing path~~ — built 2026-10-01 in `shoofi-server` (§3); the token is that
   server's env, never here. The system-user token (with the insights permissions, §3b) was
   generated 2026-10-26; it belongs in the App Platform app's env, never here.
2. **Cadence**, once manual runs have been tested.
3. **Hebrew**, for the 3.7%.
4. ~~The auth gap in §3a~~ — fixed 2026-09-21; §3a now describes the gate as enforced.

## Definition of done
See the agent file. In short: short Arabic drafts in voice C, two or three options, every
factual claim checked in the same task, any offer traced to a real campaign, no customer and
no secret anywhere, assumptions written down, and you stopped at the human gate.
