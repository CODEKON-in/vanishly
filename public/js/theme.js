/*
 * Light / dark theme for every page.
 * Loaded as a classic script in <head> so the saved theme is applied before
 * the first paint (no flash of the wrong theme). The toggle button is wired
 * up once the DOM exists.
 */
(function () {
  var KEY = 'vanishly.theme';
  var root = document.documentElement;
  var colours = { light: '#FFF6EA', dark: '#15101F' };

  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function system() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function apply(theme) {
    root.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', colours[theme]);
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      var next = theme === 'dark' ? 'light' : 'dark';
      btn.setAttribute('aria-label', 'Switch to ' + next + ' theme');
      btn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    }
  }

  apply(saved() || system());

  // Follow the phone's setting until the person picks one themselves.
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onSys = function () { if (!saved()) apply(system()); };
    if (mq.addEventListener) mq.addEventListener('change', onSys);
  }

  function reduceMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function toggle(btn) {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(KEY, next); } catch (e) { /* private mode */ }

    btn.classList.remove('flip');
    void btn.offsetWidth;           // restart the boing + sparkles
    btn.classList.add('flip');

    if (reduceMotion()) { apply(next); return; }

    // The fun part: the new theme grows out of the button as a circle.
    if (document.startViewTransition) {
      var r = btn.getBoundingClientRect();
      var x = r.left + r.width / 2;
      var y = r.top + r.height / 2;
      var radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      var vt = document.startViewTransition(function () { apply(next); });
      vt.ready.then(function () {
        root.animate(
          { clipPath: ['circle(0px at ' + x + 'px ' + y + 'px)', 'circle(' + radius + 'px at ' + x + 'px ' + y + 'px)'] },
          { duration: 750, easing: 'cubic-bezier(.65, 0, .35, 1)', pseudoElement: '::view-transition-new(root)' }
        );
      }).catch(function () {});
      return;
    }

    // Older browsers: a quick colour wash.
    root.classList.add('theme-fading');
    apply(next);
    setTimeout(function () { root.classList.remove('theme-fading'); }, 500);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    apply(root.getAttribute('data-theme') || 'light');   // sync the label
    btn.addEventListener('click', function () { toggle(btn); });
  });
})();
