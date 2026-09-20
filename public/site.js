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
     /owner stays on this site, and that is deliberate. It used to be
     redirected to the machine, back when the owner console only lived there —
     but the sale now ends on it: buy, get the code by email, register here,
     download the app. Sending a buyer to a machine that may be switched off
     would break the one flow that has to work, so the page ships in this bundle
     and talks to the backend named by apiBase (cross-site, with a cookie built
     for exactly that — see src/cookies.js).

     /admin is the opposite story: the control room is part of the desktop app
     and has no URL on any host. A bookmarked /admin is handed to the backend,
     whose page says where the console went. */
  var CFG = window.PRINTBRIDGE_CONFIG || {};
  var ADMIN_BASE = String(CFG.adminBase || "").replace(/\/+$/, "");
  if (ADMIN_BASE && /^\/admin(\/|$)/.test(location.pathname)) {
    location.replace(ADMIN_BASE + "/admin");
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
  var shopPeriod = "year";
  if (billOpts.length) {
    var SHOP_PLANS = {
      year: { price: "\u20B9499", term: "per year", buy: "Buy for my shop \u00B7 \u20B9499 a year", plan: "shop-yearly" },
      life: { price: "\u20B911,999", term: "one-time \u00B7 lifetime", buy: "Buy for my shop \u00B7 \u20B911,999 once", plan: "shop-lifetime" }
    };
    var shopPrice = document.getElementById("shop-price");
    var shopTerm = document.getElementById("shop-term");
    var buyPrice = document.querySelector("[data-buy-price]");
    billOpts.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var period = btn.getAttribute("data-period") || "year";
        var plan = SHOP_PLANS[period] || SHOP_PLANS.year;
        shopPeriod = period;
        billOpts.forEach(function (other) {
          var on = other === btn;
          other.classList.toggle("is-on", on);
          other.setAttribute("aria-pressed", on ? "true" : "false");
        });
        if (shopPrice) shopPrice.textContent = plan.price;
        if (shopTerm) shopTerm.textContent = plan.term;
        if (buyPrice) buyPrice.textContent = period === "life" ? "\u20B911,999 once" : "\u20B9499 a year";
      });
    });
  }

  /* ----------------------------------------------------------
     Checkout
     ----------------------------------------------------------
     Buy buttons open a dialog, the details are posted to the machine that
     takes the money, and the buyer is shown where to send it. Nothing is
     charged by this page and no card details are collected here: the order is
     recorded, the payment is made by UPI or transfer, and the access code goes
     out once the money lands.

     Prices and features are read from /api/owner/plans when the backend
     answers, so the site can never advertise a price the checkout disagrees
     with; the table below is the offline copy for exactly that moment when the
     machine is switched off. */
  var CHECKOUT = {
    "workspace-lifetime": { label: "Workspace", term: "lifetime", amount: "\u20B96,999", termText: "one-time \u00B7 lifetime", app: "PrintBridge Workspace", category: "workspace" },
    "shop-yearly": { label: "Shop", term: "yearly", amount: "\u20B9499", termText: "per year", app: "PrintBridge Shop", category: "shop" },
    "shop-lifetime": { label: "Shop", term: "lifetime", amount: "\u20B911,999", termText: "one-time \u00B7 lifetime", app: "PrintBridge Shop", category: "shop" }
  };

  var dialog = document.getElementById("checkout");
  var API = String(CFG.apiBase || "").replace(/\/+$/, "");

  if (dialog && typeof dialog.showModal === "function") {
    var plan = null;              // the plan id being bought
    var remote = null;            // /plans, when the backend answered
    var order = null;             // the order once it exists
    var msg = document.getElementById("co-msg");
    var pollTimer = null;

    function planSpec(id) {
      var local = CHECKOUT[id] || CHECKOUT["workspace-lifetime"];
      var found = remote && remote.filter(function (p) { return p.id === id; })[0];
      if (!found) return Object.assign({ id: id }, local);
      return {
        id: id,
        label: found.label,
        term: found.term,
        amount: "\u20B9" + Number(found.amount).toLocaleString("en-IN"),
        termText: found.term === "lifetime" ? "one-time \u00B7 lifetime" : "per year",
        app: found.appLabel || local.app,
        category: found.category,
        features: found.features
      };
    }

    function say(text, bad) {
      if (!msg) return;
      msg.hidden = !text;
      msg.textContent = text || "";
      msg.className = "co-note" + (bad ? " bad" : "");
    }

    function paintPlan(id) {
      plan = id;
      var spec = planSpec(id);
      var features = spec.features || [];
      document.getElementById("co-licence").textContent = spec.label + " \u00B7 " + spec.termText;
      document.getElementById("co-title").textContent = "Buy " + spec.label;
      document.getElementById("co-amount").textContent = spec.amount;
      document.getElementById("co-term").textContent = spec.termText;
      document.getElementById("co-app").textContent = "Arrives as " + spec.app + ".";
      document.getElementById("co-features").innerHTML = features.slice(0, 6).map(function (f) {
        return "<li>" + String(f).replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</li>";
      }).join("");
      document.getElementById("co-submit").textContent = "Place the order \u00B7 " + spec.amount;
      say("");
    }

    function openFor(id) {
      document.getElementById("co-form").hidden = false;
      document.getElementById("co-ordered").hidden = true;
      paintPlan(id);
      if (!dialog.open) dialog.showModal();
      /* Refresh the prices and features from the backend without blocking the
       * dialog: if the machine is off, the table above already painted. */
      fetch((API || "") + "/api/owner/plans", { headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (data && data.plans) { remote = data.plans; if (plan) paintPlan(plan); }
        })
        .catch(function () { /* offline: the prices printed here stand */ });
    }

    var buyButtons = document.querySelectorAll("[data-buy]");
    for (var b = 0; b < buyButtons.length; b++) {
      buyButtons[b].addEventListener("click", function () {
        var wanted = this.getAttribute("data-buy");
        if (wanted === "shop") wanted = shopPeriod === "life" ? "shop-lifetime" : "shop-yearly";
        openFor(wanted);
      });
    }

    var closer = document.getElementById("co-close");
    if (closer) closer.addEventListener("click", function () { dialog.close(); });
    var done = document.getElementById("co-done");
    if (done) done.addEventListener("click", function () { dialog.close(); });
    dialog.addEventListener("click", function (e) { if (e.target === dialog) dialog.close(); });

    function value(id) {
      var el = document.getElementById(id);
      return el && el.value ? el.value.trim() : "";
    }

    function method() {
      var picked = document.querySelector('input[name="method"]:checked');
      return picked ? picked.value : "upi";
    }

    /** Where to send the money, once an order exists. */
    function paintPayment(payment, spec) {
      var where = document.getElementById("co-pay-where");
      var hint = document.getElementById("co-pay-hint");
      var rows = [];
      if (spec.method === "bank" && payment.bank) {
        rows.push(["Bank", payment.bank]);
      } else if (payment.upi) {
        rows.push(["UPI id", payment.upi]);
        rows.push(["Payee", payment.payee || "PrintBridge"]);
      } else if (payment.bank) {
        rows.push(["Bank", payment.bank]);
      }
      if (payment.note) rows.push(["Note", payment.note]);
      if (!rows.length) {
        where.innerHTML = "<p class=\"co-payhint\">Payment details are sent with your order confirmation — reply to it with the order number if you need them again.</p>";
        if (hint) hint.hidden = true;
        return;
      }
      where.innerHTML = rows.map(function (r) {
        return '<div class="co-payrow"><span>' + r[0] + "</span><b>" + String(r[1]).replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</b></div>";
      }).join("");
      if (hint) hint.hidden = false;
    }

    function showOrder(res, spec) {
      order = res.order;
      var payment = res.payment || {};
      document.getElementById("co-form").hidden = true;
      document.getElementById("co-ordered").hidden = false;
      document.getElementById("co-number").textContent = order.number;
      document.getElementById("co-pay-amount").textContent = "\u20B9" + Number(order.amount).toLocaleString("en-IN");
      document.getElementById("co-pay-for").textContent = order.planLabel + " \u00B7 " + (order.term === "lifetime" ? "lifetime" : "a year");
      document.getElementById("co-pay-email").textContent = order.email;
      paintPayment(Object.assign({ method: spec.method }, payment), spec);
      say("");
      startWatching();
    }

    /* Two minutes of polling, then leave it: the buyer does not sit staring at
     * the tab, and nothing on this page is time-critical. */
    function startWatching() {
      if (pollTimer) clearInterval(pollTimer);
      var tries = 0;
      pollTimer = setInterval(function () {
        tries += 1;
        if (tries > 40) { clearInterval(pollTimer); pollTimer = null; return; }
        checkOrder();
      }, 3000);
      checkOrder();
    }

    function checkOrder() {
      if (!order) return;
      fetch((API || "") + "/api/owner/orders/" + encodeURIComponent(order.id), { headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data || !data.order) return;
          if (data.order.status === "paid") {
            var status = document.getElementById("co-status");
            status.className = "co-note ok";
            status.innerHTML = "Paid — your access code is <b>" + data.order.code + "</b>. " +
              'Take it to <a href="/owner">Log in</a> to create your account, then download your app.';
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            var refresh = document.getElementById("co-refresh");
            if (refresh) refresh.hidden = true;
          }
        })
        .catch(function () { /* the machine may be off; the buyer can retry */ });
    }

    var refresh = document.getElementById("co-refresh");
    if (refresh) refresh.addEventListener("click", function () {
      say("Checking…");
      checkOrder();
    });

    var form = document.getElementById("co-form");
    if (form) form.addEventListener("submit", function (e) {
      e.preventDefault();
      var spec = planSpec(plan);
      spec.method = method();
      var payload = {
        plan: plan,
        name: value("co-name"),
        email: value("co-email"),
        phone: value("co-phone"),
        method: spec.method,
        note: value("co-note"),
        source: "website",
        address: {
          line1: value("co-line1"),
          line2: value("co-line2"),
          city: value("co-city"),
          state: value("co-state"),
          pincode: value("co-pin"),
          country: value("co-country") || "India"
        }
      };
      if (!payload.name) return say("Enter the name the licence should be issued to.", true);
      if (!payload.email) return say("Enter the email address your access code should go to.", true);
      if (!payload.address.line1 || !payload.address.city || !payload.address.pincode) {
        return say("The billing address needs a street, a city and a PIN code.", true);
      }

      var button = document.getElementById("co-submit");
      button.disabled = true;
      button.textContent = "Placing the order…";
      say("");

      fetch((API || "") + "/api/owner/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
        .then(function (r) {
          return r.json().catch(function () { return null; }).then(function (data) {
            return { ok: r.ok, status: r.status, data: data };
          });
        })
        .then(function (res) {
          button.disabled = false;
          button.textContent = "Place the order \u00B7 " + spec.amount;
          if (!res.ok || !res.data || !res.data.order) {
            var why = (res.data && res.data.error) || "The order could not be recorded.";
            if (res.status === 429) why = res.data.error;
            return say(why, true);
          }
          showOrder(res.data, spec);
        })
        .catch(function () {
          button.disabled = false;
          button.textContent = "Place the order \u00B7 " + spec.amount;
          say("Could not reach the printer's machine — orders are taken by the shop's own server. Try again in a moment, or write to the address in Contact.", true);
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
      // No inline transform: `.revealed` already clears it in CSS, and an inline
      // "none" would also flatten anything that tilts (the hero ticket does).
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
    /* The unit rides in a <small> after the number ("25 MB"), so the count-up
       writes into the leading text node instead of clobbering the whole cell. */
    var lead = el.firstChild && el.firstChild.nodeType === 3 ? el.firstChild : null;
    function fmt(v) {
      return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }
    function paint(v) {
      if (lead) lead.nodeValue = fmt(v); else el.textContent = fmt(v);
    }
    if (reduce.matches) { paint(target); return; }
    function frame(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / dur, 1);
      paint(target * easeOutCubic(p));
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