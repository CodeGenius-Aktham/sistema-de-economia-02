/* Aplica el tema guardado antes de pintar la página (evita parpadeo). */
(function () {
  var t = null;
  try {
    t = localStorage.getItem('theme');
  } catch (e) {}
  if (!t) t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
})();
