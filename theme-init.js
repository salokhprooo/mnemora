// Apply the stored theme before first paint to avoid a flash.
(function () {
  try {
    var t = localStorage.getItem('mnemora.theme') || 'system';
    var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
