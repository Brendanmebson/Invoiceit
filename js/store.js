/* JB Enterprise invoices: storage (Supabase), maths and the printed-invoice template.
   Needs js/config.js and supabase-js loaded first. */
(function () {
  var KEY = 'invoicedesk.invoices.v1';
  var SKEY = 'invoicedesk.settings.v1';
  var STORE_NAME = 'JB Enterprise';
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
  var db = window.supabase.createClient(window.JB_CONFIG.url, window.JB_CONFIG.key);
  var DEFAULTS = { addr: '', phone: '', salesBy: '' };
  var user = null;

  function fail(error) { throw new Error(error.message || 'Could not reach the server. Check the internet connection.'); }
  function toInv(row) { var inv = row.data || {}; inv.id = row.id; inv.no = row.no; return inv; }
  function toData(inv) {
    var d = JSON.parse(JSON.stringify(inv)); delete d.id; delete d.no;
    (d.payments || []).forEach(function (p) { delete p.auto; });
    return d;
  }

  /* Sign-in gate. Resolves once a JB Enterprise staff member is signed in. */
  function ready() {
    return db.auth.getSession().then(function (r) {
      user = r.data.session && r.data.session.user;
      if (!user) return gate('signin');
      return db.rpc('jb_is_staff').then(function (r2) {
        if (r2.error) return gate('signin', r2.error.message);
        if (!r2.data) return gate('denied');
        addSignOut();
        return user;
      });
    });
  }
  function gate(mode, msg) {
    var el = document.createElement('div');
    el.className = 'gate';
    document.body.appendChild(el);
    function draw(m, note) {
      if (m === 'denied') {
        el.innerHTML = '<div class="gate-card"><div class="gate-brand">' + esc(STORE_NAME) + '</div>' +
          '<h1>No access yet</h1><p>You are signed in as <b>' + esc(user.email) + '</b>, but this account is not on the ' + esc(STORE_NAME) +
          ' staff list. Ask the owner to add it, then reload.</p>' +
          '<button class="btn dark" id="gOut">Sign out</button></div>';
        el.querySelector('#gOut').onclick = function () { db.auth.signOut().then(function () { location.reload(); }); };
        return;
      }
      el.innerHTML = '<form class="gate-card" id="gForm"><div class="gate-brand">' + esc(STORE_NAME) + '</div>' +
        '<h1>Sign in</h1>' +
        '<label class="f">Email<input id="gEmail" type="email" autocomplete="email" required style="text-transform:none;letter-spacing:0"></label>' +
        '<label class="f">Password<input id="gPass" type="password" autocomplete="current-password" required></label>' +
        (note ? '<p class="gate-note">' + esc(note) + '</p>' : '') +
        '<button class="btn primary" type="submit" id="gGo">Sign in</button>' +
        '<p style="font-size:13px;color:var(--mute)">No account? Ask the owner to create one for you.</p></form>';
      el.querySelector('#gForm').onsubmit = function (e) {
        e.preventDefault();
        var go = el.querySelector('#gGo');
        go.disabled = true; go.textContent = 'Signing in…';
        db.auth.signInWithPassword({ email: el.querySelector('#gEmail').value.trim(), password: el.querySelector('#gPass').value }).then(function (r) {
          if (r.error) { draw('signin', r.error.message === 'Invalid login credentials' ? 'Wrong email or password.' : r.error.message); return; }
          location.reload();
        });
      };
    }
    draw(mode, msg);
    return new Promise(function () {}); // page waits until reload after sign-in
  }
  function addSignOut() {
    var right = document.querySelector('.topbar .right'); if (!right || document.getElementById('signOut')) return;
    var b = document.createElement('button');
    b.className = 'top-btn'; b.id = 'signOut'; b.type = 'button'; b.textContent = 'Sign out'; b.title = user.email;
    b.onclick = function () { db.auth.signOut().then(function () { location.href = 'index.html'; }); };
    right.insertBefore(b, right.firstChild);
  }

  /* Shop address and phone are shared by every device; "Sales by" is remembered per device. */
  function settings() {
    return db.from('jb_settings').select('data').eq('id', 1).maybeSingle().then(function (r) {
      if (r.error) fail(r.error);
      var d = {}, k, shared = (r.data && r.data.data) || {};
      for (k in DEFAULTS) d[k] = DEFAULTS[k];
      for (k in shared) d[k] = shared[k];
      try { var sb = localStorage.getItem(SKEY + '.salesBy'); if (sb) d.salesBy = sb; } catch (e) {}
      d.name = STORE_NAME;
      return d;
    });
  }
  function saveSettings(s) {
    try { localStorage.setItem(SKEY + '.salesBy', s.salesBy || ''); } catch (e) {}
    return db.from('jb_settings').update({ data: { addr: s.addr, phone: s.phone } }).eq('id', 1).then(function (r) { if (r.error) fail(r.error); });
  }

  function all() {
    return db.from('jb_invoices').select('id,no,data').order('no', { ascending: false }).then(function (r) {
      if (r.error) fail(r.error);
      return r.data.map(toInv);
    });
  }
  function get(id) {
    return db.from('jb_invoices').select('id,no,data').eq('id', id).maybeSingle().then(function (r) {
      if (r.error) fail(r.error);
      return r.data ? toInv(r.data) : null;
    });
  }
  /* The database gives the invoice its number, so two devices can never hand out the same one. */
  function add(inv) {
    return db.from('jb_invoices').insert({ data: toData(inv) }).select('id,no,data').single().then(function (r) {
      if (r.error) fail(r.error);
      return toInv(r.data);
    });
  }
  function update(inv) {
    return db.from('jb_invoices').update({ data: toData(inv) }).eq('id', inv.id).select('id,no,data').single().then(function (r) {
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
        inv.store = inv.store || {}; inv.store.name = STORE_NAME;
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
      '<div class="p-head"><span class="p-name">' + esc(STORE_NAME) + '</span><span class="p-addr">' + esc(inv.store.addr) +
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
    STORE_NAME: STORE_NAME,
    settings: settings, saveSettings: saveSettings,
    ready: ready, all: all, get: get, add: add, update: update, nextNo: nextNo,
    localInvoices: localInvoices, uploadLocal: uploadLocal, clearLocal: clearLocal,
    calc: calc, settle: settle, badge: badge, paper: paper
  };
})();
