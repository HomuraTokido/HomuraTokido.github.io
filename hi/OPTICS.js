/* Homura Interface · 光学层
   DESIGN.md「玻璃的构成 · 光学层」是这种材质的光学模型；网页上的实现与退回见「网页渲染器」。
   本脚本按每块玻璃的尺寸生成位移图、边带蒙版、光照图、胶囊蒙版，接进
   backdrop-filter: url() 的 SVG 滤镜链，挂在元素的 .hi-optics 子层上（比玻璃大一圈，
   所以能读到玻璃周围的像素，外面的内容才弯得进边带）。
   退回（DESIGN.md「网页渲染器 · 光学层」）：引擎不支持 backdrop 上的 SVG 滤镜、用户减少透明度、
   超出一屏预算、data-hi-optics="off"，都静默退回 CSS 基础层。
   参数全部来自 TOKENS.css 的 --optics-* 变量。
   参考：feImage + feDisplacementMap 管线 shuding/liquid-glass；倒角与折射率建模
   archisvaze/liquid-glass；三通道色散 deepika-builds/liquid-glass。 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  var NS = 'http://www.w3.org/2000/svg';
  var SELECTOR = '.hi-glass-regular, .hi-toolbar, .hi-popover, .hi-button--glass, .hi-button--prominent';
  var INSIDE_TOOLBAR = '.hi-toolbar .hi-button--glass, .hi-toolbar .hi-button--prominent';
  var registry = [];
  var counter = 0;
  var defs = null;
  var io = null;
  var ro = null;
  var scheduled = false;
  var enabledGlobally = true;

  function supported() {
    if (!window.matchMedia || !window.CSS || !CSS.supports) return false;
    /* 对照用：URL 带 ?hi-optics=off 时整页退回 CSS 基础层，方便肉眼 A/B */
    if (/[?&]hi-optics=off(&|$)/.test(location.search)) return false;
    if (window.matchMedia('(prefers-reduced-transparency: reduce)').matches) return false;
    if (!CSS.supports('backdrop-filter', 'blur(1px)') && !CSS.supports('-webkit-backdrop-filter', 'blur(1px)')) return false;
    var uad = navigator.userAgentData;
    if (uad && uad.brands && uad.brands.length) {
      return uad.brands.some(function (b) { return /Chromium/i.test(b.brand); });
    }
    var ua = navigator.userAgent || '';
    return /Chrome\/\d+/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  }

  /* 参数只从 TOKENS.css 的变量读，这里不留第二份默认值。读不到（TOKENS.css 没加载）就不启动光学层，
     页面退回 CSS 基础层；不拿一份抄来的数硬跑。 */
  function num(el, name) {
    return parseFloat(getComputedStyle(el).getPropertyValue(name));
  }
  var warned = false;
  function readParams(el) {
    var tinted = el.classList.contains('hi-button--prominent') || el.hasAttribute('data-hi-tinted');
    var P = {
      band: num(el, '--optics-bevel'),
      thick: num(el, '--optics-thickness'),
      ior: num(el, '--optics-ior'),
      ca: num(el, '--optics-chroma'),
      pad: num(el, '--optics-pad'),
      edgeBlur: num(el, '--optics-edge-blur'),
      innerBlur: num(el, '--hi-optics-blur'),
      sat: num(el, '--hi-optics-saturation'),
      hi: num(el, '--optics-highlight'),
      shade: num(el, '--optics-shade'),
      lift: num(el, '--optics-lift'),
      angle: num(el, '--optics-light-angle'),
      budget: num(el, '--optics-budget')
    };
    if (isNaN(P.innerBlur)) P.innerBlur = num(el, tinted ? '--material-glass-tint-blur' : '--material-glass-regular-blur');
    if (isNaN(P.sat)) P.sat = num(el, tinted ? '--material-glass-tint-saturation' : '--material-glass-regular-saturation');
    for (var k in P) if (isNaN(P[k])) {
      if (!warned) { warned = true; console.warn('Homura Interface 光学层没有启动：读不到变量（缺的是 ' + k + '）。先加载 TOKENS.css；页面现在用的是 CSS 基础层。'); }
      return null;
    }
    P.budget = Math.max(0, Math.round(P.budget));
    return P;
  }

  function sdf(x, y, w, h, r) {
    var qx = Math.abs(x - w / 2) - (w / 2 - r);
    var qy = Math.abs(y - h / 2) - (h / 2 - r);
    var ox = Math.max(qx, 0), oy = Math.max(qy, 0);
    return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
  }

  /* 四张图，尺寸是外框（本体加外延）的尺寸；本体在其中偏移 pad。
     map   位移图：R/G 编码指向外部的法线，强度按倒角折射衰减
     band  边带蒙版
     light 光照图：白高光 / 黑暗边 / 内侧提亮
     mask  本体蒙版，1px 抗锯齿 */
  function makeMaps(P, W, H, pad, w, h, r, dpr) {
    var PW = Math.max(1, Math.round(W * dpr)), PH = Math.max(1, Math.round(H * dpr));
    var names = ['map', 'band', 'light', 'mask'], cv = {}, ctx = {}, img = {}, data = {};
    names.forEach(function (n) {
      cv[n] = document.createElement('canvas'); cv[n].width = PW; cv[n].height = PH;
      ctx[n] = cv[n].getContext('2d'); img[n] = ctx[n].createImageData(PW, PH); data[n] = img[n].data;
    });
    var dm = data.map, db = data.band, dl = data.light, dk = data.mask;
    var a = P.angle * Math.PI / 180, Lx = Math.cos(a), Ly = Math.sin(a);
    var eps = 0.5, band = Math.max(1, P.band), rim = 2.4, rim2 = 1.8;
    var maxOff = P.thick * Math.tan(Math.asin(Math.min(1, 1 / P.ior)));
    function bevel(d) {
      var t = Math.min(1, Math.max(d, 0) / band);
      var sinT = Math.sqrt(Math.max(0, 1 - t * t)) / P.ior;
      var off = P.thick * Math.tan(Math.asin(Math.min(1, sinT)));
      return maxOff > 0 ? off / maxOff : 0;
    }
    for (var j = 0; j < PH; j++) {
      for (var i = 0; i < PW; i++) {
        var x = (i + 0.5) / dpr - pad, y = (j + 0.5) / dpr - pad;
        var s = sdf(x, y, w, h, r);
        var d = -s;
        var o = (j * PW + i) * 4;
        dk[o] = dk[o + 1] = dk[o + 2] = 255; dk[o + 3] = Math.round(Math.max(0, Math.min(1, 0.5 - s)) * 255);
        if (d < -1) { dm[o] = 128; dm[o + 1] = 128; dm[o + 2] = 0; dm[o + 3] = 255; continue; }
        var nx = sdf(x + eps, y, w, h, r) - sdf(x - eps, y, w, h, r);
        var ny = sdf(x, y + eps, w, h, r) - sdf(x, y - eps, w, h, r);
        var nl = Math.sqrt(nx * nx + ny * ny) || 1; nx /= nl; ny /= nl;
        var f = bevel(d);
        dm[o] = Math.round(128 + nx * f * 127);
        dm[o + 1] = Math.round(128 + ny * f * 127);
        dm[o + 2] = 0; dm[o + 3] = 255;
        db[o] = db[o + 1] = db[o + 2] = 255; db[o + 3] = Math.round(Math.min(1, f * 1.25) * 255);
        var ndl = nx * Lx + ny * Ly;
        var edge = Math.max(0, 1 - Math.max(d, 0) / rim), edge2 = Math.max(0, 1 - Math.max(d, 0) / rim2);
        var spec = Math.pow(Math.max(ndl, 0), 1.5) * edge * P.hi;
        var shade = Math.pow(Math.max(-ndl, 0), 1.5) * edge2 * P.shade;
        var glow = f * P.lift;
        if (spec + glow >= shade) { dl[o] = dl[o + 1] = dl[o + 2] = 255; dl[o + 3] = Math.round(Math.min(1, spec + glow * (1 - spec)) * 255); }
        else { dl[o] = dl[o + 1] = dl[o + 2] = 0; dl[o + 3] = Math.round(Math.min(1, shade) * 255); }
      }
    }
    var out = { maxOff: maxOff };
    names.forEach(function (n) { ctx[n].putImageData(img[n], 0, 0); out[n] = cv[n].toDataURL('image/png'); });
    return out;
  }

  /* 材料公式（DESIGN.md 玻璃的构成）：输出 = 透过率 × (背景 × 滤色) + (1 − 透过率) × 玻璃自己的颜色。
     own   取 --hi-fill 的颜色。
     t     取 --hi-glass-t（由层级决定，见 TOKENS.css --material-glass-t-*）；没有时退回 1 − 填充的不透明度。
     F     无色玻璃是白（不滤色）；own 有色相时就取 own（太暗的颜色按比例提到最亮通道 --material-glass-filter-floor）；--hi-glass-filter 可以明写。
     半透明涂色是这个公式在 F = 白时的特例，所以无色玻璃和过去的样子一致；染色玻璃从涂色变成滤色。 */
  var probe = null;
  function parseColor(value) {
    if (!probe) { probe = document.createElement('span'); probe.style.display = 'none'; document.body.appendChild(probe); }
    probe.style.color = ''; probe.style.color = value;
    var cs = probe.style.color ? getComputedStyle(probe).color : '';
    var n = (cs.match(/-?[\d.]+(?:e-?\d+)?%?/g) || []).map(function (x) { return x.slice(-1) === '%' ? parseFloat(x) / 100 : parseFloat(x); });
    if (n.length < 3) return { r: 0, g: 0, b: 0, a: 0 };
    var unit = cs.indexOf('color(') === 0 ? 1 : 255;
    return { r: n[0] / unit, g: n[1] / unit, b: n[2] / unit, a: n.length > 3 ? n[3] : 1 };
  }
  function materialOf(el) {
    var style = getComputedStyle(el);
    return materialMatrix(style.getPropertyValue('--hi-fill').trim() || 'transparent',
      parseFloat(style.getPropertyValue('--hi-glass-t')), style.getPropertyValue('--hi-glass-filter').trim());
  }
  /* 同一个公式给库外的玻璃用（例如栏上的当前项）：传颜色、透过率，拿回 feColorMatrix 的 values */
  function materialMatrix(ownColor, t, filterColor) {
    var own = parseColor(ownColor);
    if (isNaN(t)) t = 1 - own.a;
    if (own.a === 0) t = 1;
    t = Math.max(0, Math.min(1, t));
    var F = [1, 1, 1];
    var explicit = filterColor;
    if (explicit) { var e = parseColor(explicit); F = [e.r, e.g, e.b]; }
    else {
      var mx = Math.max(own.r, own.g, own.b), mn = Math.min(own.r, own.g, own.b);
      if (mx > 0 && (mx - mn) / mx >= 0.25) { var floor = num(document.documentElement, '--material-glass-filter-floor'); var lift = isNaN(floor) ? 1 : Math.max(1, floor / mx); F = [own.r * lift, own.g * lift, own.b * lift]; }
    }
    var row = function (f, o, i) { var r = ['0', '0', '0']; r[i] = (t * f).toFixed(4); return r.join(' ') + ' 0 ' + ((1 - t) * o).toFixed(4); };
    return row(F[0], own.r, 0) + '  ' + row(F[1], own.g, 1) + '  ' + row(F[2], own.b, 2) + '  0 0 0 1 0';
  }

  function ensureDefs() {
    if (defs) return defs;
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;';
    defs = document.createElementNS(NS, 'defs');
    svg.appendChild(defs);
    document.body.appendChild(svg);
    return defs;
  }

  function build(entry) {
    var el = entry.el;
    var P = readParams(el);
    if (!P) return false;
    var rect = el.getBoundingClientRect();
    var w = Math.round(rect.width), h = Math.round(rect.height);
    if (!w || !h) return false;
    var pad = P.pad;
    var W = w + pad * 2, H = h + pad * 2;
    var radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    var r = Math.min(radius, Math.min(w, h) / 2);
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var maps = makeMaps(P, W, H, pad, w, h, r, dpr);
    var sat = P.sat;
    var material = materialOf(el);
    var S = maps.maxOff * 2;

    /* Chromium 改了滤镜内部不会让引用它的 backdrop-filter 重绘，每次重建换新 id */
    if (entry.filter) entry.filter.remove();
    var f = document.createElementNS(NS, 'filter');
    f.id = 'hi-optics-' + (++counter);
    /* feImage 的百分比尺寸会参照零尺寸的 SVG viewport，蒙版因此变空。
       整条链统一使用光学层的 CSS 像素尺寸，包含采样外延。 */
    f.setAttribute('filterUnits', 'userSpaceOnUse');
    f.setAttribute('primitiveUnits', 'userSpaceOnUse');
    f.setAttribute('x', '0'); f.setAttribute('y', '0'); f.setAttribute('width', W); f.setAttribute('height', H);
    f.setAttribute('color-interpolation-filters', 'sRGB');
    var img = function (n, res) { return '<feImage href="' + maps[n] + '" x="0" y="0" width="' + W + '" height="' + H + '" preserveAspectRatio="none" result="' + res + '"/>'; };
    var displace = function (scale, res) { return '<feDisplacementMap in="crisp" in2="map" scale="' + scale.toFixed(2) + '" xChannelSelector="R" yChannelSelector="G" result="' + res + '"/>'; };
    var keep = function (ch, inp, res) {
      var rows = { r: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', g: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', b: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0' };
      return '<feColorMatrix in="' + inp + '" type="matrix" values="' + rows[ch] + '" result="' + res + '"/>';
    };
    var bent = (P.ca > 0)
      ? displace(S * (1 - P.ca), 'dR') + keep('r', 'dR', 'cR') +
        displace(S, 'dG') + keep('g', 'dG', 'cG') +
        displace(S * (1 + P.ca), 'dB') + keep('b', 'dB', 'cB') +
        '<feComposite in="cR" in2="cG" operator="arithmetic" k2="1" k3="1" result="cRG"/>' +
        '<feComposite in="cRG" in2="cB" operator="arithmetic" k2="1" k3="1" result="bent"/>'
      : displace(S, 'bent');
    f.innerHTML =
      img('map', 'map') + img('band', 'band') + img('light', 'light') + img('mask', 'mask') +
      '<feGaussianBlur in="SourceGraphic" stdDeviation="' + P.innerBlur + '" result="soft"/>' +
      '<feGaussianBlur in="SourceGraphic" stdDeviation="' + P.edgeBlur + '" result="crisp"/>' +
      bent +
      '<feComposite in="bent" in2="band" operator="in" result="bentBand"/>' +
      '<feComposite in="bentBand" in2="soft" operator="over" result="glass"/>' +
      '<feColorMatrix in="glass" type="saturate" values="' + sat + '" result="sat"/>' +
      '<feColorMatrix in="sat" type="matrix" values="' + material + '" result="filled"/>' +
      '<feComposite in="light" in2="filled" operator="over" result="lit"/>' +
      /* 最后只按本体蒙版裁掉外延区域：输出透明处 Chromium 露出原背景。
         不要再叠回 SourceGraphic，链里有模糊时它是错位的。 */
      '<feComposite in="lit" in2="mask" operator="in"/>';
    ensureDefs().appendChild(f);
    entry.filter = f;
    /* 光学层是一个真实的子元素，不用 ::before：伪元素上的 backdrop-filter 在固定定位的元素里
       时有时无（2026-09-15 在真实页面上撞到），真实元素和所有第三方实现一致，稳定 */
    if (!entry.layer || entry.layer.parentNode !== el) {
      entry.layer = document.createElement('span');
      entry.layer.className = 'hi-optics';
      entry.layer.setAttribute('aria-hidden', 'true');
      el.insertBefore(entry.layer, el.firstChild);
    }
    entry.layer.style.webkitBackdropFilter = 'url(#' + f.id + ')';
    entry.layer.style.backdropFilter = 'url(#' + f.id + ')';
    el.style.setProperty('--hi-optics-pad', pad + 'px');
    el.setAttribute('data-hi-optics', 'on');
    return true;
  }

  function enable(entry) {
    if (entry.enabled) return;
    entry.enabled = build(entry);
    if (entry.enabled && ro) ro.observe(entry.el);
  }
  function disable(entry) {
    if (!entry.enabled) return;
    entry.enabled = false;
    if (ro) ro.unobserve(entry.el);
    if (entry.filter) { entry.filter.remove(); entry.filter = null; }
    if (entry.layer) { entry.layer.remove(); entry.layer = null; }
    entry.el.style.removeProperty('--hi-optics-pad');
    if (entry.el.getAttribute('data-hi-optics') === 'on') entry.el.removeAttribute('data-hi-optics');
  }

  function eligible(el) {
    if (el.getAttribute('data-hi-optics') === 'off') return false;
    if (el.matches(INSIDE_TOOLBAR)) return false;
    if (el.closest('[data-hi-optics="off"]')) return false;
    return true;
  }

  /* IntersectionObserver 在标签页不可见时不回调；它第一次回调之前用几何判断可见性 */
  var ioFired = false;
  function inViewport(el) {
    var r = el.getBoundingClientRect();
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  }

  /* 预算：一屏内最多 budget 块。已开着的保留，新进入视口的排队；离开视口的关掉。 */
  function reconcile() {
    scheduled = false;
    var rootParams = readParams(document.documentElement);
    var budget = rootParams ? rootParams.budget : 0;
    var on = [], pending = [];
    registry.forEach(function (e) {
      var visible = ioFired ? e.visible : inViewport(e.el);
      var ok = enabledGlobally && visible && eligible(e.el);
      if (!ok) { disable(e); return; }
      if (e.enabled) on.push(e); else pending.push(e);
    });
    var room = budget - on.length;
    pending.slice(0, Math.max(0, room)).forEach(enable);
  }
  function schedule() {
    if (scheduled) return; scheduled = true;
    /* setTimeout 而不是 rAF：标签页不可见时 rAF 不跑 */
    setTimeout(reconcile, 0);
  }

  function register(el) {
    if (registry.some(function (e) { return e.el === el; })) return;
    var entry = { el: el, visible: false, enabled: false, filter: null, layer: null };
    registry.push(entry);
    if (io) io.observe(el);
  }
  function scan(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll(SELECTOR), register);
    schedule();
  }

  function rebuildEnabled() {
    registry.forEach(function (e) { if (e.enabled) build(e); });
  }

  function start() {
    if (!supported()) return;
    io = new IntersectionObserver(function (entries) {
      ioFired = true;
      entries.forEach(function (x) {
        var e = registry.filter(function (r) { return r.el === x.target; })[0];
        if (e) e.visible = x.isIntersecting;
      });
      schedule();
    }, { rootMargin: '0px' });
    if (window.ResizeObserver) {
      var pendingResize = null;
      ro = new ResizeObserver(function () {
        clearTimeout(pendingResize);
        pendingResize = setTimeout(rebuildEnabled, 60);
      });
    }
    /* 主题、红 off、背景明暗切换会改填充色，重建开着的块 */
    if (window.MutationObserver) {
      new MutationObserver(function (muts) {
        /* 自己往 defs 里增删 filter 也是 childList 变动，不过滤就会每 340ms 重建一次，永不停下，
           玻璃永远画不出稳定的一帧（2026-09-15 在真实页面上撞到） */
        /* 库里别处放滤镜的 svg（栏上当前项的滤色片）标了 data-hi-defs，同理要过滤：
           它每换一次滤镜，这里就重建一次，重建又让栏的光学层开关翻一次，滤色片再换一次，循环不止 */
        var own = defs ? defs.parentNode : null;
        muts = muts.filter(function (m) {
          if (own && (m.target === own || own.contains(m.target))) return false;
          return !(m.target.closest && m.target.closest('[data-hi-defs]'));
        });
        var hit = muts.some(function (m) { return m.type === 'attributes' ? true : (m.addedNodes && m.addedNodes.length); });
        if (!hit) return;
        muts.forEach(function (m) { if (m.type === 'childList') Array.prototype.forEach.call(m.addedNodes, function (n) { if (n.nodeType === 1 && n !== own) scan(n); }); });
        clearTimeout(start._t);
        start._t = setTimeout(rebuildEnabled, 340);
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-red', 'data-hi-backdrop', 'hidden', 'data-hi-state'], subtree: true, childList: true });
    }
    /* IO 回调之前，滚动与缩放时按几何重新判断 */
    var onScroll = function () { if (!ioFired) schedule(); };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    var mq = window.matchMedia('(prefers-reduced-transparency: reduce)');
    if (mq.addEventListener) mq.addEventListener('change', function () { enabledGlobally = !mq.matches; schedule(); });
    scan(document);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(rebuildEnabled);
  }

  window.HomuraOptics = {
    supported: supported,
    materialMatrix: materialMatrix,
    refresh: function (root) { scan(root); rebuildEnabled(); },
    disable: function () { enabledGlobally = false; schedule(); },
    enable: function () { enabledGlobally = true; schedule(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
