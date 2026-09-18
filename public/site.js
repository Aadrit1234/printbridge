/* ============================================================
   PrintBridge — marketing site behaviour
   hero canvas (floating paper sheets + ink dots),
   scroll reveals + count-ups, parallax, nav, mobile menu.
   Everything degrades to plain static content when JS is off.
   ============================================================ */
(function () {
  "use strict";

  var root = document.documentElement;
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  var nav = document.getElementById("site-nav");

  root.classList.add("js");

  /* ----------------------------------------------------------
     Where the control room lives
     ----------------------------------------------------------
     This site is often hosted somewhere other than the machine that runs the
     printer (Vercel, for instance), and the admin console only exists on that
     machine. config.js names it; the Admin button follows. */
  var CFG = window.PRINTBRIDGE_CONFIG || {};
  var ADMIN_BASE = String(CFG.adminBase || "").replace(/\/+$/, "");
  if (ADMIN_BASE) {
    var adminLinks = document.querySelectorAll('a[href^="/admin"]');
    for (var a = 0; a < adminLinks.length; a++) {
      adminLinks[a].setAttribute("href", ADMIN_BASE + adminLinks[a].getAttribute("href"));
      adminLinks[a].setAttribute("rel", "noopener");
    }
    // A static host has no /admin, and most of them answer with this page. Send
    // anyone who asked for the console to the machine that actually has it.
    if (/^\/admin(\/|$)/.test(location.pathname)) {
      location.replace(ADMIN_BASE + "/admin/");
    }
  }

  /* ----------------------------------------------------------
     Nav: shrink + hairline on scroll
     ---------------------------------------------------------- */
  var tickingNav = false;
  function onNavScroll() {
    if (nav) nav.classList.toggle("scrolled", window.scrollY > 8);
    tickingNav = false;
  }
  window.addEventListener("scroll", function () {
    if (!tickingNav) {
      tickingNav = true;
      window.requestAnimationFrame(onNavScroll);
    }
  }, { passive: true });
  onNavScroll();

  /* ----------------------------------------------------------
     Mobile nav
     ---------------------------------------------------------- */
  var toggle = document.getElementById("nav-toggle");
  var links = document.getElementById("site-links");
  if (toggle && links) {
    function setOpen(open) {
      links.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "Close menu" : "Menu");
    }
    toggle.addEventListener("click", function () {
      setOpen(links.classList.contains("open") ? false : true);
    });
    links.addEventListener("click", function (e) {
      if (e.target.tagName === "A") setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setOpen(false);
    });
  }

  /* ----------------------------------------------------------
     Light / dark theme
     ----------------------------------------------------------
     index.html's pre-paint script has already applied the choice; this only
     flips it. The key and its values are the whole product's, so a person who
     picks dark here gets a dark print site and a dark console too. */
  var themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("pb.theme", next); } catch (e) { /* private mode */ }
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", next === "dark" ? "#0a0f1b" : "#0e1524");
    });
  }

  /* ----------------------------------------------------------
     Shop pricing: yearly ⇄ lifetime
     ---------------------------------------------------------- */
  var billOpts = document.querySelectorAll(".bill-opt");
  if (billOpts.length) {
    var SHOP_PLANS = {
      year: { price: "\u20B9499", term: "per year" },
      life: { price: "\u20B95,999", term: "one-time \u00B7 lifetime" }
    };
    var shopPrice = document.getElementById("shop-price");
    var shopTerm = document.getElementById("shop-term");
    billOpts.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var plan = SHOP_PLANS[btn.getAttribute("data-period")] || SHOP_PLANS.year;
        billOpts.forEach(function (other) {
          var on = other === btn;
          other.classList.toggle("is-on", on);
          other.setAttribute("aria-pressed", on ? "true" : "false");
        });
        if (shopPrice) shopPrice.textContent = plan.price;
        if (shopTerm) shopTerm.textContent = plan.term;
      });
    });
  }

  /* ----------------------------------------------------------
     Scroll reveals (IntersectionObserver)
     ---------------------------------------------------------- */
  var reveals = document.querySelectorAll("[data-reveal]");

  function revealAll() {
    for (var i = 0; i < reveals.length; i++) reveals[i].classList.add("revealed");
  }

  /* Nothing may ever stay invisible.
     The reveal is CSS: `.js [data-reveal]` starts at opacity 0 and JS clears
     it, animating in over about a second. In a tab that barely paints —
     backgrounded, throttled, an embedded preview pane — the compositor
     advances far slower than the clock, so the content sits at zero and the
     page reads as blank. So look at what is on screen a beat after load: if it
     has not actually faded in, drop the animation and show everything. */
  window.setTimeout(function () {
    // Anything on screen that is still faint means the animation is not really
    // running. Off-screen elements are legitimately at zero, so ignore those.
    var stuck = false;
    for (var s = 0; s < reveals.length; s++) {
      var box = reveals[s].getBoundingClientRect();
      if (box.bottom < 0 || box.top > window.innerHeight) continue;
      if (parseFloat(window.getComputedStyle(reveals[s]).opacity) < 0.6) { stuck = true; break; }
    }
    if (!stuck) return; // animating normally — leave the scroll reveal alone

    for (var i = 0; i < reveals.length; i++) {
      reveals[i].classList.add("revealed");
      reveals[i].style.transition = "none";
      reveals[i].style.opacity = "1";
      reveals[i].style.transform = "none";
    }

    // The count-ups drive off rAF as well, so land them on their real values.
    var nums = document.querySelectorAll("[data-count]");
    for (var n = 0; n < nums.length; n++) {
      var target = parseFloat(nums[n].getAttribute("data-count"));
      if (!isFinite(target)) continue;
      var text = Math.round(target).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      if (nums[n].firstChild && nums[n].firstChild.nodeType === 3) nums[n].firstChild.nodeValue = text;
      else nums[n].textContent = text;
    }
  }, 1400);

  if (!("IntersectionObserver" in window) || reduce.matches) {
    revealAll();
  } else if (reveals.length) {
    var revealObserver = new IntersectionObserver(function (entries, obs) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          var delay = parseInt(entry.target.getAttribute("data-delay") || "0", 10);
          entry.target.style.transitionDelay = delay + "ms";
          entry.target.classList.add("revealed");
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    reveals.forEach(function (el) { revealObserver.observe(el); });
  }

  /* ----------------------------------------------------------
     Count-up numbers
     ---------------------------------------------------------- */
  var stats = document.querySelectorAll("[data-count]");
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function runCount(el) {
    var target = parseFloat(el.getAttribute("data-count"));
    var dur = 1500;
    var start = null;
    function fmt(v) {
      return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
    if (reduce.matches) { el.textContent = fmt(target); return; }
    function frame(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      el.textContent = fmt(target * easeOutCubic(p));
      if (p < 1) window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);
  }

  if (stats.length) {
    if ("IntersectionObserver" in window && !reduce.matches) {
      var statObserver = new IntersectionObserver(function (entries, obs) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) { runCount(entry.target); obs.unobserve(entry.target); }
        });
      }, { threshold: 0.6 });
      stats.forEach(function (el) { statObserver.observe(el); });
    } else {
      stats.forEach(runCount);
    }
  }

  /* ----------------------------------------------------------
     Hero canvas — floating paper sheets & ink dust
     ---------------------------------------------------------- */
  var canvas = document.getElementById("hero-canvas");
  if (canvas && !reduce.matches) {
    var ctx = canvas.getContext("2d");
    var W = 0, H = 0, DPR = 1;
    var sheets = [];
    var dots = [];
    var mouseX = 0, mouseY = 0;

    function rand(a, b) { return a + Math.random() * (b - a); }

    function resize() {
      var rect = canvas.parentNode.getBoundingClientRect();
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      W = rect.width; H = rect.height;
      canvas.width = W * DPR; canvas.height = H * DPR;
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      seed();
    }

    function seed() {
      sheets = [];
      dots = [];
      var count = Math.max(8, Math.min(26, Math.round(W / 55)));
      var dCount = Math.max(30, Math.round(W * H / 16000));
      for (var i = 0; i < count; i++) {
        sheets.push({
          x: rand(0, W), y: rand(0, H),
          w: rand(34, 104), h: rand(48, 138),
          rot: rand(-0.35, 0.35), vr: rand(-0.003, 0.003),
          vy: rand(0.12, 0.4), ox: rand(-18, 18), oy: rand(-10, 10),
          p: rand(0, Math.PI * 2), speed: rand(0.0005, 0.0012),
          a: rand(0.28, 0.55)
        });
      }
      for (var j = 0; j < dCount; j++) {
        dots.push({
          x: rand(0, W), y: rand(0, H),
          r: rand(0.7, 2.4), vy: rand(0.04, 0.16),
          tw: rand(0, Math.PI * 2), ts: rand(0.001, 0.003),
          a: rand(0.06, 0.3)
        });
      }
    }

    function drawSheet(s) {
      ctx.save();
      ctx.translate(s.x + mouseX * 0.02 * s.oy, s.y + mouseY * 0.02 * s.ox);
      ctx.rotate(s.rot);
      ctx.globalAlpha = s.a;
      var g = ctx.createLinearGradient(0, -s.h / 2, 0, s.h / 2);
      g.addColorStop(0, "rgba(246,242,234,0.10)");
      g.addColorStop(1, "rgba(246,242,234,0.03)");
      ctx.fillStyle = g;
      ctx.strokeStyle = "rgba(246,242,234,0.16)";
      ctx.lineWidth = 1;
      roundRect(-s.w / 2, -s.h / 2, s.w, s.h, 4);
      ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = "rgba(246,242,234,0.16)";
      ctx.lineWidth = 1;
      var lw = s.w * 0.68, lx = -lw / 2, ly = -s.h * 0.18;
      ctx.moveTo(lx, ly); ctx.lineTo(lx + lw, ly);
      ctx.moveTo(lx, ly + 9); ctx.lineTo(lx + lw, ly + 9);
      ctx.stroke();
      ctx.restore();
    }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function step(now) {
      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < sheets.length; i++) {
        var s = sheets[i];
        s.y -= s.vy;
        s.rot += s.vr;
        s.p += s.speed;
        s.x += Math.sin(s.p) * 0.2;
        if (s.y < -150) { s.y = H + 150; s.x = rand(0, W); }
        drawSheet(s);
      }
      for (var j = 0; j < dots.length; j++) {
        var d = dots[j];
        d.y -= d.vy;
        d.tw += d.ts;
        if (d.y < -8) { d.y = H + 8; d.x = rand(0, W); }
        ctx.beginPath();
        ctx.fillStyle = "rgba(224,164,76," + d.a * (0.6 + 0.4 * Math.sin(d.tw)) + ")";
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      }
      window.requestAnimationFrame(step);
    }

    window.addEventListener("resize", resize, { passive: true });
    window.addEventListener("mousemove", function (e) {
      mouseX = (e.clientX / W - 0.5) * 2;
      mouseY = (e.clientY / H - 0.5) * 2;
    }, { passive: true });

    resize();
    window.requestAnimationFrame(step);
  } else if (canvas) {
    /* static frame for reduced motion */
    var c2 = canvas.getContext("2d");
    var w2 = canvas.parentNode.getBoundingClientRect().width;
    var h2 = canvas.parentNode.getBoundingClientRect().height;
    canvas.width = w2; canvas.height = h2;
    c2.fillStyle = "rgba(246,242,234,0.05)";
    for (var k = 0; k < 14; k++) {
      var x = ((k * 83 + 37) % w2);
      var y = ((k * 61 + 19) % h2);
      c2.beginPath();
      c2.arc(x, y, 2, 0, Math.PI * 2);
      c2.fill();
    }
  }

  /* ----------------------------------------------------------
     Scroll parallax on decorative layers
     ---------------------------------------------------------- */
  var parallaxEls = document.querySelectorAll("[data-parallax]");
  if (parallaxEls.length && !reduce.matches) {
    var rafId = null;
    function parallax() {
      var vh = window.innerHeight;
      parallaxEls.forEach(function (el) {
        var rate = parseFloat(el.getAttribute("data-parallax")) || 0;
        var rect = el.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > vh) return;
        var mid = rect.top + rect.height / 2 - vh / 2;
        el.style.transform = "translate3d(0," + (mid * rate).toFixed(1) + "px,0)";
      });
      rafId = null;
    }
    window.addEventListener("scroll", function () {
      if (!rafId) rafId = window.requestAnimationFrame(parallax);
    }, { passive: true });
    parallax();
  }

  /* Keep hero sheets from stealing clicks */
  document.querySelectorAll(".hero-sheet").forEach(function (sh) {
    sh.style.pointerEvents = "none";
  });
})();