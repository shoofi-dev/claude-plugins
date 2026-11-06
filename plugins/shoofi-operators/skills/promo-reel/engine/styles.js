/*
 * The six promo-reel styles. A style turns a spec (the subject's facts, the words, the
 * pictures, a theme) into timed layers; stage.html animates them. Every word on screen comes
 * from spec.text / spec.subject — a style never writes its own claims.
 *
 * Safe zone (Instagram / Facebook Reels and Stories): words stay between y 260 and y 1440 and
 * clear of the right-hand rail, so text blocks sit in x 80..860 (centre 470).
 */
(() => {
  const SAFE = { x: 80, w: 780, top: 260, bottom: 1440 };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Words in **double stars** get the lime highlight.
  // A number, price or Latin word keeps its own left-to-right order inside the Arabic line
  // ("10%", "₪20", "Burger Cave"), or the bidi algorithm prints "%10".
  const ltr = (w) => /^[^\u0590-\u06FF]*$/.test(w);
  const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, (_, w) => `<span style="background:var(--lime);color:var(--ink);border-radius:14px;padding:0 14px;white-space:nowrap;${ltr(w) ? 'direction:ltr;unicode-bidi:isolate;display:inline-block' : ''}">${w}</span>`);
  const img = (src, extra = '') => `<img class="cover" src="${src}" style="${extra}">`;
  /** A dish: its animated clip when the spec has one (a Kling clip from the real photo), else the photo. */
  const media = (d, extra = '') => (d.clip ? `<video class="cover" src="${d.clip}" muted playsinline preload="auto" style="${extra}"></video>` : img(d.img, extra));
  /**
   * A dish photo that is smaller than the frame, at a size it can fill sharply: a full-width panel
   * (h = 1080 square, 1350 for 4:5) over a blurred copy of itself. Menu photos are landscape and
   * 1000–1700 px tall — full-bleed on a 1920 frame they stretch 1.3–1.9×.
   */
  const panel = (d, { y = 420, h = 1080, extra = '' } = {}) =>
    `<div class="cover" style="position:relative;overflow:hidden"><img data-bg="1" src="${d.img}" style="position:absolute;left:-15px;top:-25px;width:282px;height:500px;object-fit:cover;filter:blur(7px) brightness(.38);transform-origin:0 0;transform:scale(4)">`
    + `<div style="position:absolute;left:0;top:${y}px;width:1080px;height:${h}px;overflow:hidden;-webkit-mask-image:linear-gradient(transparent,#000 150px,#000 calc(100% - 150px),transparent);mask-image:linear-gradient(transparent,#000 150px,#000 calc(100% - 150px),transparent)">${media(d, extra)}</div></div>`;

  /** Text in the safe column. */
  const text = (s, { size = 64, color = '#fff', bg = null, weight = 400, y, start, end, inn = { kind: 'rise' }, out = { kind: 'fade' }, z = 20, pad = '26px 40px', radius = 36, shadow = true, w = SAFE.w, x = SAFE.x }) => ({
    html: `<div class="txt" style="font-size:${size}px;color:${color};font-weight:${weight};${bg ? `background:${bg};border-radius:${radius}px;padding:${pad};` : ''}${shadow && !bg ? 'text-shadow:0 4px 24px rgba(0,0,0,.55);' : ''}">${rich(s)}</div>`,
    x, y, w, start, end, z, in: inn, out,
  });

  /** The Shoofi brand pill — brand in the first seconds (Meta: 1.7×). */
  const brandPill = (spec, start, end) => ({
    html: `<div style="display:flex;justify-content:center"><div class="pill" style="background:${spec.theme.ink};color:#fff;font-size:44px"><img src="${spec.assets.icon}" style="width:70px;height:70px;border-radius:18px"><span>${esc(spec.text.pill)}</span></div></div>`,
    x: SAFE.x, w: SAFE.w, y: 270, start, end, z: 30, in: { kind: 'pop', dur: 0.35 }, out: { kind: 'fade' },
  });

  /**
   * The end card: the CTA spoken and shown (Meta: 1.9×), Shoofi + the store's logo, both big.
   * The Shoofi icon drops in, settles with a wiggle, rings pulse out behind it and a shine
   * crosses it; the store's logo pops in under the CTA. Brand ≤ 25% of the video.
   */
  const ease = { out: (x) => 1 - Math.pow(1 - x, 3), inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2) };
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const endCard = (spec, start, end) => {
    const t = spec.theme;
    const ICON = 380, cx = SAFE.x + SAFE.w / 2, iy = 330;
    const store = spec.subject.store && spec.subject.store.logo;
    const ring = (delay) => ({
      html: `<div style="width:${ICON}px;height:${ICON}px;border-radius:50%;border:10px solid var(--lime)"></div>`,
      x: cx - ICON / 2, y: iy, w: ICON, h: ICON, start: start + 0.35, end, z: 41,
      tick: (lt, el) => {
        const p = ((lt + delay) % 1.4) / 1.4;
        el.style.opacity = String((1 - p) * 0.7);
        el.style.transform = `scale(${0.9 + p * 0.9})`;
      },
    });
    return [
      { full: true, html: `<div class="cover" style="background:radial-gradient(circle at 50% 30%, ${t.endGlow || 'rgba(138,234,95,.28)'} 0%, ${t.endBg} 55%)"></div>`, start, end, z: 40, in: { kind: 'fade', dur: 0.25 } },
      ring(0), ring(0.7),
      {
        // The icon: drop + bounce, a damped wiggle, then a shine sweeping across.
        html: `<div style="position:relative;width:${ICON}px;height:${ICON}px;border-radius:${ICON * 0.24}px;overflow:hidden;box-shadow:0 26px 70px rgba(0,0,0,.35)"><img src="${spec.assets.icon}" style="width:100%;height:100%;display:block"><div class="shine" style="position:absolute;top:-20%;bottom:-20%;width:40%;background:linear-gradient(100deg,rgba(255,255,255,0) 0%,rgba(255,255,255,.65) 50%,rgba(255,255,255,0) 100%);transform:translateX(-200%) skewX(-12deg)"></div></div>`,
        x: cx - ICON / 2, y: iy, w: ICON, h: ICON, start, end, z: 42,
        tick: (lt, el) => {
          // Three entrances, rotated by the picker so the end card is not the same every time.
          const kind = spec.endCard || 'drop';
          let tf = '';
          if (kind === 'spin') {
            const p = ease.out(clamp(lt / 0.7));
            tf = `scale(${0.2 + 0.8 * p}) rotate(${(1 - p) * -540}deg)`;
          } else if (kind === 'stamp') {
            const p = clamp(lt / 0.32);
            const shake = lt > 0.32 && lt < 0.6 ? Math.sin((lt - 0.32) * 70) * 8 * (1 - (lt - 0.32) / 0.28) : 0;
            tf = `translate(${shake}px, 0) scale(${2.6 - 1.6 * (p * p)})`;
          } else {
            const drop = clamp(lt / 0.55);
            const bounce = drop < 1 ? -700 * Math.pow(1 - drop, 2) : 0;
            const squash = lt > 0.55 && lt < 0.8 ? 1 - 0.12 * Math.sin(((lt - 0.55) / 0.25) * Math.PI) : 1;
            const wig = lt > 0.6 ? 7 * Math.exp(-(lt - 0.6) * 4) * Math.sin((lt - 0.6) * 18) : 0;
            tf = `translateY(${bounce}px) scale(${1 / squash}, ${squash}) rotate(${wig}deg)`;
          }
          el.style.opacity = String(clamp(lt / 0.15));
          el.style.transform = tf;
          const sh = el.querySelector('.shine');
          const sp = clamp((lt - 1.1) / 0.6);
          sh.style.transform = `translateX(${-200 + sp * 450}%) skewX(-12deg)`;
        },
      },
      {
        html: `<div class="txt" style="color:${t.endInk};font-size:92px;white-space:nowrap">${rich(spec.text.cta)}</div>`,
        x: SAFE.x, w: SAFE.w, y: iy + ICON + 60, start: start + 0.5, end, z: 43, in: { kind: 'rise', dur: 0.45, by: 60 },
      },
      ...(store
        ? [{
          html: `<div style="display:flex;flex-direction:column;align-items:center;gap:22px"><img src="${spec.subject.store.logo}" style="width:300px;height:300px;border-radius:50%;object-fit:cover;background:#fff;border:10px solid var(--lime);box-shadow:0 18px 50px rgba(0,0,0,.35)"><div style="font-size:58px;color:${t.endInk}">${esc(spec.subject.store.name)}</div></div>`,
          x: SAFE.x, w: SAFE.w, y: iy + ICON + 230, start: start + 0.8, end, z: 43, in: { kind: 'pop', dur: 0.45 }, pulse: 0.6,
        }]
        : [{
          html: `<div style="display:flex;justify-content:center"><div class="pill" style="background:var(--lime);color:${t.ink};font-size:64px;padding:22px 64px">${esc(spec.text.ctaButton || 'اطلب الآن')}</div></div>`,
          x: SAFE.x, w: SAFE.w, y: iy + ICON + 300, start: start + 0.8, end, z: 43, in: { kind: 'pop', dur: 0.45 }, pulse: 0.8,
        }]),
    ];
  };

  /**
   * A stacked dish (a burger) that splits into its layers and snaps back — from the one real
   * photo, cut at `bands` (y in the 1080x1920 frame, between the layers). Free; the AI version is
   * a Kling clip with the same photo as its first and last frame (references/motion.md).
   */
  const splitDish = (d, cuts, start, end) => {
    const edges = [0, ...cuts, 1920];
    const n = edges.length - 1, mid = (n - 1) / 2;
    const bands = edges.slice(0, -1).map((y0, i) => `<div class="band" style="position:absolute;left:0;top:${y0}px;width:1080px;height:${edges[i + 1] - y0}px;overflow:hidden"><img src="${d.img}" style="position:absolute;left:0;top:${-y0}px;width:1080px;height:1920px;object-fit:cover"></div>`).join('');
    return [
      // Behind the layers: the same photo, blurred and dimmed, so a gap reads as motion, not a black bar.
      { full: true, html: `<img src="${d.img}" style="position:absolute;left:-15px;top:-25px;width:282px;height:500px;object-fit:cover;filter:blur(7px) brightness(.55);transform-origin:0 0;transform:scale(4)">`, start, end, z: 1 },
      {
        full: true, html: `<div style="position:absolute;inset:0">${bands}</div>`, start, end, z: 2,
        tick: (lt, el) => {
          // apart 0.5→1.3, hold and drift to 2.0, snap back with a little overshoot by 2.4
          const apart = ease.out(clamp((lt - 0.5) / 0.8));
          const back = clamp((lt - 2.0) / 0.4);
          const snap = back <= 0 ? 0 : 1 - Math.pow(1 - back, 3) + Math.sin(back * Math.PI) * 0.12;
          const k = apart * (1 - snap);
          const drift = Math.sin(lt * 3) * 6 * k;
          [...el.querySelectorAll('.band')].forEach((b, i) => {
            const off = (i - mid) * 115 * k;
            const sway = (i % 2 ? 1 : -1) * 22 * k + drift;
            const rot = (i % 2 ? 1 : -1) * 1.6 * k;
            b.style.transform = `translate(${sway}px, ${off}px) rotate(${rot}deg)`;
          });
          // the landing: one short shake
          const sh = lt > 2.25 && lt < 2.55 ? Math.sin((lt - 2.25) * 60) * 10 * (1 - (lt - 2.25) / 0.3) : 0;
          el.style.transform = `translateY(${sh}px) scale(${1 + 0.04 * k})`;
        },
      },
    ];
  };

  const offerBadge = (spec, big, label, { x, y, size = 330, start, end, inn = { kind: 'slam', dur: 0.5, from: 1.2 }, z = 25 }) => ({
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:var(--lime);color:${spec.theme.ink};display:flex;flex-direction:column;align-items:center;justify-content:center;box-shadow:0 20px 60px rgba(0,0,0,.35);transform:rotate(-8deg)"><div style="font-size:${size * 0.15}px;line-height:1">${esc(label)}</div><div style="font-size:${size * 0.36}px;line-height:1.05;direction:ltr">${esc(big)}</div></div>`,
    x, y, w: size, h: size, start, end, z, in: inn, out: { kind: 'shrink' }, pulse: 0.8,
  });

  const STYLES = {};

  /* ── המספר · Big number: the offer lands first, then the food behind it ── */
  STYLES.number = (spec) => {
    const s = spec.subject, t = spec.theme, d = s.dishes;
    return [
      { full: true, html: `<div class="cover" style="background:${t.ink}"></div>`, start: 0, end: 2.2, z: 1 },
      brandPill(spec, 0, 2.2),
      { html: `<div class="txt" style="font-size:96px;color:#fff">${esc(s.offer.label)}</div>`, x: SAFE.x, w: SAFE.w, y: 560, start: 0, end: 2.2, z: 10, in: { kind: 'rise', dur: 0.35 }, out: { kind: 'fade' } },
      { html: `<div class="txt" style="font-size:270px;line-height:1;color:var(--lime);direction:ltr;unicode-bidi:isolate">${esc(s.offer.big)}</div>`, x: 130, w: 700, y: 730, start: 0.05, end: 2.2, z: 10, in: { kind: 'slam', dur: 0.55, from: 1.08 }, out: { kind: 'shrink', dur: 0.3 } },
      { full: true, html: panel(d[0], { y: 360, h: 1350 }), start: 1.9, end: 5.0, z: 2, in: { kind: 'fade', dur: 0.3 }, kb: { from: 1.0, to: 1.12, oy: -30 } },
      offerBadge(spec, s.offer.big, s.offer.label, { x: 520, y: 300, size: 300, start: 2.1, end: 9.6 }),
      text(s.offer.line, { size: 66, bg: 'rgba(23,50,15,.88)', y: 1210, start: 2.3, end: 5.0 }),
      { full: true, html: panel(d[1], { y: 360, h: 1350 }), start: 4.8, end: 7.6, z: 3, in: { kind: 'fade', dur: 0.25 }, kb: { from: 1.12, to: 1.0, ox: 20 } },
      text(d[1].name, { size: 62, bg: 'rgba(255,255,255,.94)', color: t.ink, y: 1220, start: 5.0, end: 7.6 }),
      { full: true, html: `<div class="cover" style="background:${t.ink}"></div>`, start: 7.4, end: 9.8, z: 4, in: { kind: 'fade', dur: 0.3 } },
      { html: `<div style="display:flex;justify-content:center"><div class="card" style="width:640px;height:640px;border:10px solid #fff">${img(d[0].img)}</div></div>`, x: SAFE.x, w: SAFE.w, y: 330, start: 7.6, end: 9.8, z: 6, in: { kind: 'pop', dur: 0.4 }, kb: { from: 1.0, to: 1.05 } },
      text(s.offer.terms.replace(' · ', '\n'), { size: 74, color: t.ink, bg: '#fff', y: 1050, start: 7.8, end: 9.8, shadow: false }),
      ...endCard(spec, 9.6, 12.2),
    ];
  };

  /* ── קצב · Fast cuts: one dish a second, on the beat, big words ── */
  STYLES.rush = (spec) => {
    const s = spec.subject, t = spec.theme;
    const out = [brandPill(spec, 0, 1.6)];
    const cut = 0.9, start = 0;
    s.dishes.slice(0, 6).forEach((d, i) => {
      out.push({ full: true, html: panel(d, { y: 420, h: 1080 }), start: start + i * cut, end: start + (i + 1) * cut + 0.02, z: 2 + i, punch: true, kb: { from: 1.0, to: 1.06 } });
    });
    const after = start + Math.min(6, s.dishes.length) * cut;
    out.push(text(spec.text.hook, { size: 120, bg: 'rgba(0,0,0,.6)', y: 760, start: 0.1, end: 1.8, inn: { kind: 'slam', dur: 0.4, from: 0.8 }, pad: '10px 44px' }));
    out.push(text(s.store.name, { size: 64, bg: 'var(--lime)', color: t.ink, y: 1290, start: 1.8, end: after, inn: { kind: 'slideR', dur: 0.35 } }));
    // The offer is on screen while the voice says it (owner's director, 2026-11-07).
    out.push(offerBadge(spec, s.offer.big, s.offer.label, { x: 600, y: 300, size: 260, start: 1.8, end: after, z: 24 }));
    out.push({ full: true, html: `<div class="cover" style="background:${t.ink}"></div>`, start: after, end: after + 2.6, z: 20 });
    out.push(offerBadge(spec, s.offer.big, s.offer.label, { x: SAFE.x + SAFE.w / 2 - 210, y: 500, size: 420, start: after + 0.05, end: after + 2.6, z: 22 }));
    out.push(text(`${s.offer.line}\n${s.offer.terms.replace(' · ', '\n')}`, { size: 58, y: 1020, start: after + 0.35, end: after + 2.6, z: 23 }));
    out.push(...endCard(spec, after + 2.6, after + 5.2));
    return out;
  };

  /* ── שולחן · Table spread: top-down, the dishes land on the table one by one ── */
  STYLES.table = (spec) => {
    const s = spec.subject, t = spec.theme;
    const cells = [
      { x: 70, y: 380, r: -4 }, { x: 560, y: 340, r: 3 },
      { x: 90, y: 830, r: 2 }, { x: 570, y: 800, r: -3 },
    ];
    const out = [{ full: true, html: `<div class="cover" style="background:${t.paper}"></div>`, start: 0, end: 9.4, z: 1 }];
    s.dishes.slice(0, 4).forEach((d, i) => {
      const c = cells[i];
      out.push({ html: `<div class="card" style="width:430px;height:430px;border:12px solid #fff">${img(d.img)}</div>`, x: c.x, y: c.y, w: 430, h: 430, rot: c.r, start: 0.2 + i * 0.3, end: 9.4, z: 3 + i, in: { kind: 'drop', dur: 0.45, spin: c.r * 3 }, kb: { from: 1.0, to: 1.07 } });
    });
    out.push({ html: `<div style="display:flex;justify-content:center"><img src="${s.store.logo}" style="width:300px;height:300px;border-radius:50%;object-fit:cover;background:#fff;box-shadow:0 18px 50px rgba(0,0,0,.3);border:10px solid #fff"></div>`, x: SAFE.x, w: SAFE.w, y: 640, start: 1.4, end: 9.4, z: 12, in: { kind: 'pop', dur: 0.45 } });
    out.push(brandPill(spec, 0, 2.6));
    out.push(text(spec.text.hook, { size: 70, color: t.ink, bg: '#fff', y: 1300, start: 0.15, end: 2.7, shadow: false }));
    out.push(offerBadge(spec, s.offer.big, s.offer.label, { x: 500, y: 1090, size: 400, start: 2.6, end: 9.4, z: 14 }));
    out.push(text(`${s.offer.line}\n${s.offer.terms}`, { size: 52, color: '#fff', bg: t.ink, y: 1150, x: 70, w: 440, start: 2.8, end: 9.4, pad: '24px 22px' }));
    out.push(...endCard(spec, 9.2, 11.8));
    return out;
  };

  /* ── תקריב · Close-up: one dish, slow macro, very few words ── */
  STYLES.closeup = (spec) => {
    const s = spec.subject, t = spec.theme, d = s.dishes[0];
    // The hook: an AI clip of the dish (e.g. Kling splitting the burger, from its real photo),
    // or the free split of the photo, or straight into the slow close-up.
    const ai = Boolean(s.hookClip);
    const hook = ai ? (s.hookLen || 5.0) : s.split && s.split.length ? 2.6 : 0;
    const out = [];
    if (ai) {
      out.push({ full: true, html: `<video class="cover" src="${s.hookClip}" muted playsinline preload="auto"></video>`, start: 0, end: hook, z: 1, kb: { from: 1.0, to: 1.06 } });
      out.push(text(d.name, { size: 104, y: 1150, start: 2.0, end: hook, inn: { kind: 'rise', dur: 0.5, by: 50 } }));
      out.push(text(s.store.name, { size: 50, y: 1310, start: 2.4, end: hook }));
    } else if (hook) {
      out.push(...splitDish(d, s.split, 0, hook));
    }
    out.push(
      { full: true, html: media(d, 'transform-origin:50% 55%'), start: hook, end: hook + 6.0, z: 1, kb: { from: 1.15, to: 1.5, oy: -60 } },
      { full: true, html: `<div class="cover" style="background:linear-gradient(180deg,rgba(0,0,0,.45) 0%,rgba(0,0,0,0) 30%,rgba(0,0,0,0) 55%,rgba(0,0,0,.7) 100%)"></div>`, start: 0, end: hook + 6.0, z: 3 },
      brandPill(spec, 0, Math.max(2.2, hook - 2.8)),
      text(spec.text.hook, { size: 64, bg: 'var(--lime)', color: t.ink, y: 430, x: 300, w: 320, start: 0.3, end: Math.max(2.2, hook - 2.8), inn: { kind: 'pop', dur: 0.4 }, pad: '14px 28px' }),
    );
    const main = ai ? 3.2 : 6.0; // the close-up after an AI hook is shorter: the name was already said
    if (!ai) {
      out.push(text(d.name, { size: 104, y: 1020, start: hook + 0.2, end: hook + 3.4, inn: { kind: 'rise', dur: 0.6, by: 50 } }));
      out.push(text(s.store.name, { size: 50, color: '#fff', y: 1180, start: hook + 0.6, end: hook + 3.4 }));
    }
    const c0 = ai ? hook + 0.2 : hook + 3.4;
    out.push({ html: `<div class="txt">${(s.chips || []).map((c) => `<span class="chip" style="background:rgba(255,255,255,.95);color:${t.ink};font-size:50px">${esc(c)}</span>`).join('')}</div>`, x: SAFE.x, w: SAFE.w, y: 1040, start: c0, end: hook + main - 0.2, z: 20, in: { kind: 'rise', dur: 0.5 } });
    if (s.price) out.push(text(s.price, { size: 60, bg: t.ink, y: 1300, x: 330, w: 280, start: c0 + 0.4, end: hook + main - 0.2, pad: '14px 26px' }));
    // the close-up layers end where the end card starts
    for (const l of out) if (l.end === hook + 6.0) l.end = hook + main;
    out.push(...endCard(spec, hook + main - 0.2, hook + main + 3.2));
    return out;
  };

  /* ── באפליקציה · In the app: the order happens on a real screen ── */
  STYLES.inapp = (spec) => {
    const s = spec.subject, t = spec.theme, sc = spec.assets.screen;
    const PW = 700, SW = PW - 32;
    const scale = SW / sc.width;
    const viewH = Math.round(sc.view * scale);
    const top = -Math.round(sc.from * scale);
    const hl = sc.hl ? `<div class="hl" style="left:${sc.hl.x * scale - 8}px;top:${(sc.hl.y - sc.from) * scale - 8}px;width:${sc.hl.w * scale + 16}px;height:${sc.hl.h * scale + 16}px"></div>` : '';
    const PY = 650; // the phone's top, clear of a two-line hook
    const callW = 980, cs = callW / sc.hl.w, callH = Math.round(sc.hl.h * cs);
    // the zoomed strip sits exactly over its ring, so one row never shows two rings
    const callY = Math.round(PY + 16 + (sc.hl.y - sc.from + sc.hl.h / 2) * scale - callH / 2);
    const dish = s.dishes && s.dishes[0];
    return [
      { full: true, html: `<div class="cover" style="background:${t.paper}"></div>`, start: 0, end: 9.4, z: 1 },
      brandPill(spec, 0, 3.0),
      text(spec.text.hook, { size: 72, color: t.ink, y: 430, start: 0.2, end: 9.4, shadow: false }),
      { html: `<div class="phone" style="width:${PW}px"><div class="scr" style="height:${viewH}px"><img src="${sc.src}" style="width:${SW}px;position:absolute;top:${top}px;left:0">${hl}</div></div>`, x: 120, y: PY, w: PW, start: 0.5, end: 9.4, z: 5, in: { kind: 'up', dur: 0.7, by: 1300 } },
      // the store's real dish beside the phone: the food is the reason to order
      ...(dish ? [{ html: `<div class="card" style="width:400px;height:400px;border:10px solid #fff">${img(dish.img)}</div>`, x: 690, y: 1330, w: 400, h: 400, rot: 6, start: 1.0, end: 5.9, z: 7, in: { kind: 'drop', dur: 0.5, spin: 12 }, out: { kind: 'fade', dur: 0.2 } }] : []),
      { html: `<div class="card" style="width:${callW}px;height:${callH}px;border:8px solid var(--lime);box-shadow:0 0 0 5px ${t.ink},0 30px 60px rgba(0,0,0,.35)"><img src="${sc.src}" style="width:${sc.width * cs}px;margin-left:${-sc.hl.x * cs}px;margin-top:${-sc.hl.y * cs}px;display:block"></div>`, x: 50, y: callY, w: callW, start: 2.4, end: 5.9, z: 10, in: { kind: 'pop', dur: 0.45 }, out: { kind: 'shrink' } },
      { html: `<div class="txt" style="${ticketCss};border-radius:30px;background:${t.ink};color:#fff;padding:30px 60px;font-size:58px">${rich(s.coupon.line)}<div style="font-size:42px;margin-top:10px;opacity:.9;white-space:nowrap">${esc(s.coupon.terms)}</div>${s.coupon.code ? `<div style="margin-top:18px;display:inline-block;border:3px dashed var(--lime);border-radius:16px;padding:6px 28px;font-size:50px;color:var(--lime);direction:ltr;letter-spacing:4px;${codeCss}">${esc(s.coupon.code)}</div>` : `<div style="margin-top:16px;font-size:34px;color:var(--lime);white-space:nowrap">${esc(s.coupon.note || '')}</div>`}</div>`, x: 120, y: 1100, w: 740, start: 5.8, end: 9.4, z: 12, in: { kind: 'slideL', dur: 0.5, by: 900 } },
      ...endCard(spec, 9.2, 11.8),
    ];
  };

  /* ── שאדי מציג · Shadi presents: the mascot beside the offer ── */
  STYLES.shadi = (spec) => {
    const s = spec.subject, t = spec.theme;
    return [
      { full: true, html: `<div class="cover" style="background:radial-gradient(circle at 30% 60%, ${t.glow} 0%, ${t.paper} 60%)"></div>`, start: 0, end: 9.6, z: 1 },
      brandPill(spec, 0, 3.0),
      spec.assets.shadiTalk
        // the lip-synced greeting (Wan 2.7, 720x1280, keyed to alpha): at most 1.15x its pixels
        ? { html: `<video src="${spec.assets.shadiTalk}" muted playsinline preload="auto" style="width:820px;display:block"></video>`, x: 60, y: 470, w: 820, start: 0, end: 3.4, z: 5 }
        : { html: `<img src="${spec.assets.shadiStand}" style="width:900px">`, x: -40, y: 420, w: 900, start: 0, end: 3.4, z: 5, in: { kind: 'up', dur: 0.6, by: 900 }, out: { kind: 'fade', dur: 0.2 } },
      text(spec.text.hook, { size: 64, color: t.ink, bg: '#fff', y: 380, start: 0.6, end: 3.4, inn: { kind: 'pop', dur: 0.4 }, shadow: false, pad: '18px 34px' }),
      // pointing pose: body spans 5–90% of the image width, fingertip at (0.90, 0.32) — at 560 px and
      // x -25 the whole mascot is in frame and the finger lands on the ticket's edge (x ~480)
      { html: `<img src="${spec.assets.shadiPoint}" style="width:600px">`, x: -30, y: 480, w: 600, start: 3.4, end: 9.6, z: 5 },
      ...(s.dishes && s.dishes[0] ? [{ html: `<div class="card" style="width:380px;height:380px;border:10px solid #fff">${img(s.dishes[0].img)}</div>`, x: 495, y: 1060, w: 380, h: 380, rot: 5, start: 3.9, end: 9.6, z: 6, in: { kind: 'drop', dur: 0.5, spin: 10 }, kb: { from: 1.0, to: 1.06 } }] : []),
      { html: `<div class="txt" style="${ticketCss};border-radius:30px;background:${t.ink};color:#fff;padding:30px 30px;font-size:56px;text-wrap:balance;transform:rotate(-4deg)">${rich(s.coupon.line)}<div style="font-size:36px;margin-top:12px;opacity:.9;white-space:pre-line">${esc(s.coupon.terms.replace(' · ', '\n'))}</div>${s.coupon.code ? `<div style="margin-top:20px;display:inline-block;border:3px dashed var(--lime);border-radius:16px;padding:6px 22px;font-size:46px;color:var(--lime);direction:ltr;letter-spacing:4px;${codeCss}">${esc(s.coupon.code)}</div>` : `<div style="margin-top:16px;font-size:34px;color:var(--lime);white-space:nowrap">${esc(s.coupon.note || '')}</div>`}</div>`, x: 478, y: 660, w: 385, start: 3.6, end: 9.6, z: 8, in: { kind: 'slideR', dur: 0.5, by: 700 }, kb: { from: 1.0, to: 1.06, oy: -24 } },
      text(spec.text.line2, { size: 48, color: t.ink, bg: 'var(--lime)', y: 390, start: 4.2, end: 9.6, shadow: false, pad: '16px 30px' }),
      ...endCard(spec, 9.4, 12.0),
    ];
  };

  /* ── Banners: 1920x1080 stills, one per language, the words exact and in the picture ──
   * The home banner carries its words in the picture (the app shows no overlay). Rendered, not
   * drawn by an image model: the real photos and exact text. One banner version per style. */
  const BW = 1920, BH = 1080;
  const still = (l) => ({ start: 0, end: 1, ...l });
  /**
   * The words column on the right, vertically centred in the banner: an optional badge, the offer
   * number BIG (the hook — the largest thing on the banner), the headline, a smaller second line,
   * the terms, an optional price tag, and the button with the store's logo.
   */
  const bannerWords = (spec, { badge = null, big = null, headline, second = null, sub, price = null, color = '#fff', button = true, logo = true, x = 1130, w = 720, btnBg = 'var(--lime)', btnInk = null, bigColor = 'var(--lime)' }) => still({
    html: `<div style="height:${BH}px;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;gap:18px;direction:rtl;text-align:right;color:${color}">`
      + (badge ? `<div class="pill" style="background:var(--lime);color:${spec.theme.ink};font-size:46px;padding:10px 34px">${esc(badge)}</div>` : '')
      + (big ? `<div style="font-size:230px;line-height:.95;color:${bigColor};direction:ltr;unicode-bidi:isolate">${esc(big)}</div>` : '')
      + `<div class="txt" style="font-size:88px;line-height:1.12;text-align:right;text-wrap:balance;max-width:${w}px">${rich(headline)}</div>`
      + (second ? `<div style="font-size:52px;opacity:.85">${esc(second)}</div>` : '')
      + (sub ? `<div style="font-size:44px;opacity:.92;max-width:${w}px;white-space:pre-line">${esc(sub)}</div>` : '')
      + (price ? `<div class="pill" style="background:transparent;border:4px solid var(--lime);color:var(--lime);font-size:52px;padding:4px 28px;direction:ltr">${esc(price)}</div>` : '')
      + (button ? `<div style="margin-top:22px;display:flex;align-items:center;gap:26px"><span class="pill" style="background:${btnBg};color:${btnInk || spec.theme.ink};font-size:52px;padding:18px 52px;white-space:nowrap">${esc(spec.text.ctaButton || spec.text.cta.replace(/\*\*/g, ''))}</span>${logo && spec.subject.store && spec.subject.store.logo ? `<img src="${spec.subject.store.logo}" style="width:150px;height:150px;border-radius:50%;object-fit:cover;background:#fff;border:6px solid var(--lime)">` : ''}</div>` : '')
      + `</div>`,
    x, y: 0, w, h: BH, z: 6,
  });
  const bannerPill = (spec, x = 1500) => still({ html: `<div class="pill" style="background:rgba(0,0,0,.35);color:#fff;font-size:40px"><img src="${spec.assets.icon}" style="width:64px;height:64px;border-radius:16px"><span>${esc(spec.text.pill)}</span></div>`, x, y: 50, w: 360, z: 7 });
  /** A photo filling the left side, its right edge fading into the panel colour. */
  const photoLeft = (src, w, ink, pos = '50% 50%') => still({ html: `<div style="position:relative;width:${w}px;height:${BH}px;overflow:hidden"><img class="cover" src="${src}" style="object-position:${pos}"><div style="position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,0) 62%,${ink} 100%)"></div></div>`, x: 0, y: 0, w, h: BH, z: 2 });

  STYLES.bannerNumber = (spec) => {
    const s = spec.subject, t = spec.theme, d = s.dishes[0];
    return [
      still({ full: true, html: `<div class="cover" style="background:${t.ink}"></div>`, z: 1 }),
      photoLeft(d.img, 1080, t.ink),
      bannerWords(spec, { big: s.offer.big, headline: s.offer.headline || s.offer.line, sub: s.offer.terms }),
      bannerPill(spec),
    ];
  };

  STYLES.bannerCloseup = (spec) => {
    const s = spec.subject, t = spec.theme, d = s.dishes[0];
    return [
      still({ full: true, html: `<div class="cover" style="background:${t.ink}"></div>`, z: 1 }),
      photoLeft(d.img, 1000, t.ink, '50% 60%'),
      bannerWords(spec, { badge: spec.text.hook, headline: d.name, second: s.store.name, sub: (s.chips || []).join(' · '), price: s.price, x: 1110, w: 740 }),
      bannerPill(spec),
    ];
  };

  STYLES.bannerRush = (spec) => {
    const s = spec.subject, t = spec.theme;
    // One identical tile per dish on a black grid: equal rects, one 6 px gutter, no grey seams.
    const TW = 376, TH = 537, G = 6;
    const cells = s.dishes.slice(0, 6).map((d, i) => `<div style="position:absolute;left:${(i % 3) * (TW + G)}px;top:${Math.floor(i / 3) * (TH + G)}px;width:${TW}px;height:${TH}px;overflow:hidden"><img class="cover" src="${d.img}"></div>`).join('');
    return [
      still({ full: true, html: `<div class="cover" style="background:var(--lime)"></div>`, z: 1 }),
      still({ html: `<div style="position:relative;width:${3 * TW + 2 * G}px;height:${BH}px;background:#000">${cells}</div>`, x: 0, y: 0, w: 3 * TW + 2 * G, h: BH, z: 2 }),
      bannerWords(spec, { big: s.offer.big, bigColor: t.ink, headline: s.offer.headline || s.offer.line, sub: s.offer.terms, color: t.ink, x: 1190, w: 680, btnBg: t.ink, btnInk: '#fff' }),
      still({ html: `<div class="pill" style="background:${t.ink};color:#fff;font-size:40px"><img src="${spec.assets.icon}" style="width:64px;height:64px;border-radius:16px"><span>${esc(spec.text.pill)}</span></div>`, x: 1510, y: 50, w: 360, z: 7 }),
    ];
  };

  STYLES.bannerTable = (spec) => {
    const s = spec.subject, t = spec.theme;
    const pos = [{ x: 60, y: 90, r: -5 }, { x: 560, y: 60, r: 4 }, { x: 110, y: 560, r: 3 }, { x: 600, y: 540, r: -3 }];
    const cards = s.dishes.slice(0, 4).map((d, i) => still({ html: `<div class="card" style="width:430px;height:430px;border:12px solid #fff">${img(d.img)}</div>`, x: pos[i].x, y: pos[i].y, w: 430, h: 430, rot: pos[i].r, z: 3 + i }));
    return [
      still({ full: true, html: `<div class="cover" style="background:${t.paper}"></div>`, z: 1 }),
      ...cards,
      still({ html: `<img src="${s.store.logo}" style="width:260px;height:260px;border-radius:50%;object-fit:cover;background:#fff;border:10px solid #fff;box-shadow:0 18px 50px rgba(0,0,0,.3)">`, x: 400, y: 410, w: 260, h: 260, z: 9 }),
      bannerWords(spec, { big: s.offer.big, bigColor: t.ink, headline: s.offer.headline || s.offer.line, sub: s.offer.terms, color: t.ink, x: 1150, logo: false }),
      still({ html: `<div class="pill" style="background:${t.ink};color:#fff;font-size:40px"><img src="${spec.assets.icon}" style="width:64px;height:64px;border-radius:16px"><span>${esc(spec.text.pill)}</span></div>`, x: 1500, y: 50, w: 360, z: 7 }),
    ];
  };

  /** A coupon ticket: notches cut through (a mask, so the background shows), the code in lining figures. */
  const ticketCss = 'mask:radial-gradient(circle 30px at 0 50%,transparent 98%,#000) left/51% 100% no-repeat,radial-gradient(circle 30px at 100% 50%,transparent 98%,#000) right/51% 100% no-repeat;-webkit-mask:radial-gradient(circle 30px at 0 50%,transparent 98%,#000) left/51% 100% no-repeat,radial-gradient(circle 30px at 100% 50%,transparent 98%,#000) right/51% 100% no-repeat';
  const codeCss = "font-family:'SF Pro Display','Helvetica Neue',Arial,sans-serif;font-variant-numeric:lining-nums;font-weight:600";
  const couponTicket = (spec, x, y, w, rot = -3) => {
    const s = spec.subject, t = spec.theme;
    return still({ html: `<div class="txt" style="${ticketCss};border-radius:30px;background:${t.ink};color:#fff;padding:40px 60px;font-size:72px;transform:rotate(${rot}deg)">${rich(s.coupon.line)}<div style="font-size:40px;margin-top:12px;opacity:.9;white-space:nowrap">${esc(s.coupon.terms)}</div>${s.coupon.code ? `<div style="margin-top:22px;display:inline-block;border:3px dashed var(--lime);border-radius:16px;padding:8px 28px;font-size:54px;color:var(--lime);direction:ltr;letter-spacing:4px;${codeCss}">${esc(s.coupon.code)}</div>` : `<div style="margin-top:16px;font-size:34px;color:var(--lime);white-space:nowrap">${esc(s.coupon.note || '')}</div>`}</div>`, x, y, w, z: 8 });
  };

  STYLES.bannerInapp = (spec) => {
    const s = spec.subject, t = spec.theme, sc = spec.assets.screen;
    const PW = 520, SW = PW - 32, scale = SW / sc.width, viewH = Math.round(sc.view * scale), top = -Math.round(sc.from * scale);
    const hl = `<div class="hl" style="left:${sc.hl.x * scale - 8}px;top:${(sc.hl.y - sc.from) * scale - 8}px;width:${sc.hl.w * scale + 16}px;height:${sc.hl.h * scale + 16}px"></div>`;
    return [
      still({ full: true, html: `<div class="cover" style="background:${t.paper}"></div>`, z: 1 }),
      still({ html: `<div class="phone" style="width:${PW}px;transform:rotate(-6deg)"><div class="scr" style="height:${viewH}px"><img src="${sc.src}" style="width:${SW}px;position:absolute;top:${top}px;left:0">${hl}</div></div>`, x: 120, y: 230, w: PW, z: 5 }),
      couponTicket(spec, 640, 380, 600),
      bannerWords(spec, { headline: spec.text.hook, sub: spec.text.line2 || null, color: t.ink, x: 1290, w: 580, y: 300, logo: false }),
      still({ html: `<div class="pill" style="background:${t.ink};color:#fff;font-size:40px"><img src="${spec.assets.icon}" style="width:64px;height:64px;border-radius:16px"><span>${esc(spec.text.pill)}</span></div>`, x: 1510, y: 60, w: 360, z: 7 }),
    ];
  };

  STYLES.bannerShadi = (spec) => {
    const t = spec.theme;
    return [
      still({ full: true, html: `<div class="cover" style="background:radial-gradient(circle at 25% 60%, ${t.glow} 0%, ${t.paper} 65%)"></div>`, z: 1 }),
      still({ html: `<img src="${spec.assets.shadiPoint}" style="width:700px">`, x: 30, y: 120, w: 700, z: 5 }),
      couponTicket(spec, 660, 310, 600, 4),
      bannerWords(spec, { headline: spec.text.hook, sub: spec.text.line2, color: t.ink, x: 1260, w: 610, y: 280 }),
      still({ html: `<div class="pill" style="background:${t.ink};color:#fff;font-size:40px"><img src="${spec.assets.icon}" style="width:64px;height:64px;border-radius:16px"><span>${esc(spec.text.pill)}</span></div>`, x: 1510, y: 60, w: 360, z: 7 }),
    ];
  };

  window.STYLES = STYLES;
})();
