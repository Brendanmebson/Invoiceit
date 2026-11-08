/* Invoiceit: which region a visitor is in, from the browser's time zone (no IP lookup).
   ng Nigeria ₦ · us United States $ · uk United Kingdom £ · eu euro countries € · intl everywhere else $.
   A business's region is saved once at sign-up; after that the server's value is what counts.
   The prices here are for display only. The real ones live in the database (invoiceit_plan). */
(function () {
  var US = /^(America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Juneau|Sitka|Nome|Yakutat|Metlakatla|Adak|Boise|Detroit|Menominee|Indiana\/.+|Kentucky\/.+|North_Dakota\/.+)|Pacific\/Honolulu|US\/.+)$/;
  var UK = /^(Europe\/(London|Belfast|Jersey|Guernsey|Isle_of_Man)|GB|GB-Eire)$/;
  var EU = /^(Europe\/(Amsterdam|Andorra|Athens|Berlin|Bratislava|Brussels|Busingen|Dublin|Helsinki|Lisbon|Ljubljana|Luxembourg|Madrid|Malta|Monaco|Paris|Podgorica|Riga|Rome|San_Marino|Tallinn|Vatican|Vienna|Vilnius|Zagreb)|Atlantic\/(Azores|Canary|Madeira)|Africa\/Ceuta|Asia\/(Nicosia|Famagusta)|Eire)$/;

  var CURRENCY = { ng: 'NGN', us: 'USD', uk: 'GBP', eu: 'EUR', intl: 'USD' };
  var PLAN = { ng: { currency: 'NGN', amount: 2000000 }, other: { currency: 'USD', amount: 1500 } };
  var SYMS = { NGN: '₦', USD: '$', GBP: '£', EUR: '€' };

  /* allowOverride: the landing page at /ng, /us, /uk, /eu or /intl shows that region
     (the host rewrites those paths to index.html). ?region=us still works, for local previews. */
  function detect(allowOverride) {
    if (allowOverride) {
      var q = /\/(ng|us|uk|eu|intl)\/?$/i.exec(location.pathname) || /[?&]region=(ng|us|uk|eu|intl)\b/i.exec(location.search);
      if (q) return q[1].toLowerCase();
    }
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    if (!tz || tz === 'Africa/Lagos') return 'ng';
    if (US.test(tz)) return 'us';
    if (UK.test(tz)) return 'uk';
    if (EU.test(tz)) return 'eu';
    return 'intl';
  }
  function plan(region) { return region === 'ng' ? PLAN.ng : PLAN.other; }
  /* "₦20,000", "$15", "$180" for a plan ({ currency, amount } in the smallest unit) times months. */
  function priceText(p, months) {
    var n = p.amount * (months || 1) / 100;
    return (SYMS[p.currency] || '') + n.toLocaleString('en-US', { maximumFractionDigits: n % 1 ? 2 : 0, minimumFractionDigits: n % 1 ? 2 : 0 });
  }

  window.InvoiceitRegion = { detect: detect, currency: function (r) { return CURRENCY[r] || 'NGN'; }, plan: plan, priceText: priceText, SYMS: SYMS };
})();
