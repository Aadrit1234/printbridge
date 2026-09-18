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
     Scroll reveals (IntersectionObserver)
     ---------------------------------------------------------- */
  var reveals = document.querySelectorAll("[data-reveal]");
  if (!("IntersectionObserver" in window) || reduce.matches) {
    for (var r = 0; r < reveals.length; r++) reveals[r].classList.add("revealed");
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