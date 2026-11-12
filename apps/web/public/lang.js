// Runs before the page is drawn: a first visit to an English page whose device asks for Turkish
// goes straight to the page's Turkish twin (data-tr). A language picked with the nav or footer
// link is remembered (kovan.lang, set in site.ts) and wins over the device.
(function () {
  try {
    var tag = document.currentScript;
    var tr = tag && tag.getAttribute('data-tr');
    if (!tr) return;
    var chosen = null;
    try {
      chosen = window.localStorage.getItem('kovan.lang');
    } catch {
      chosen = null;
    }
    if (chosen) return;
    var wanted =
      navigator.languages && navigator.languages.length
        ? navigator.languages
        : [navigator.language];
    for (var i = 0; i < wanted.length; i++) {
      var base = String(wanted[i]).toLowerCase().split(/[-_]/)[0];
      if (base === 'tr') {
        window.location.replace(tr + window.location.search + window.location.hash);
        return;
      }
      if (base === 'en') return;
    }
  } catch {
    // Never block the page over a language guess.
  }
})();
