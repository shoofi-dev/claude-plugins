---
operator: social-marketing
class: B (operator / department head — ships drafts and a weekly plan, not code)
last-verified: web research read 2026-11-19 (three reports: Instagram ranking and formats; Facebook ranking and Meta's APIs; food-delivery and Arabic-audience practice); shoofi-server@origin/main / 2026-11-19 (§9 what can be made and published); shoofi-server@feat/social-week-plan / 2026-11-19 (§9 intro, §12 the `social-plan` block)
scope: WHEN, WHAT and WHY we post on Shoofi's own Facebook Page and Instagram to grow followers. The voice is CORE.md §1; this file never overrides it.
---

# Social Marketing — PLAYBOOK (always read, after CORE.md)

CORE.md says **how we sound** and **who approves**. This file says **what to post, when, and
why** so the two pages gain followers. It is research, not taste: every rule carries a grade
and a source. When our own numbers contradict a rule here, our numbers win — record it in §12.

**Evidence grades**
- **[META]** — Meta or Instagram said it (a system card, a creators page, the head of Instagram).
- **[STUDY]** — a dataset, sample given. Almost all are vendor studies of their own customers,
  and correlational. Never compare a rate from one study with a rate from another: the
  denominators differ (followers, reach, views, impressions).
- **[OPINION]** — practitioner or trade view, or a small test.
- **[OURS]** — measured on our own pages (`shoofi.socialInsights`).
- *(via X)* — read in X's coverage, not at the first-party page itself.

---

## 0. Owner decisions — do not re-litigate

| # | Decision | Date |
|---|---|---|
| 1 | **Every week's posts need the owner's approval. Nothing auto-publishes.** The plan is a proposal; a person approves it (and may move a slot or edit its content) before anything is scheduled. | 2026-11-19 |
| 2 | **Start at 4 posts a week per page, plus Stories.** Raise it only on our own results (§3). | 2026-11-19 |
| 3 | **Arabic only.** Hebrew posts still wait for the owner's sign-off on the register (CORE.md §1d). | 2026-11-19 |
| 4 | **Hard rule: a dish is shown with the store's real menu photo or real restaurant footage. AI is only for Shadi, scenes and backgrounds.** Never an AI picture of a real restaurant's dish (§8). | 2026-11-19 |
| 5 | The goal of this work is **followers on both pages**; orders are a second reading, not the target. | 2026-11-19 |

---

## 1. The goal and the numbers that judge a post

| Number | What it is | Why it is the one |
|---|---|---|
| **Follower growth per month**, each page | the level in `socialInsights` day rows | The goal. **1.5–2% a month is a median small brand; 4–5% is strong.** |
| **Shares per reach** (shares ÷ reach), per post | the primary per-post number | Sends are the signal that carries a post to **non-followers** — which is where new followers come from. |
| **Follows from the post**, **non-follower reach** | where Meta returns them | The direct reading of "did this bring new people". |
| Watch time / skip rate (Reels), saves (carousels) | secondary | Explain *why* a post did or did not travel. |

- "The top three signals that matter most for ranking are watch time, likes and sends"; likes
  weigh slightly more for followers, **sends slightly more for non-followers**. **[META]** Mosseri,
  Jan 2025 *(via* https://www.socialmediatoday.com/news/instagram-shares-algorithm-insights-2025/738034/ *)*
- Sends per reach: "If you're a new creator, that's probably one of the most important metrics
  you could follow." **[META]** Mosseri, *(via* https://uppbeat.io/blog/creator-news/whats-working-on-instagram-right-now-carousels-and-sends-says-adam-mosseri, 2026-11-03*)*
- **Judge a post at 72 hours, not sooner.** 70% of views arrive in the first 3 days. **[STUDY]**
  Metricool, 24.4M posts / 375K accounts, https://metricool.com/instagram-trends/ (2026)
- **Do not judge by likes** and do not quote "engagement rate" without its denominator.
- **Growth benchmarks disagree** — say so when asked for a target:
  - 1–5K-follower brand accounts grew ~22% in 2025 on Instagram (38% in 2024) and ~23% on
    Facebook, i.e. ~1.7% a month. **[STUDY]** Socialinsider, 67.5M Instagram posts / ~25M Facebook
    posts, https://www.socialinsider.io/blog/instagram-benchmarks/ ·
    https://www.socialinsider.io/social-media-benchmarks/facebook
  - Only 21% of accounts under 10K grew at all in 2026. **[STUDY]** Metricool (press release, read as a summary).
  - Buffer shows a 7.5% monthly mean (Instagram) and 4.5% (Facebook) — a self-selected sample
    inflated by tiny accounts. **[STUDY]** https://buffer.com/insights/instagram-benchmarks
  - The "2–4% a month with weekly restaurant Collabs" figure in the research is an **inference,
    not a source**. Set targets from our own baseline.
- What we can read today is in §9c. A number Meta does not return is **missing, not 0** (CORE.md §3b).

---

## 2. How the two platforms decide who sees a post

### 2a. Instagram, by surface

| Surface | Who it reaches | What it predicts / rewards | Source |
|---|---|---|---|
| **Reels** | mostly non-followers | watching past 3 seconds; watching more than 95% of viewers of same-length reels; reshare, share off Instagram; comment; **follow the author** | **[META]** https://transparency.meta.com/features/explaining-ranking/ig-reels-chaining/ (2025-11-11) |
| **Feed** | followers + suggested posts | time on the post; **swiping the whole carousel**; sharing in a DM (informative content — reviews, tutorials, news — predicts it); profile visit; sound on | **[META]** https://transparency.meta.com/features/explaining-ranking/ig-feed (2026-06-29) |
| **Explore** | non-followers | follow, save, reshare, comment; watching a reel > 11 s or a non-reel > 6 s | **[META]** https://transparency.meta.com/features/explaining-ranking/ig-explore/ (2026-06-22) |
| **Stories** | **followers only** | reply (strongest), poll vote, tap to profile | **[META]** https://transparency.meta.com/features/explaining-ranking/ig-stories/ (2025-09-18) |
| **Search** | anyone searching | words matched to the **username / profile name**; how close the searcher is to the author; clicks in the same country, region, city | **[META]** https://transparency.meta.com/features/explaining-ranking/ig-search/ (2026-06-23) |

- New content is first shown to a small audience, follower or not; the best performers go
  wider. Eligibility: original, no visible watermark, inside the guidelines. **[META]**
  https://creators.instagram.com/recommendations-and-originality (2024-04-30)
- Mosseri's four principles: **originality** (originals over reposts), **recency** (feed is
  "roughly in chronological order"), small public accounts are shown to non-followers to
  gauge response, optimise engagement **rate** not raw views. **[META]** *(via*
  https://www.socialmediatoday.com/news/instagram-chief-shares-algorithm-insights-and-posting-tips/831326/, 2026-09-24*)*
- "For the vast majority of creators, posting to Feed is going to be the best way to reach as
  many people as possible"; Stories reach "your most passionate audience". **[META]** *(via*
  https://www.socialmediatoday.com/news/instagram-stories-ranking-factors-2025/738541/*)*
  → **Stories keep followers. They do not win them.**

### 2b. Facebook

- **Recommended posts are the largest slice of Feed.** US, Q1 2026: unconnected recommendations
  ~39% of Feed views, friends ~19%, **followed Pages ~15%**, joined groups ~14%; **98.7% of Feed
  views were of posts with no outbound link**. **[META]** Widely Viewed Content Report,
  https://transparency.meta.com/reports/widely-viewed-content-report/ — ⚠️ the per-source shares
  were summed from the report's table by a tool; re-check the page before quoting them outside.
  US data, Feed only.
- **Reels ranking** predicts watch time, completion, like, skip, hide, and **share via WhatsApp
  or Messenger** (and to how many people); one recommender uses "whether a reel is original
  content". **[META]** https://transparency.meta.com/features/explaining-ranking/fb-reels/ (2026-06-19)
- All new Facebook videos are Reels (2025-06-17). **[META]**
  https://about.fb.com/news/2025/06/making-it-easier-create-videos-facebook/
- Meta's three levers to reach non-followers: **post original content, optimise for shares,
  stay eligible for recommendations**; start with Reels. **[META]**
  https://creators.facebook.com/how-to-get-your-content-seen-on-facebook
- Freshness: same-day posts were over 30% of recommended Reels in Q1 2026 (earnings-call
  figure, read second-hand). **[OPINION-grade sourcing]**

### 2c. The audience — Facebook is not second

- **Arab citizens of Israel, 2025: Facebook 93% (72% daily), WhatsApp 98%, TikTok 71% (61%
  daily), YouTube 100%.** No Instagram figure for this group was published (general
  population: Instagram 81%). Sample size not stated. **[STUDY]**
  https://www.jpost.com/business-and-innovation/article-871715 (2025-10-26)
- So every week is planned for **both** pages. A plan that is Instagram-first with Facebook as
  a copy is wrong for this audience.
- WhatsApp at 98% plus "share via WhatsApp" as a ranking prediction → a post a local would
  forward to a friend or the family group is the post to make.

---

## 3. Cadence

**Rule: 4 posts a week per page (owner decision 2), at least 10 Reels a month once we can make
them at that rate, and never a week with zero posts.**

- Follower growth rises with posts per week, each account against itself: 1–2 posts +0.12% a
  week, **3–5 +0.26%**, 6–9 +0.44%, 10+ +0.66%; weeks with no post fall below the account's own
  baseline. **[STUDY]** Buffer, 2.1M feed posts / 102K accounts, fixed effects, Stories excluded,
  https://buffer.com/resources/how-often-to-post-on-instagram/ (2025-08-13). The strongest
  cadence evidence there is.
- Accounts with the highest net follower growth "on average … post 10 or more reels per
  month". **[META]** https://creators.instagram.com/faq
- Skipped weeks underperform the account's own growth baseline. **[STUDY]** Buffer, 4.8M
  channel-weeks, https://buffer.com/resources/state-of-social-media-engagement/ (2026-03-05)
- **Disagreement, keep it honest:** Hootsuite finds the best *per-post engagement rate* at 2
  posts a week (https://blog.hootsuite.com/social-media-benchmarks/, sample not stated); Buffer
  and Metricool find more posts → more growth and total interactions. They measure different
  things. For follower growth, Buffer's within-account design is the better evidence.
- Facebook: brand medians are 2.5–3 posts a week (Quid/Rival IQ 2026, 150 brands per
  industry; Emplifi retail food Q3 2026, 6,382 pages). No study isolates Facebook frequency
  against follower growth, and no Meta statement penalises posting often. **[STUDY]**
- No evidence that posting "too often" is penalised — but a high volume of recycled content
  is (§7). Raise the count only when quality holds.

---

## 4. Formats

**Rule: Reels and carousels carry the plan. A single picture is not the default.**

| Format | Use it for | Evidence |
|---|---|---|
| **Reel** | reaching non-followers | Reels are "over 50% of all time spent on Instagram" **[META]** https://creators.instagram.com/grow/algorithms-and-ranking · reach 1.36× carousels, 2.25× single images **[STUDY]** Buffer, 4M+ posts, https://buffer.com/resources/data-best-content-format-social-media/ |
| **Carousel** | saves, shares, re-serving | 9× the saves of a single image **[STUDY]** Metricool 2026 · for 1–5K accounts carousels averaged 993 views vs 580 for Reels **[STUDY]** Socialinsider 2025 · a carousel scrolled past can come back showing its second slide **[META]** Mosseri *(via Uppbeat, paraphrase)* |
| **Single picture** | only when nothing better is buildable | reach −22%, interactions −25% year on year **[STUDY]** Metricool 2026 |
| **Story** | the followers we already have | followers only **[META]** §2a; Story replies +88%, reach flat **[STUDY]** Metricool 2026 |
| **Facebook photo / album** | Facebook's steady format | album and status posts lead engagement by followers in 2025; Reels the top format by Q2–Q3 2026; **links far behind** **[STUDY]** Socialinsider, 139,530 pages |

- **Disagreement:** Buffer says Reels win reach; Metricool and Socialinsider show carousels
  matching or beating Reels on views under 10K. Practical reading: **use both.**
- ⚠️ **What we can build today is narrower than this table — §9.** Until carousels and 4:5
  pictures exist, a plan leans on Reels (promo reel, manual upload of real footage) and uses the
  square picture where a carousel would have gone. Say so in the slot's WHY.

### 4a. Reel rules

1. **3:00 or shorter, always.** "We recommend videos to unconnected audiences that are 3 minutes
   or less." **[META]** https://creators.instagram.com/faq — over 180 s loses ~49% reach.
   **[STUDY]** Buffer, 2.73M Reels, https://buffer.com/resources/instagram-reels-length/ (2026-11-12)
2. **Aim for 30–90 seconds; avoid under 15.** Buffer's best band is 90–179 s (+7.4% vs own
   baseline); Socialinsider's is 45–60 s (9.77M Reels, 2026). They disagree on the peak and
   agree that under 30 s underperforms and over 180 s collapses. Under 3 minutes the effect is
   single-digit percentages — **the hook and the subject matter more than the length.**
   ⚠️ Our promo reel is 10–12 s (§9a), below this band: treat it as a tested exception and read
   its skip rate and shares, do not assume.
3. **Win the first 3 seconds** — show the food or the payoff in frame one. Hook guidance
   **[META]** https://creators.instagram.com/blog/instagram-recommendations-eligibility-tips-creators;
   "watch less than three seconds" is a ranking prediction (§2a).
4. **Clean file:** 9:16, high resolution, no border, no third-party watermark, text not covering
   most of the screen, not a re-post of a Reel already on the account. **[META]**
   https://about.instagram.com/blog/announcements/instagram-ranking-explained/ (2023)
5. **Audio:** no reliable 2025–26 study of trending versus original audio. Treat as neutral.
6. **Trial Reels** show to non-followers first, stay off the grid, give numbers after ~24 h and
   can auto-share at 72 h. **[META]** https://about.fb.com/news/2024/12/trial-reels-try-content-non-followers-first/
   A good way to test a hook — not buildable through our publisher yet (§9b).

---

## 5. Words, tags and being found

| Rule | Evidence |
|---|---|
| **Caption stays in voice C and short** (CORE.md §1). A long, distracting or unrelated caption gets a Facebook post shown to followers only. | **[META]** https://about.fb.com/news/2025/04/cracking-down-spammy-content-facebook/ |
| **0–3 specific hashtags (town, cuisine). Never more than 5, never generic.** | Instagram: "fewer (up to 5) more targeted hashtags"; Mosseri: hashtags "don't work" to increase reach **[META]** *(via* https://www.socialmediatoday.com/news/instagrams-implementing-new-limits-on-hashtag-use/808309/*)* · Facebook: no more than five **[META]** https://creators.facebook.com/blog/combating-unoriginal-content · posts with a hashtag had ~32% fewer views **[STUDY]** Metricool 2026, correlational. ⚠️ Instagram's own FAQ still says relevant trending hashtags "can help" — conflicting first-party text. |
| **No link in a Facebook post body.** The order link goes in the first comment, the bio, or a Story. | 98.7% of Feed views have no link (§2b); links are the weakest format in both studies; Meta's caption advice says "no links". No blanket demotion is stated — the evidence is indirect. On Instagram "link in bio" neither helps nor hurts **[META]** Mosseri *(via socialmediatoday, 2025-07-23)* |
| **Plain keywords in the caption** — the dish, the cuisine, the town — not in the comments. | Search matches caption and name text **[META]** §2a |
| **Location tag on every post that is about a place.** | Location is a Feed signal (2023 explainer); Search uses the author's proximity **[META]**. The "+79% engagement" figure has no source — ignore it. |
| **Profile name and bio carry what we are and where** (delivery, the towns). A profile change is the owner's, not a post — propose it once, in the plan's notes. | **[META]** Search system card; bio and alt text are *not* named in it **[OPINION]** |
| **Ask a real, open question; never "comment X" and never ask for likes.** | question in the caption +36.7% comments; asking for likes −4.9% **[STUDY]** Metricool 2026 · "Open-ended questions and calls-to-action are a great way to engage"; bait is asking for a specific word, number or emoji **[META]** *(via socialmediatoday, 2024-06)* |
| **Replies to comments matter** — flag in the plan which posts need a person to answer. | +21% engagement vs own baseline, causality unclear **[STUDY]** Buffer, ~2M posts. Replying is a person's job; this operator never writes to a customer. |

---

## 6. Partner restaurants — the biggest measured lever for an account our size

- **Collab posts.** For brands under 10K followers, a collab **published by the partner and
  accepted by the brand** earned about **5× the interactions** of the brand's own standard
  posts; Reels were the strongest collab format. It measures interactions, **not follows**, on
  the vendor's own clients. **[STUDY]** Emplifi, 520,198 posts / 3,791 profiles, H1 2026,
  https://emplifi.io/resources/instagram-collaborations-boost-organic-engagement/
- **Tagging another account** in a post: +108% reach for accounts under 2K, +37% for 2K–10K.
  **[STUDY]** Metricool 2026, correlational.
- **Local beats central:** local restaurant accounts got up to 2–2.3× the engagement of
  central brand accounts. **[STUDY]** Malou, 471 accounts, vendor,
  https://www.malou.io/en-us/blog/how-to-grow-restaurants-on-instagram
- Collabs are also the **sanctioned** way to show someone else's content (§7).

**How this operator uses it**
- Every slot about a store names the store's Instagram / Facebook handle **if we have one on
  record**, and says "tag" or "Collab". Never guess a handle.
- A Collab needs the restaurant to publish or accept. That is a person's conversation with the
  store — put it in the plan as a request, days ahead; do not assume a yes.
- Our publisher cannot send a Collab invite or a tag yet (§9b). Until it can, the plan says who
  must add it by hand.
- Stores' own pages (Shoofi Studio) are not ours to post to (CORE.md §3).

---

## 7. What hurts — check a plan against this before handing it in

| Never | Why | Source |
|---|---|---|
| **Re-uploads of other people's content** (a customer's photo, a restaurant's reel, a meme image) as our own post | Accounts that "primarily post unoriginal content" are removed from recommendations on a rolling 30 days; a border, subtitles or a credit does not make it original. Facebook: may be "deemed non-recommendable". | **[META]** https://creators.instagram.com/blog/rewarding-original-creators-on-instagram (2026-04-30) · https://about.fb.com/news/2026/03/rewarding-original-creators-on-facebook/ |
| "Tag 3 friends", "comment X to win", "share to enter" | Not recommended to non-followers; Facebook demotes the post and repeat-offender Pages. | **[META]** https://transparency.meta.com/features/approach-to-ranking/types-of-content-we-demote/ |
| Third-party watermarks, borders, low resolution, mostly-text Reels | Less distribution. | **[META]** §4a |
| The same Reel twice | Named as reducing distribution. | **[META]** 2023 explainer |
| A Reel over 3:00 | §4a. | **[META]** + **[STUDY]** |
| Generic or many hashtags; long unrelated captions | §5. | **[META]** |
| Links in a Facebook post body | §5. | indirect |
| A week with no post | §3. | **[STUDY]** |
| Buying followers, follow-for-follow, engagement groups | Forbidden by Meta's developer policies §2.7; fake followers also lower shares-per-reach. | **[META]** https://developers.facebook.com/devpolicy/ + inference |

- **Account Status is the stop-everything check.** If either account shows "not eligible for
  recommendations", non-follower reach is cut off. Nothing in our system reads it yet — put
  "check Account Status" in the plan's notes for the owner once a month, and immediately after
  any post is removed or restricted.
- A customer photo with permission is safer as a Repost, a Story share or a Collab than as a
  re-upload — and CORE.md's "never put a customer in a post" still stands.

---

## 8. AI content, and giveaways

### 8a. AI
1. **No AI picture of a real restaurant's dish** (owner decision 4). Zomato removed AI dish
   images and told its own marketing to stop, citing breach of trust, more refunds and lower
   ratings (2024); Just Eat apologised and paused its rollout in October 2026 although its images
   were labelled and human-checked. **[OPINION-grade cases]**
   https://www.businesstoday.in/technology/news/story/zomato-to-ditch-ai-generated-food-images-after-customer-complaints-442158-2024-08-20 ·
   https://www.dexerto.com/food/just-eat-apologizes-after-ai-turns-food-into-literal-potato-jackets-tiger-cubs-bacon-soda-3421330/
   Unlabelled AI food images are rated *more* appetising — until they are labelled, then
   preference flips to real. **[STUDY]** Califano & Spence, Food Quality and Preference, 2024.
2. **AI is for Shadi, scenes and backgrounds.** A text-free background behind real words is fine.
3. **No demonstrated reach penalty for the "AI info" label.** Labelled content stays up; only
   fact-checked false content is demoted. **[META]**
   https://about.fb.com/news/2024/04/metas-approach-to-labeling-ai-generated-content-and-manipulated-media/
4. **A label is required for photorealistic video or realistic-sounding audio** that was made or
   altered with AI; images are not under the mandatory rule. ⚠️ Read from search extracts — the
   help page itself did not load. If a slot is a photorealistic AI video, say "needs the AI
   label" in the slot.
5. **Never an undisclosed AI-generated person as the face of the account** — unlabelled, the
   account loses recommendation reach (reported 2026-09, second-hand). Shadi is a stylised 3D
   character, not a realistic person; if that ever changes, raise it with the owner.
6. Israeli law: the general misleading-advertising rule applies; nothing specific to AI food
   pictures was found. Thin — a lawyer's question if it ever matters.

### 8b. Giveaways
- **Not a growth engine.** Contest posts are not recommended to non-followers (§7); in the one
  study found, 61% of giveaway followers left within two weeks — 2019–20 US loop giveaways, a
  harsher format than a single local draw. **[STUDY, small, dated]**
  https://www.socialmediaexaminer.com/do-sponsored-instagram-contests-really-work-case-study/
- If the owner asks for one: followers-only, one restaurant, clear rules, **no tag or comment
  requirement**, the required release of Instagram and "not sponsored or administered by
  Instagram" line (Meta's Promotion Guidelines — read second-hand). The prize is an existing
  offer or the store's — **this operator never creates a coupon** (CORE.md §4).

---

## 9. What can be made, published and read today — keep plans buildable

Verified against shoofi-server `origin/main`, 2026-11-19. **The weekly plan screen and the plan → creator hand-off exist from shoofi-server
`feat/social-week-plan`** (`docs/social-week-plan.md` there; the admin's מרכז שיווק →
«תוכנית לרשתות»): you hand the week in as a `social-plan` block (§12), the owner moves, edits
and approves each slot, and a slot's picture is the creator's, the dish's menu photo, or a
file the owner uploads.

### 9a. What the creator («היוצר») and the skills make

| Can make | Detail |
|---|---|
| **Square (1:1) text-free picture + Arabic caption** | the marketing item's social place; ~130 Artlist credits a picture |
| **Story, 9:16** | Arabic and Hebrew files; needs a **store** subject |
| **Story video** | 6 s, from a finished story |
| **Promo reel** | 1080×1920, 10–12 s, real dish photos, six rotating styles; subjects: store, dish, deal, coupon |
| **Guided reel (Shadi)** | an explainer over real app screens; 800–2,000 credits; four human gates |
| **A person's own upload** | a finished picture or video (real restaurant footage goes this way) |

| Cannot make yet | Plan around it |
|---|---|
| **Carousel** | one square picture, or a reel |
| **4:5 feed picture** in the creator | square |
| A reel or story **attached automatically** to a social draft | a person attaches it |
| A Shadi **skit** on demand | the guided reel is an explainer with human gates — ask, do not assume |

Every picture, voice and reel costs credits and counts against a daily limit. A plan states its
total cost; **anything paid stops for a person's yes.**

### 9b. What the publisher sends

| Sends | Does not send yet |
|---|---|
| Facebook: text, single photo, video (as a plain Page video), image and video Story | **Facebook Reel**, multi-photo album |
| Instagram: single JPEG picture, video as a **Reel**, image and video Story | **Carousel** |
| | Collab invite, account tag, location tag, first comment, alt text, reel cover, Trial Reel, AI label |

- A post goes out at its scheduled minute only after a person approved it (CORE.md §3).
- Story link, poll and location stickers cannot be added by Meta's API at all — a Story that
  needs an order link is a person's job.
- Meta allows 100 API posts per Instagram account per 24 h (one doc section says 50) and 30
  API Reels per Page per 24 h — far above our cadence; never plan near them.

### 9c. What we can read back

`shoofi.socialInsights`, synced every 3 hours (CORE.md §3b):
- per day, each account: reach, views, new followers, profile views, interactions, and the
  **follower total** (kept since syncing began);
- per post (latest 25 per network, re-read for 30 days): reach, views, likes, comments,
  **shares**, saves — so **shares ÷ reach is computable today**;
- per Story, only during its 24 hours.

**Not read yet:** follows per post, non-follower reach, Reel watch time and skip rate, when our
followers are online, follower demographics. Until they are, say "not measured" — never infer.
Facebook insights need a Page with 100+ likes.

---

## 10. Recurring series

Each is a repeatable slot. "Buildable" is against §9 **today**.

| # | Series | Format | Purpose | Buildable today | Evidence |
|---|---|---|---|---|---|
| 1 | **طبق الأسبوع** — dish of the week with a partner restaurant | real-footage Reel, ideally published by the restaurant as a Collab | reach, follow | promo reel from real menu photos: yes · Collab / real footage: needs a person and the store | Emplifi 5× **[STUDY]** |
| 2 | **Top 5 in town** — from real order data (dishes, never customers) | carousel | saves, shares, follow | not as a carousel — a square picture or a promo reel | carousels 9× saves; sends reach non-followers. Rankings as such are untested **[OPINION]** |
| 3 | **Shadi's day** — the courier's short skit, local humour | short Reel, recurring character | reach, follow | only through the guided reel, with its gates and cost | Duolingo, Talabat's "Tarek", Keeta's KiKi **[OPINION-grade cases]** — none reports follower growth |
| 4 | **Town pride** — the town, its streets, its habits, in dialect | picture or Story | shares, follow | square picture: yes (AI scene, no real dish) | city meme pages reached ~2× their followers (2021, Germany) **[OPINION-grade case]** — must be **original**, never a reposted meme (§7) |
| 5 | **Behind the kitchen** — a dish being made, staff on camera | real Reel | reach, trust | only as the restaurant's own footage, uploaded by a person | agency opinion only **[OPINION]** |
| 6 | **Deal of the week** — an offer that already exists | Story, plus a post | order | yes; the order link sticker is a person's job | attribution guidance **[OPINION]**; CORE.md §4: select, never create |
| 7 | **Open question / this-or-that** | Story or post | comments, keeping followers | post: yes · Story poll sticker: no | questions +36.7% comments **[STUDY]**; open-ended prompts allowed **[META]** |
| 8 | **New on Shoofi** — a store that just opened | Reel or picture, tag the store | reach, follow | yes | tagging +37–108% reach **[STUDY]** |
| 9 | **Ramadan nights** (in season) | simple clip after Taraweeh; a suhoor offer near midnight | reach, order | as above | §11 **[OPINION]** |

- **Big-brand cases show what large brands do, not that it grows followers.** Almost none
  reports follower numbers. Treat series 3–5 as experiments and read their shares-per-reach.
- A good week mixes purposes: at least two slots built to **travel** (series 1, 2, 3, 4, 8), at
  most one that **sells** (6), and Stories for the people already here.
- Do not run the same series, or the same store, twice in a week. Check the promo reel's style
  rotation and what was posted in the last 14 days.

---

## 11. Timing

**Rule: learn the hour from our own results. No published "best time" covers this audience.**

- Three large studies contradict each other — Thu 9am / Wed 12pm / Wed 6pm (Buffer, 9.6M
  posts), 3–6am (Later, 6M posts), 7–9pm any day (Metricool). **[STUDY]** Not transferable.
- **No data** was found on posting hours for Arab citizens of Israel, on Friday/weekend
  behaviour, or on the Sunday–Thursday week. Any schedule is a hypothesis.
- What does hold: **recency matters** **[META]**; **never 1–5am** **[STUDY]** Buffer.
- **Starting hypothesis (ours, unproven):** post ahead of a meal — late morning before lunch,
  late afternoon before dinner — because that is when an order is possible. Our own hourly
  order curve (`shoofi.growthSnapshots`) is the prior, not a blog table. Vary the hour on
  purpose across weeks, keep the format constant, and read shares-per-reach at 72 hours.
- **Ramadan:** engagement moves to the night — after Taraweeh and again before suhoor; posts
  before iftar underperform; simple, quickly filmed clips beat polished ones. **[OPINION]** three
  interviewees, Saudi, https://www.arabnews.pk/node/2636507 (2026-03-16). UAE ordering data
  agrees on the late night. Not our towns — test it.
- There is no holidays calendar in the system. Check the date yourself for the week being
  planned (Ramadan, the two Eids, the school year, local events) and **say which occasion a
  slot leans on**; a wrong date is a wrong post.

---

## 12. How to plan a week

### Read first, in this order
1. **CORE.md** (voice, approval chain, coupons) and §0 above.
2. **Last two weeks of results** — `shoofi.socialInsights`: per post shares ÷ reach, reach,
   saves; per day the follower total for each page. Which format, series and hour travelled?
3. **What is already live, scheduled or drafted** — `shoofi.socialPublications`,
   `shoofi.marketingItems`. Never plan on top of it; never repeat a store from the last 14 days.
4. **What is true this week** — live stores, top dishes of the last 7 days with photos, new
   stores, public coupons and running deals nothing promotes yet (the hub's «כדאי לקדם» list).
5. **The date** — occasions in the week being planned (§11).
6. **§9** — what can actually be made and sent.

### Then write the plan
Four posts per page plus Stories (decision 2). **Every slot states all of these:**

| Field | What goes in it |
|---|---|
| **Day** and **hour** | Israel time; never 1–5am |
| **Network** | Facebook, Instagram, or both — both is the default (§2c) |
| **Format** | reel · picture · story (and "carousel — not buildable yet" if that is what the evidence wants) |
| **Series** | from §10, or "one-off" |
| **Subject** | the store, dish, deal, coupon or page — checked live in this task; the existing campaign named if there is an offer |
| **What it shows** | one line; real photo / footage, or AI scene with **no** real dish |
| **Caption** | Arabic, voice C, two or three options |
| **Tags** | store handle if on record, location, 0–3 hashtags |
| **WHY** | the rule or the result it rests on — a § of this file with its grade, or "ours: <post> got <shares ÷ reach>" |
| **Needs a person** | Collab ask, a tag or sticker to add by hand, footage to upload, comments to answer |
| **Cost** | credits, and whether it is paid |

A slot whose WHY is "it's a nice idea" is not ready. A slot that rests on **[OPINION]** says so
and is treated as a test, with the number that would prove it.

### Hand it in
- The plan is a **proposal**. The owner may move a slot to another day or hour and edit its
  content; nothing is generated with credits and nothing is scheduled without that yes.
- End with: the plan's total cost, the assumptions it depends on, and the one thing you want
  to learn from this week.

**When the job is HQ's weekly plan run** (every Thursday 10:00 for the next week, or the
owner's «הצעה לשבוע» button — the job text says so and gives the week), you write nothing
yourself: the answer ends with ONE fenced block, nothing after it, and the server validates
and stores it (`shoofi-server services/marketing/social-plan.js absorbPlan`):

````
```social-plan
{"week":"YYYY-MM-DD (the week's Sunday, as the job gave it)",
 "summary":"<Hebrew, two sentences: the idea of the week>",
 "slots":[{"day":"YYYY-MM-DD","time":"HH:MM","format":"post|story|reel",
   "targets":["facebook","instagram"],"series":"<§10 series or one-off>",
   "subject":{"kind":"product|deal|coupon|store|store_new|page","id":"…","appName":"…"} or null,
   "title":"<Hebrew, one line: what the post is>",
   "caption":"<Arabic, voice C — ONE caption, the best of your options>",
   "pictureNote":"<Hebrew: what the picture or video shows>",
   "why":"<Hebrew: the rule (§ + grade) or our result it rests on>"}]}
```
````

- **One caption per slot**, not options: the owner edits it on the screen.
- **Subject ids are read from the database in this run**, never remembered: a product or
  deal `_id` with its store `appName`; a public coupon `_id`; a store's `appName` as `id`;
  a page is one of `invite-friends`, `my-coupons`, `coins`, `for-you`. `null` = no subject,
  and then the owner uploads the picture.
- **What each format becomes:** `post` with a dish subject uses the dish's own menu photo
  (never drawn); `post` with any other subject is drawn by the creator from `pictureNote`;
  `reel` and `story` are files the owner uploads, so plan one only when `pictureNote` says
  exactly what to film. A carousel is refused.
- A slot outside the week, in the past, with a broken time or with no caption is **dropped**
  and listed to the owner; at most 12 slots are read. A new plan replaces only your own
  untouched suggestions — a slot the owner edited, drew, approved or added stays, and the job
  lists those so you plan around them.
- "Tags", "Needs a person" and "Cost" from the table above go into `pictureNote` / `why`
  where they matter; the block has no fields for them yet.

### After the week
At 72 hours for each post, record shares ÷ reach, reach, saves and the page's follower change
against the slot's WHY. A rule that our numbers confirm or contradict **twice** goes into §13,
with the dates.

---

## 13. Things learned (ours — newest first)

Nothing yet: the playbook starts 2026-11-19 from research alone. Add a line per finding —
date, what was tested, the numbers, which rule above it confirms or changes.

## 14. Known thin spots — do not present these as settled

- Posting hours, Friday/weekend and Sunday–Thursday behaviour for our audience: **no data**.
- No Instagram usage figure for Arab citizens of Israel.
- Dialect versus Standard Arabic in brand posts: small studies, none on Palestinian dialect —
  our own measurement (CORE.md §1) is better evidence than any of them.
- Which food video styles earn shares (close-up, POV, rankings, price reveals): no study.
- Whether reposting customer content grows followers: anecdote only.
- Cost per follower for paid boosts in Israel or the region: **no figure exists**. Paid spend is
  out of scope (CORE.md §6); if asked, the only supported use is putting an already-proven Reel
  in front of the served towns and stopping on a poor follow rate.
- Meta's help-centre pages (Recommendation Guidelines, Promotion Guidelines, AI label) could
  not be opened during the research; rules resting on them are marked where they appear.
- Meta's own docs disagree in places (Instagram's daily API limit, the Facebook scheduling
  window, the Facebook Reel length by API). Stay inside the stricter number.
