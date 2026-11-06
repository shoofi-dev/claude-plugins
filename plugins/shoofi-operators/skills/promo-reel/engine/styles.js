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
  const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, (_, w) => `<span style="background:var(--lime);color:var(--ink);border-radius:14px;padding:0 14px;white-space:nowrap">${w}</span>`);
  const img = (src, extra = '') => `<img class="cover" src="${src}" style="${extra}">`;
  /** A dish: its animated clip when the spec has one (a Kling clip from the real photo), else the photo. */
  const media = (d, extra = '') => (d.clip ? `<video class="cover" src="${d.clip}" muted playsinline preload="auto" style="${extra}"></video>` : img(d.img, extra));

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

  /** The end card: the CTA spoken and shown (Meta: 1.9×), Shoofi + the store's logo. Brand ≤ 25% of the video. */
  const endCard = (spec, start, end) => {
    const t = spec.theme;
    const store = spec.subject.store && spec.subject.store.logo
      ? `<div style="margin-top:56px;display:flex;align-items:center;justify-content:center;gap:24px;font-size:44px;color:${t.endInk}"><img src="${spec.subject.store.logo}" style="width:150px;height:150px;border-radius:50%;object-fit:cover;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.25)"><span>${esc(spec.subject.store.name)}</span></div>`
      : '';
    return [
      { full: true, html: `<div class="cover" style="background:${t.endBg}"></div>`, start, end, z: 40, in: { kind: 'fade', dur: 0.3 } },
      {
        html: `<div class="txt" style="color:${t.endInk}"><img src="${spec.assets.icon}" style="width:230px;height:230px;border-radius:56px;box-shadow:0 18px 50px rgba(0,0,0,.25)"><div style="font-size:92px;margin-top:46px">${rich(spec.text.cta)}</div>${spec.text.ctaSub ? `<div style="font-size:42px;opacity:.85;margin-top:18px">${esc(spec.text.ctaSub)}</div>` : ''}${store}</div>`,
        x: SAFE.x, w: SAFE.w, y: 520, start: start + 0.1, end, z: 41, in: { kind: 'pop', dur: 0.45 },
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
      { html: `<div class="txt" style="font-size:96px;color:#fff">${esc(s.offer.label)}</div>`, x: SAFE.x, w: SAFE.w, y: 560, start: 0.15, end: 2.2, z: 10, in: { kind: 'rise', dur: 0.35 }, out: { kind: 'fade' } },
      { html: `<div class="txt" style="font-size:340px;line-height:1;color:var(--lime);direction:ltr">${esc(s.offer.big)}</div>`, x: SAFE.x, w: SAFE.w, y: 700, start: 0.35, end: 2.2, z: 10, in: { kind: 'slam', dur: 0.55, from: 1.6 }, out: { kind: 'shrink', dur: 0.3 } },
      { full: true, html: media(d[0]), start: 1.9, end: 5.0, z: 2, in: { kind: 'fade', dur: 0.3 }, kb: { from: 1.05, to: 1.22, oy: -40 } },
      offerBadge(spec, s.offer.big, s.offer.label, { x: 520, y: 300, size: 300, start: 2.1, end: 9.6 }),
      text(s.offer.line, { size: 66, bg: 'rgba(23,50,15,.88)', y: 1180, start: 2.3, end: 5.0 }),
      { full: true, html: media(d[1]), start: 4.8, end: 7.6, z: 3, in: { kind: 'fade', dur: 0.25 }, kb: { from: 1.18, to: 1.04, ox: 30 } },
      text(d[1].name, { size: 62, bg: 'rgba(255,255,255,.94)', color: t.ink, y: 1220, start: 5.0, end: 7.6 }),
      { full: true, html: `<div class="cover" style="background:${t.paper}"></div>`, start: 7.4, end: 9.8, z: 4, in: { kind: 'fade', dur: 0.3 } },
      { html: `<div style="display:flex;justify-content:center"><div class="card" style="width:420px;height:420px;border:10px solid #fff">${img(d[0].img)}</div></div>`, x: SAFE.x, w: SAFE.w, y: 560, start: 7.6, end: 9.8, z: 6, in: { kind: 'pop', dur: 0.4 } },
      text(s.offer.terms.replace(' · ', '\n'), { size: 74, color: t.ink, bg: '#fff', y: 1060, start: 7.8, end: 9.8, shadow: false }),
      ...endCard(spec, 9.6, 12.2),
    ];
  };

  /* ── קצב · Fast cuts: one dish a second, on the beat, big words ── */
  STYLES.rush = (spec) => {
    const s = spec.subject, t = spec.theme;
    const out = [brandPill(spec, 0, 1.6)];
    const cut = 0.9, start = 0;
    s.dishes.slice(0, 6).forEach((d, i) => {
      out.push({ full: true, html: media(d), start: start + i * cut, end: start + (i + 1) * cut + 0.02, z: 2 + i, punch: true, kb: { from: 1.0, to: 1.08 } });
    });
    const after = start + Math.min(6, s.dishes.length) * cut;
    out.push(text(spec.text.hook, { size: 120, y: 760, start: 0.1, end: 1.8, inn: { kind: 'slam', dur: 0.4, from: 0.8 } }));
    out.push(text(s.store.name, { size: 70, bg: 'var(--lime)', color: t.ink, y: 1160, start: 1.8, end: after, inn: { kind: 'slideR', dur: 0.35 } }));
    out.push({ full: true, html: `<div class="cover" style="background:${t.ink}"></div>`, start: after, end: after + 2.6, z: 20 });
    out.push(offerBadge(spec, s.offer.big, s.offer.label, { x: 310, y: 520, size: 420, start: after + 0.05, end: after + 2.6, z: 22 }));
    out.push(text(`${s.offer.line.replace(/\*\*/g, '')}\n${s.offer.terms}`, { size: 58, y: 1060, start: after + 0.35, end: after + 2.6, z: 23 }));
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
      out.push({ html: `<div class="card" style="width:430px;height:430px;border:12px solid #fff">${img(d.img)}</div>`, x: c.x, y: c.y, w: 430, h: 430, rot: c.r, start: 0.3 + i * 0.45, end: 9.4, z: 3 + i, in: { kind: 'drop', dur: 0.5, spin: c.r * 3 } });
    });
    out.push({ html: `<div style="display:flex;justify-content:center"><img src="${s.store.logo}" style="width:300px;height:300px;border-radius:50%;object-fit:cover;background:#fff;box-shadow:0 18px 50px rgba(0,0,0,.3);border:10px solid #fff"></div>`, x: SAFE.x, w: SAFE.w, y: 640, start: 2.3, end: 9.4, z: 12, in: { kind: 'pop', dur: 0.45 } });
    out.push(text(spec.text.hook, { size: 70, color: t.ink, bg: '#fff', y: 1300, start: 2.6, end: 5.4, shadow: false }));
    out.push(offerBadge(spec, s.offer.big, s.offer.label, { x: 80, y: 1140, size: 300, start: 5.2, end: 9.4, z: 14 }));
    out.push(text(`${s.offer.line}\n${s.offer.terms}`, { size: 54, color: '#fff', bg: t.ink, y: 1190, x: 400, w: 470, start: 5.4, end: 9.4, pad: '24px 26px' }));
    out.push(...endCard(spec, 9.2, 11.8));
    return out;
  };

  /* ── תקריב · Close-up: one dish, slow macro, very few words ── */
  STYLES.closeup = (spec) => {
    const s = spec.subject, t = spec.theme, d = s.dishes[0];
    return [
      { full: true, html: media(d, 'transform-origin:50% 55%'), start: 0, end: 8.6, z: 1, kb: { from: 1.15, to: 1.55, oy: -60 } },
      { full: true, html: `<div class="cover" style="background:linear-gradient(180deg,rgba(0,0,0,.45) 0%,rgba(0,0,0,0) 30%,rgba(0,0,0,0) 55%,rgba(0,0,0,.7) 100%)"></div>`, start: 0, end: 8.6, z: 2 },
      brandPill(spec, 0, 3.0),
      text(spec.text.hook, { size: 64, bg: 'var(--lime)', color: t.ink, y: 430, x: 300, w: 320, start: 0.4, end: 3.0, inn: { kind: 'pop', dur: 0.4 }, pad: '14px 28px' }),
      text(d.name, { size: 104, y: 1020, start: 1.6, end: 5.6, inn: { kind: 'rise', dur: 0.6, by: 50 } }),
      text(s.store.name, { size: 50, color: '#fff', y: 1180, start: 2.2, end: 5.6 }),
      { html: `<div class="txt">${(s.chips || []).map((c) => `<span class="chip" style="background:rgba(255,255,255,.95);color:${t.ink};font-size:46px">${esc(c)}</span>`).join('')}</div>`, x: SAFE.x, w: SAFE.w, y: 1040, start: 5.6, end: 8.4, z: 20, in: { kind: 'rise', dur: 0.5 } },
      ...(s.price ? [text(s.price, { size: 60, bg: t.ink, y: 1300, x: 330, w: 280, start: 6.2, end: 8.4, pad: '14px 26px' })] : []),
      ...endCard(spec, 8.4, 11.0),
    ];
  };

  /* ── באפליקציה · In the app: the order happens on a real screen ── */
  STYLES.inapp = (spec) => {
    const s = spec.subject, t = spec.theme, sc = spec.assets.screen;
    const PW = 700, SW = PW - 32;
    const scale = SW / sc.width;
    const viewH = Math.round(sc.view * scale);
    const top = -Math.round(sc.from * scale);
    const hl = sc.hl ? `<div class="hl" style="left:${sc.hl.x * scale - 8}px;top:${(sc.hl.y - sc.from) * scale - 8}px;width:${sc.hl.w * scale + 16}px;height:${sc.hl.h * scale + 16}px"></div>` : '';
    const callW = 780, cs = callW / sc.hl.w;
    return [
      { full: true, html: `<div class="cover" style="background:${t.paper}"></div>`, start: 0, end: 9.4, z: 1 },
      brandPill(spec, 0, 3.0),
      text(spec.text.hook, { size: 72, color: t.ink, y: 430, start: 0.2, end: 9.4, shadow: false }),
      { html: `<div class="phone" style="width:${PW}px"><div class="scr" style="height:${viewH}px"><img src="${sc.src}" style="width:${SW}px;position:absolute;top:${top}px;left:0">${hl}</div></div>`, x: 120, y: 600, w: PW, start: 0.5, end: 9.4, z: 5, in: { kind: 'up', dur: 0.7, by: 1300 } },
      { html: `<div class="card" style="width:${callW}px;height:${Math.round(sc.hl.h * cs)}px;border:8px solid var(--lime);box-shadow:0 0 0 5px ${t.ink},0 30px 60px rgba(0,0,0,.35)"><img src="${sc.src}" style="width:${sc.width * cs}px;margin-left:${-sc.hl.x * cs}px;margin-top:${-sc.hl.y * cs}px;display:block"></div>`, x: 140, y: 820, w: callW, start: 2.4, end: 6.4, z: 10, in: { kind: 'pop', dur: 0.45 }, out: { kind: 'shrink' } },
      { html: `<div class="ticket txt" style="--hole:${t.paper};background:${t.ink};color:#fff;padding:34px 60px;font-size:58px">${rich(s.coupon.line)}<div style="font-size:44px;margin-top:12px;opacity:.9">${esc(s.coupon.terms)}</div><div style="margin-top:20px;display:inline-block;border:3px dashed var(--lime);border-radius:16px;padding:8px 28px;font-size:52px;color:var(--lime);direction:ltr;letter-spacing:4px">${esc(s.coupon.code)}</div></div>`, x: 150, y: 1160, w: 760, start: 5.8, end: 9.4, z: 12, in: { kind: 'slideL', dur: 0.5, by: 900 } },
      ...endCard(spec, 9.2, 11.8),
    ];
  };

  /* ── שאדי מציג · Shadi presents: the mascot beside the offer ── */
  STYLES.shadi = (spec) => {
    const s = spec.subject, t = spec.theme;
    return [
      { full: true, html: `<div class="cover" style="background:radial-gradient(circle at 30% 60%, ${t.glow} 0%, ${t.paper} 60%)"></div>`, start: 0, end: 9.6, z: 1 },
      brandPill(spec, 0, 3.0),
      { html: `<img src="${spec.assets.shadiStand}" style="width:900px">`, x: -40, y: 420, w: 900, start: 0, end: 3.4, z: 5, in: { kind: 'up', dur: 0.6, by: 900 }, out: { kind: 'fade', dur: 0.2 } },
      text(spec.text.hook, { size: 76, color: t.ink, bg: '#fff', y: 470, start: 0.6, end: 3.4, inn: { kind: 'pop', dur: 0.4 }, shadow: false }),
      { html: `<img src="${spec.assets.shadiPoint}" style="width:780px">`, x: -230, y: 700, w: 780, start: 3.2, end: 9.6, z: 5, in: { kind: 'fade', dur: 0.2 } },
      { html: `<div class="ticket txt" style="--hole:${t.paper};background:${t.ink};color:#fff;padding:40px 44px;font-size:64px;transform:rotate(-4deg)">${rich(s.coupon.line)}<div style="font-size:40px;margin-top:14px;opacity:.9">${esc(s.coupon.terms)}</div><div style="margin-top:22px;display:inline-block;border:3px dashed var(--lime);border-radius:16px;padding:8px 24px;font-size:48px;color:var(--lime);direction:ltr;letter-spacing:4px">${esc(s.coupon.code)}</div></div>`, x: 430, y: 760, w: 520, start: 3.5, end: 9.6, z: 8, in: { kind: 'slideR', dur: 0.5, by: 700 }, pulse: 0.5 },
      text(spec.text.line2, { size: 58, color: t.ink, bg: 'var(--lime)', y: 1330, start: 5.2, end: 9.6, shadow: false }),
      ...endCard(spec, 9.4, 12.0),
    ];
  };

  window.STYLES = STYLES;
})();
