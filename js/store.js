/* Invoiceit: storage (Supabase), maths and the printed-invoice template.
   Needs js/config.js and supabase-js loaded first. */
(function () {
  var KEY = 'invoicedesk.invoices.v1';
  var SKEY = 'invoicedesk.settings.v1';
  var SYMS = { NGN: '₦', USD: '$', GBP: '£', EUR: '€' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { var n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isNaN(n) ? 0 : n; }
  function plain(n) { return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function money(n, cur) { return (SYMS[cur] || '') + ' ' + plain(n); }
  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  function today(d) { d = d || new Date(); return pad(d.getDate(), 2) + '-' + pad(d.getMonth() + 1, 2) + '-' + d.getFullYear(); }
  function nowStr() {
    var d = new Date(), h = d.getHours(), ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return today(d) + ' ' + pad(h, 2) + ':' + pad(d.getMinutes(), 2) + ' ' + ap;
  }

  /* ---------- Supabase ---------- */
  var db = window.supabase.createClient(window.INVOICEIT_CONFIG.url, window.INVOICEIT_CONFIG.key);
  var user = null;

  function fail(error) { throw new Error(error.message || 'Could not reach the server. Check the internet connection.'); }
  function toInv(row) { var inv = row.data || {}; inv.id = row.id; inv.no = row.no; return inv; }
  function toData(inv) {
    var d = JSON.parse(JSON.stringify(inv)); delete d.id; delete d.no;
    (d.payments || []).forEach(function (p) { delete p.auto; });
    return d;
  }

  var me = null; // { role, business: { id, name, addr, phone } }
  var APP = 'Invoiceit';

  /* Sign-in gate. Resolves once the person is signed in and belongs to a business. */
  function ready() {
    return db.auth.getSession().then(function (r) {
      user = r.data.session && r.data.session.user;
      var ref = new URLSearchParams(location.search).get('reference');
      if (user && ref) return verifyPayment(ref).then(function () { history.replaceState(null, '', location.pathname); }, function () {}).then(function () { return r; });
      return r;
    }).then(function (r) {
      user = r.data.session && r.data.session.user;
      if (!user) return gate(location.hash === '#signup' ? 'signup' : 'signin');
      // Clean-up instead of a cron job: removes businesses past their deletion date (never this one if it's paid up).
      return db.rpc('invoiceit_purge_expired').then(function () {}, function () {}).then(function () { return db.rpc('invoiceit_me'); }).then(function (r2) {
        if (r2.error) return gate('signin', r2.error.message);
        if (r2.data) return enter(r2.data);
        // New account: finish setup with what they typed at sign-up, if anything.
        var md = user.user_metadata || {};
        if (!md.business_name && !md.join_code) return gate('setup');
        return db.rpc('invoiceit_setup', { p_business_name: md.business_name || null, p_join_code: md.join_code || null, p_region: md.region || region() }).then(function (r3) {
          if (r3.error || !r3.data) return gate('setup', r3.error && r3.error.message);
          return enter(r3.data);
        });
      });
    });
  }
  function enter(data) {
    me = data;
    if (me.billing && !me.billing.active) return locked();
    [].forEach.call(document.querySelectorAll('.topbar .brand'), function (b) {
      b.innerHTML = '<span class="biz">' + esc(me.business.name) + '</span><span class="by">on ' + APP + '</span>';
      b.title = me.business.name;
    });
    addSignOut();
    if (!isOwner()) { [].forEach.call(document.querySelectorAll('.topbar nav a[href="business.html"], .topbar nav a[href="dashboard.html"]'), function (a) { a.remove(); }); }
    appMenu();
    trialBanner();
    askForDetails();
    return me;
  }

  /* ---------- Billing: 14-day trial, then a monthly price set by the business's region, via Paystack ---------- */
  function region() { return window.InvoiceitRegion.detect(false); }
  /* The business's plan from the server ({ currency, amount } in kobo/cents). */
  function plan() {
    var b = billing();
    return (b && b.price) || window.InvoiceitRegion.plan((me && me.business && me.business.region) || 'ng');
  }
  function priceText(months) { return window.InvoiceitRegion.priceText(plan(), months); }
  /* <option>s for the "Pay for" dropdown: 1, 3, 6 and 12 months. */
  function monthOptions() {
    return [1, 3, 6, 12].map(function (n) { return '<option value="' + n + '">' + n + ' month' + (n > 1 ? 's' : '') + ' · ' + priceText(n) + '</option>'; }).join('');
  }
  /* Default currency for this business's invoices and totals. */
  function currency() { return (me && me.business && me.business.currency) || 'NGN'; }
  function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function daysLeft(iso) { return Math.max(0, Math.ceil((new Date(iso) - Date.now()) / 86400000)); }
  function billing() { return (me && me.billing) || null; }
  function callBilling(body) {
    return db.functions.invoke('invoiceit-billing', { body: body }).then(function (r) {
      if (r.error) {
        return (r.error.context && r.error.context.json ? r.error.context.json() : Promise.resolve({})).then(function (j) {
          throw new Error(j.error || 'Payment service is not available yet. Please try again later.');
        }, function () { throw new Error('Payment service is not available yet. Please try again later.'); });
      }
      if (r.data && r.data.error) throw new Error(r.data.error);
      return r.data;
    });
  }
  /* Sends the owner to Paystack; Paystack brings them back to this page with ?reference=... */
  function pay(months) {
    var back = location.origin + location.pathname;
    return callBilling({ action: 'init', months: months || 1, callback_url: back }).then(function (d) { location.href = d.authorization_url; });
  }
  function verifyPayment(ref) { return callBilling({ action: 'verify', reference: ref }); }

  function trialBanner() {
    var b = billing(); if (!b || b.free_forever || !isOwner()) return;
    var days = daysLeft(b.access_until);
    if (!b.on_trial && days > 5) return;
    var el = document.createElement('div');
    el.className = 'trial-bar';
    el.innerHTML = '<span>' + (b.on_trial ? 'Free trial: <b>' + days + ' day' + (days === 1 ? '' : 's') + ' left</b> (ends ' + fmtDate(b.access_until) + ').'
      : 'Your subscription ends in <b>' + days + ' day' + (days === 1 ? '' : 's') + '</b>.') + ' ' + priceText(1) + ' a month after that.</span>' +
      '<button type="button" class="btn" id="trialPay">Pay now</button>';
    document.body.insertBefore(el, document.body.firstChild);
    el.querySelector('#trialPay').onclick = function () { this.disabled = true; this.textContent = 'Opening Paystack…'; var t = this; pay(1).catch(function (e) { t.disabled = false; t.textContent = 'Pay now'; alert(e.message); }); };
  }

  function locked() {
    var b = billing(), owner = isOwner(), trial = !b.paid_until;
    var el = document.createElement('div');
    el.className = 'gate';
    document.body.appendChild(el);
    el.innerHTML = '<div class="gate-card"><a class="gate-brand" href="index.html"><img src="favicon.svg" alt="" width="28" height="28">' + APP + '</a>' +
      '<h1>' + (trial ? 'Your free trial has ended' : 'Your subscription has ended') + '</h1>' +
      '<p><b>' + esc(me.business.name) + '</b> no longer has access to its invoices. ' +
      (owner ? 'Subscribe for <b>' + priceText(1) + ' a month</b> to pick up where you left off.' : 'Ask your business owner to renew the subscription.') + '</p>' +
      '<p class="gate-note">If it stays unpaid, all of this business\'s invoices and team will be permanently deleted on <b>' + fmtDate(b.delete_at) + '</b>.</p>' +
      (owner ? '<label class="f">Pay for<select id="lkMonths">' + monthOptions() + '</select></label>' +
        '<button class="btn primary" type="button" id="lkPay">Pay with Paystack</button>' : '') +
      '<button class="btn ghost" type="button" id="lkOut">Sign out</button></div>';
    if (owner) el.querySelector('#lkPay').onclick = function () {
      var btn = this; btn.disabled = true; btn.textContent = 'Opening Paystack…';
      pay(+el.querySelector('#lkMonths').value).catch(function (e) { btn.disabled = false; btn.textContent = 'Pay with Paystack'; alert(e.message); });
    };
    el.querySelector('#lkOut').onclick = function () { db.auth.signOut().then(function () { location.href = 'index.html'; }); };
    return new Promise(function () {});
  }

  /* First sign-in as owner: ask for the details that go on every invoice. */
  function askForDetails() {
    var b = business();
    if (!isOwner() || (b.addr && b.phone)) return;
    try { if (sessionStorage.getItem('invoiceit.skipDetails') === b.id) return; } catch (e) {}
    var el = document.createElement('div');
    el.className = 'gate modal';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'dtTitle');
    el.innerHTML = '<form class="gate-card" id="dtForm"><a class="gate-brand" href="index.html"><img src="favicon.svg" alt="" width="28" height="28">' + APP + '</a>' +
      '<h1 id="dtTitle">Your business details</h1><p>These print at the top of every invoice. Fill them in once and your team never has to type them.</p>' +
      '<label class="f">Business name<input id="dtName" maxlength="80" required value="' + esc(b.name) + '"></label>' +
      '<label class="f">Shop address<input id="dtAddr" placeholder="Shop no., plaza, street, area, city" value="' + esc(b.addr) + '"></label>' +
      '<label class="f">Phone numbers<input id="dtPhone" class="mono" placeholder="0800 000 0000" value="' + esc(b.phone) + '"></label>' +
      '<p class="gate-note" id="dtNote" hidden></p>' +
      '<button class="btn primary" type="submit" id="dtSave">Save details</button>' +
      '<button class="btn ghost" type="button" id="dtLater">Later</button></form>';
    document.body.appendChild(el);
    el.querySelector('#dtAddr').focus();
    el.querySelector('#dtLater').onclick = function () { try { sessionStorage.setItem('invoiceit.skipDetails', b.id); } catch (e) {} el.remove(); };
    el.querySelector('#dtForm').onsubmit = function (e) {
      e.preventDefault();
      var name = el.querySelector('#dtName').value.trim(), note = el.querySelector('#dtNote'), btn = el.querySelector('#dtSave');
      if (!name) { note.hidden = false; note.textContent = 'Enter the business name.'; return; }
      btn.disabled = true; btn.textContent = 'Saving…';
      updateBusiness({ name: name, addr: el.querySelector('#dtAddr').value.trim(), phone: el.querySelector('#dtPhone').value.trim() }).then(function (biz) {
        [].forEach.call(document.querySelectorAll('.topbar .brand .biz'), function (x) { x.textContent = biz.name; });
        el.remove();
        document.dispatchEvent(new CustomEvent('invoiceit:business', { detail: biz }));
      }).catch(function (err) { btn.disabled = false; btn.textContent = 'Save details'; note.hidden = false; note.textContent = err.message; });
    };
  }
  function gate(mode, msg) {
    var el = document.createElement('div');
    el.className = 'gate';
    document.body.appendChild(el);
    var logo = '<a class="gate-brand" href="index.html"><img src="favicon.svg" alt="" width="28" height="28">' + APP + '</a>';
    function field(id, label, type, extra) {
      return '<label class="f">' + label + '<input id="' + id + '" type="' + type + '" ' + (extra || '') + ' style="text-transform:none;letter-spacing:0"></label>';
    }
    function draw(m, note) {
      var html;
      if (m === 'setup') {
        html = '<h1>Set up your business</h1><p>Signed in as <b>' + esc(user.email) + '</b>. Name your business, or enter a join code if your business already uses ' + APP + '.</p>' +
          field('gBiz', 'Business name', 'text', 'maxlength="80" placeholder="e.g. Adebayo Ventures" autocomplete="organization"') +
          '<div class="gate-or"><span>or</span></div>' +
          field('gCode', 'Join code from your owner', 'text', 'maxlength="12" placeholder="e.g. 7F3K9Q2A" autocapitalize="characters"') +
          (note ? '<p class="gate-note">' + esc(note) + '</p>' : '') +
          '<button class="btn primary" type="submit" id="gGo">Continue</button>' +
          '<button class="btn ghost" type="button" id="gOut">Sign out</button>';
      } else if (m === 'signup') {
        html = '<h1>Create your account</h1>' +
          field('gEmail', 'Email', 'email', 'autocomplete="email" required') +
          field('gPass', 'Password', 'password', 'minlength="8" autocomplete="new-password" required placeholder="At least 8 characters"') +
          '<div id="gBizWrap">' + field('gBiz', 'Business name', 'text', 'maxlength="80" placeholder="e.g. Adebayo Ventures" autocomplete="organization"') + '</div>' +
          '<div id="gCodeWrap" hidden>' + field('gCode', 'Join code from your owner', 'text', 'maxlength="12" placeholder="e.g. 7F3K9Q2A" autocapitalize="characters"') + '</div>' +
          '<button class="linkish" type="button" id="gJoin">Joining a business that already uses ' + APP + '? Use a join code</button>' +
          (note ? '<p class="gate-note">' + esc(note) + '</p>' : '') +
          '<button class="btn primary" type="submit" id="gGo">Create account</button>' +
          '<p class="gate-swap">Already have an account? <button class="linkish" type="button" id="gSwap">Sign in</button></p>';
      } else {
        html = '<h1>Sign in</h1>' +
          field('gEmail', 'Email', 'email', 'autocomplete="email" required') +
          field('gPass', 'Password', 'password', 'autocomplete="current-password" required') +
          (note ? '<p class="gate-note">' + esc(note) + '</p>' : '') +
          '<button class="btn primary" type="submit" id="gGo">Sign in</button>' +
          '<p class="gate-swap">New to ' + APP + '? <button class="linkish" type="button" id="gSwap">Create an account</button></p>';
      }
      el.innerHTML = '<form class="gate-card" id="gForm" novalidate>' + logo + html + '</form>';
      var $ = function (id) { return el.querySelector('#' + id); };
      if ($('gSwap')) $('gSwap').onclick = function () { history.replaceState(null, '', m === 'signup' ? '#' : '#signup'); draw(m === 'signup' ? 'signin' : 'signup'); };
      if ($('gOut')) $('gOut').onclick = function () { db.auth.signOut().then(function () { location.href = 'index.html'; }); };
      if ($('gJoin')) $('gJoin').onclick = function () {
        var joining = $('gCodeWrap').hidden;
        $('gCodeWrap').hidden = !joining; $('gBizWrap').hidden = joining;
        this.textContent = joining ? 'Starting a new business instead? Enter its name' : 'Joining a business that already uses ' + APP + '? Use a join code';
        (joining ? $('gCode') : $('gBiz')).focus();
      };
      var first = el.querySelector('input'); if (first) first.focus();
      $('gForm').onsubmit = function (e) {
        e.preventDefault();
        var go = $('gGo'), val = function (id) { return $(id) && !$(id).closest('[hidden]') ? $(id).value.trim() : ''; };
        var biz = val('gBiz'), code = val('gCode').toUpperCase();
        if (m !== 'signin' && !biz && !code) { draw(m, 'Enter your business name, or a join code.'); return; }
        if (m !== 'setup') {
          var email = val('gEmail'), pass = $('gPass').value;
          if (!email || !pass) { draw(m, 'Enter your email and password.'); return; }
          if (m === 'signup' && pass.length < 8) { draw(m, 'Use a password of at least 8 characters.'); return; }
        }
        go.disabled = true; go.textContent = 'Please wait…';
        var call;
        if (m === 'setup') call = db.rpc('invoiceit_setup', { p_business_name: biz || null, p_join_code: code || null, p_region: region() });
        else if (m === 'signup') call = db.auth.signUp({ email: email, password: pass, options: { data: { business_name: biz || null, join_code: code || null, region: region() } } });
        else call = db.auth.signInWithPassword({ email: email, password: pass });
        call.then(function (r) {
          if (r.error) {
            var msg = r.error.message;
            if (msg === 'Invalid login credentials') msg = 'Wrong email or password.';
            if (/already registered/i.test(msg)) msg = 'That email already has an account. Sign in instead.';
            draw(m, msg); return;
          }
          if (m === 'signup' && !r.data.session) { draw('signin', 'Account created. Open the confirmation email, then sign in.'); return; }
          if (m === 'signup') {
            // Signed in straight away: create or join the business now.
            return db.rpc('invoiceit_setup', { p_business_name: biz || null, p_join_code: code || null, p_region: region() }).then(function (r2) {
              if (r2.error) { user = r.data.user; draw('setup', r2.error.message); return; }
              location.hash = ''; location.reload();
            });
          }
          location.hash = ''; location.reload();
        });
      };
    }
    draw(mode, msg);
    return new Promise(function () {}); // page waits until reload after sign-in
  }
  /* Phones: page links and Sign out live behind a hamburger; the top bar keeps the name, + and ☰. */
  function appMenu() {
    var top = document.querySelector('.topbar'), right = top && top.querySelector('.right');
    if (!right || document.getElementById('appMenu')) return;
    document.body.classList.add('has-menu');
    var btn = document.createElement('button');
    btn.className = 'menu-btn'; btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', 'appMenu'); btn.setAttribute('aria-label', 'Open menu');
    btn.innerHTML = '<span></span><span></span><span></span>';
    right.appendChild(btn);
    var panel = document.createElement('div');
    panel.className = 'app-menu'; panel.id = 'appMenu'; panel.hidden = true;
    panel.innerHTML = [].map.call(top.querySelectorAll('nav a'), function (a) {
      return '<a href="' + a.getAttribute('href') + '"' + (a.classList.contains('on') ? ' class="on" aria-current="page"' : '') + '>' + esc(a.textContent) + '</a>';
    }).join('') + '<div class="who">Signed in as <b>' + esc(user.email) + '</b>' + (isOwner() ? ' · Owner' : ' · Staff') + '</div>' +
      '<button type="button" class="menu-out">Sign out</button>';
    top.parentNode.insertBefore(panel, top.nextSibling);
    function set(open) {
      panel.hidden = !open; top.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }
    btn.onclick = function () { set(panel.hidden); };
    panel.querySelector('.menu-out').onclick = function () { db.auth.signOut().then(function () { location.href = 'index.html'; }); };
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) { set(false); btn.focus(); } });
    window.matchMedia('(min-width:761px)').addEventListener('change', function (m) { if (m.matches) set(false); });
  }

  function addSignOut() {
    var right = document.querySelector('.topbar .right'); if (!right || document.getElementById('signOut')) return;
    var b = document.createElement('button');
    b.className = 'top-btn'; b.id = 'signOut'; b.type = 'button'; b.textContent = 'Sign out'; b.title = user.email;
    b.onclick = function () { db.auth.signOut().then(function () { location.href = 'index.html'; }); };
    right.insertBefore(b, right.firstChild);
  }

  function business() { return me && me.business; }
  function isOwner() { return !!me && me.role === 'owner'; }

  /* Shop address and phone belong to the business; "Sales by" is remembered per device. */
  function settings() {
    var b = business() || {}, d = { name: b.name || '', addr: b.addr || '', phone: b.phone || '', salesBy: '' };
    try { var sb = localStorage.getItem(SKEY + '.salesBy'); if (sb) d.salesBy = sb; } catch (e) {}
    return Promise.resolve(d);
  }
  function saveSettings(s) {
    try { localStorage.setItem(SKEY + '.salesBy', s.salesBy || ''); } catch (e) {}
    return Promise.resolve();
  }
  function updateBusiness(fields) {
    return db.from('invoiceit_businesses').update(fields).eq('id', business().id).select('id,name,addr,phone').single().then(function (r) {
      if (r.error) fail(r.error);
      me.business = r.data; return r.data;
    });
  }
  function team() {
    return Promise.all([
      db.from('invoiceit_members').select('user_id,email,role,created_at').order('created_at'),
      isOwner() ? db.from('invoiceit_join_codes').select('code,role,expires_at').gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }) : Promise.resolve({ data: [] })
    ]).then(function (r) {
      if (r[0].error) fail(r[0].error); if (r[1].error) fail(r[1].error);
      return { members: r[0].data, codes: r[1].data, myId: user.id };
    });
  }
  function newJoinCode(role) { return db.rpc('invoiceit_new_join_code', { p_role: role || 'staff' }).then(function (r) { if (r.error) fail(r.error); return r.data; }); }
  function deleteJoinCode(code) { return db.from('invoiceit_join_codes').delete().eq('code', code).then(function (r) { if (r.error) fail(r.error); }); }
  function removeMember(uid) { return db.from('invoiceit_members').delete().eq('user_id', uid).then(function (r) { if (r.error) fail(r.error); }); }

  function all() {
    return db.from('invoiceit_invoices').select('id,no,data').order('no', { ascending: false }).then(function (r) {
      if (r.error) fail(r.error);
      return r.data.map(toInv);
    });
  }
  function get(id) {
    return db.from('invoiceit_invoices').select('id,no,data').eq('id', id).maybeSingle().then(function (r) {
      if (r.error) fail(r.error);
      return r.data ? toInv(r.data) : null;
    });
  }
  /* The database gives the invoice its number, so two devices can never hand out the same one. */
  function add(inv) {
    var d = toData(inv); if (!d.createdBy) d.createdBy = user && user.email;
    return db.from('invoiceit_invoices').insert({ data: d }).select('id,no,data').single().then(function (r) {
      if (r.error) fail(r.error);
      return toInv(r.data);
    });
  }
  function update(inv) {
    return db.from('invoiceit_invoices').update({ data: toData(inv) }).eq('id', inv.id).select('id,no,data').single().then(function (r) {
      if (r.error) fail(r.error);
      return toInv(r.data);
    });
  }
  /* Best guess for the preview; the real number is assigned on save. */
  function nextNo() {
    return all().then(function (l) {
      var max = 0;
      l.forEach(function (i) { var n = parseInt(String(i.no).replace(/\D/g, ''), 10); if (!isNaN(n) && n > max) max = n; });
      return pad(max + 1, 5);
    });
  }

  /* Invoices saved in this browser before the app went online. */
  function localInvoices() {
    try {
      var l = JSON.parse(localStorage.getItem(KEY) || '[]');
      return l.filter(function (i) { return String(i.id).indexOf('seed-') !== 0; });
    } catch (e) { return []; }
  }
  function clearLocal() { try { localStorage.removeItem(KEY); } catch (e) {} }
  function uploadLocal() {
    var list = localInvoices().slice().reverse(); // oldest first, so new numbers keep the same order
    var done = 0;
    return list.reduce(function (p, inv) {
      return p.then(function () {
        inv.store = inv.store || {}; inv.store.name = business().name;
        inv.notes = String(inv.notes || '') + (inv.no ? (inv.notes ? '\n' : '') + '(Earlier device no. ' + inv.no + ')' : '');
        return add(inv).then(function () { done++; });
      });
    }, Promise.resolve()).then(function () {
      try { localStorage.setItem(KEY + '.uploaded', localStorage.getItem(KEY) || '[]'); localStorage.removeItem(KEY); } catch (e) {}
      return done;
    });
  }

  /* A blank quantity counts as 1 (the placeholder shows 1). */
  function qty(i) { return String(i.qty == null ? '' : i.qty).trim() === '' ? 1 : num(i.qty); }
  var METHODS = ['Cash', 'Bank Transfer', 'POS'];
  /* Payment method dropdown. attrs is the rest of the tag (id or data-*). */
  function methodSelect(attrs, value) {
    var opts = METHODS.slice();
    if (value && opts.indexOf(value) < 0) opts.push(value); // keep older invoices' methods
    return '<select ' + attrs + '><option value=""' + (value ? '' : ' selected') + ' disabled>Choose…</option>' +
      opts.map(function (o) { return '<option' + (o === value ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function calc(inv) {
    var sub = inv.items.reduce(function (a, i) { return a + qty(i) * num(i.price); }, 0);
    var disc = Math.min(num(inv.discount), sub);
    var del = num(inv.delivery);
    var tax = (sub - disc) * num(inv.tax) / 100;
    var total = sub - disc + del + tax;
    var paid = inv.payments.reduce(function (a, p) { return a + num(p.amount); }, 0);
    total = round2(total); paid = round2(paid);
    var balance = Math.max(round2(total - paid), 0);   // still to pay
    var change = Math.max(round2(paid - total), 0);    // paid too much, give back
    var status = balance === 0 && total > 0 ? 'PAID' : (paid <= 0 ? 'UNPAID' : 'PART-PAID');
    return { sub: sub, disc: disc, del: del, tax: tax, total: total, paid: paid, balance: balance, change: change, status: status };
  }
  function badge(status) {
    var cls = status === 'PAID' ? '' : (status === 'UNPAID' ? ' unpaid' : ' part');
    return '<span class="badge' + cls + '">' + status + '</span>';
  }

  /* The printed invoice, laid out like the store's real receipts. */
  function paper(inv) {
    var c = calc(inv), cur = inv.currency, m = function (n) { return money(n, cur); };
    var rows = inv.items.map(function (i) {
      var line = qty(i) * num(i.price);
      return '<div class="p-grid p-tr"><div><div class="pn">' + esc(i.desc) + '</div>' +
        (String(i.serial || '').trim() ? '<div class="sn">' + esc(i.serial) + '</div>' : '') + '</div>' +
        '<span>' + plain(qty(i)) + ' Pc(s)</span><span>' + plain(num(i.price)) + '</span><span>' + plain(line) + '</span></div>';
    }).join('');
    var pays = inv.payments.map(function (p) {
      return '<div class="p-pay"><span>' + esc(p.method) + '</span><span>' + m(num(p.amount)) + '</span><span>' + esc(p.date) + '</span></div>';
    }).join('');
    var sum = '<div class="p-sum"><b>Subtotal:</b><span>' + m(c.sub) + '</span></div>';
    if (c.disc > 0) sum += '<div class="p-sum"><b>Discount:</b><span>-' + m(c.disc) + '</span></div>';
    if (c.del > 0) sum += '<div class="p-sum"><b>Delivery:</b><span>' + m(c.del) + '</span></div>';
    if (num(inv.tax) > 0) sum += '<div class="p-sum"><b>VAT (' + esc(inv.tax) + '%):</b><span>' + m(c.tax) + '</span></div>';
    sum += '<div class="p-sum"><b>Total:</b><span>' + m(c.total) + '</span></div>';
    return '<article class="paper"><div class="in-pad">' +
      '<div class="p-head"><span class="p-name">' + esc(inv.store && inv.store.name) + '</span><span class="p-addr">' + esc(inv.store.addr) +
      '</span><span class="p-mob"><b>Mobile:</b> ' + esc(inv.store.phone) + '</span></div>' +
      '<div class="p-title">Invoice</div>' +
      '<div class="p-meta"><div class="col"><span><b>Invoice No.</b> ' + esc(inv.no) + '</span><b>Customer</b><span style="text-transform:uppercase;overflow-wrap:anywhere">' +
      esc(inv.cust) + '</span><span><b>Mobile</b>: ' + esc(inv.phone) + '</span></div><span><b>Date</b> ' + esc(inv.date) + '</span></div>' +
      '<div style="font-size:12px;text-transform:uppercase"><b>Sales by</b> ' + esc(inv.salesBy) + '</div>' +
      '<div><div class="p-grid p-th"><span>Product</span><span>Quantity</span><span>Unit Price</span><span>Subtotal</span></div>' + rows + '</div>' +
      '<div class="p-rule"></div>' +
      '<div class="p-bottom"><div>' + pays + '<div class="p-pay two"><b>Total Paid</b><span>' + m(c.paid) + '</span></div>' +
      (c.balance > 0 ? '<div class="p-pay two"><b>Balance to pay</b><span>' + m(c.balance) + '</span></div>' : '') +
      (c.change > 0 ? '<div class="p-pay two"><b>Overpaid</b><span>' + m(c.change) + '</span></div>' : '') + '</div><div>' + sum + '</div></div>' +
      (String(inv.notes || '').trim() ? '<div class="p-notes">' + esc(inv.notes) + '</div>' : '') +
      '</div></article>';
  }

  /* Plain-language check of items total against payments. */
  function settle(c, cur) {
    if (c.total <= 0) return { kind: 'none', text: 'Add items to see the total.' };
    if (c.balance > 0) return { kind: 'owed', text: (c.paid > 0 ? 'Part paid. ' : 'Nothing paid yet. ') + money(c.balance, cur) + ' left to pay.' };
    if (c.change > 0) return { kind: 'over', text: 'Payments are ' + money(c.change, cur) + ' more than the total. Overpaying is not allowed, so reduce a payment.' };
    return { kind: 'ok', text: 'Fully paid. Payments match the items total.' };
  }

  window.Store = {
    esc: esc, num: num, qty: qty, methodSelect: methodSelect, plain: plain, money: money, today: today, nowStr: nowStr, SYMS: SYMS,
    business: business, isOwner: isOwner, billing: billing, pay: pay, priceText: priceText, monthOptions: monthOptions, currency: currency, fmtDate: fmtDate, daysLeft: daysLeft, updateBusiness: updateBusiness, team: team, newJoinCode: newJoinCode, deleteJoinCode: deleteJoinCode, removeMember: removeMember,
    settings: settings, saveSettings: saveSettings,
    ready: ready, all: all, get: get, add: add, update: update, nextNo: nextNo,
    localInvoices: localInvoices, uploadLocal: uploadLocal, clearLocal: clearLocal,
    calc: calc, settle: settle, badge: badge, paper: paper
  };
})();
