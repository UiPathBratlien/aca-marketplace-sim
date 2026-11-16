// Minimal client behaviour. All elements have stable ids / data-testid for UiPath selectors.
(function () {
  // Reveal panels: <button data-reveal="#id">
  document.querySelectorAll('[data-reveal]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var t = document.querySelector(btn.getAttribute('data-reveal'));
      if (!t) return;
      t.classList.remove('hidden');
      btn.setAttribute('aria-expanded', 'true');
      var first = t.querySelector('select, input, textarea');
      if (first) first.focus();
    });
  });
  // In-page confirmation dialog: <button data-confirm="#dialog">
  document.querySelectorAll('[data-confirm]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var d = document.querySelector(btn.getAttribute('data-confirm'));
      if (!d) return;
      d.classList.remove('hidden');
      var ok = d.querySelector('button[type=submit]');
      if (ok) ok.focus();
    });
  });
  document.querySelectorAll('[data-close]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var d = document.querySelector(btn.getAttribute('data-close'));
      if (d) d.classList.add('hidden');
    });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') document.querySelectorAll('.modal:not(.hidden)').forEach(function (m) { m.classList.add('hidden'); });
  });
  // Clicking anywhere in a table row selects its radio button
  document.querySelectorAll('table.data tbody tr').forEach(function (tr) {
    var radio = tr.querySelector('input[type=radio]');
    if (!radio) return;
    tr.classList.add('selectable');
    tr.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') return;
      radio.checked = true;
      document.querySelectorAll('table.data tbody tr.selected').forEach(function (r) { r.classList.remove('selected'); });
      tr.classList.add('selected');
    });
  });
})();
