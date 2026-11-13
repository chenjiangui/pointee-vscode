// Pointee — the rail.
//
// One scrollbar for every surface the chrome scrolls: the edit panel's body,
// the long-text editor's textarea, the settings page and its payload box, and
// the rung list to come. Chosen in round four's scrollbar gallery
// (test/edit-scroll-prototypes.html, 03) over a rail with a gutter and a
// hairline at the edge: the native bar is switched off and a 3px rail is
// drawn inside the scroller's right padding, its thumb sized from
// clientHeight / scrollHeight, tinted with the accent, shown while scrolling
// and gone --pnt-rail-linger after the last event, with one flash on attach
// so the fact of overflow is announced before any gesture. It takes no
// width, so a column of chips never shifts when it appears, and it is
// unmistakably the panel's rather than the browser's. Chrome 121 or later:
// earlier Chrome does not know scrollbar-width and shows its own bar beside
// this one, which is the accepted floor.
//
// A classic script shared by the content script and the settings page, the
// way tokens.css and content.css are shared — listed before content.js in
// the manifest, linked from settings/index.html, and loaded by every harness
// that loads content.js. It draws its own two elements and writes only their
// geometry; it never touches the page, so the one-door rule test/edit-audit.mjs
// keeps on content.js is not in question.
//
// The rail also drives the scroll shadows. While there is content above the
// scroller's top edge the host wears `pnt-more-above`, while there is content
// below its bottom edge `pnt-more-below`, and content.css shades the pinned
// header and footer from those — the "there is more" cue the scrollbar round
// chose alongside the rail.

(function () {
  "use strict";

  // A thumb the maths would make shorter than this is still drawn at this,
  // so a very long scroller keeps a mark you can see.
  const MIN_THUMB = 18;
  // --pnt-rail-linger, if the token cannot be read.
  const LINGER_FALLBACK = 800;

  function linger() {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--pnt-rail-linger").trim();
    const n = parseFloat(raw);
    if (!isFinite(n)) return LINGER_FALLBACK;
    return /ms$/.test(raw) ? n : /s$/.test(raw) ? n * 1000 : n;
  }

  // `scroller` is the element whose scrollTop moves — document.scrollingElement
  // for the window. `host` is the positioned element the rail is drawn inside;
  // for the window it is ignored and the rail is fixed to the viewport.
  function attach(scroller, host) {
    const isWindow = scroller === document.scrollingElement ||
      scroller === document.documentElement;
    const shadowHost = isWindow ? document.documentElement : host;

    const rail = document.createElement("div");
    rail.className = "pnt-rail" + (isWindow ? " pnt-rail-fixed" : "");
    rail.setAttribute("aria-hidden", "true");
    const thumb = document.createElement("div");
    thumb.className = "pnt-rail-thumb";
    rail.appendChild(thumb);
    (isWindow ? document.body : host).appendChild(rail);
    scroller.classList.add("pnt-scroller");

    let timer = 0;

    function metrics() {
      if (isWindow) {
        return {
          top: 0,
          height: window.innerHeight,
          scrollTop: window.scrollY,
          client: window.innerHeight,
          total: document.scrollingElement.scrollHeight,
        };
      }
      const s = scroller.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      return {
        top: s.top - h.top + scroller.clientTop,
        height: scroller.clientHeight,
        scrollTop: scroller.scrollTop,
        client: scroller.clientHeight,
        total: scroller.scrollHeight,
      };
    }

    // Size and place the thumb, and set the shadow classes. Returns whether
    // there is anything to scroll at all: a scroller that fits draws no rail
    // and casts no shadow.
    function update() {
      const m = metrics();
      const overflow = m.total - m.client;
      if (overflow <= 1) {
        rail.classList.add("pnt-rail-empty");
        shadowHost.classList.remove("pnt-more-above", "pnt-more-below");
        return false;
      }
      rail.classList.remove("pnt-rail-empty");
      rail.style.top = m.top + "px";
      rail.style.height = m.height + "px";
      const thumbH = Math.max(MIN_THUMB, Math.round(m.height * m.client / m.total));
      const travel = Math.max(0, m.height - thumbH);
      const at = Math.min(1, Math.max(0, m.scrollTop / overflow));
      thumb.style.height = thumbH + "px";
      thumb.style.transform = `translateY(${Math.round(travel * at)}px)`;
      shadowHost.classList.toggle("pnt-more-above", m.scrollTop > 0);
      shadowHost.classList.toggle("pnt-more-below", m.scrollTop + m.client < m.total - 1);
      return true;
    }

    function show() {
      if (!update()) return;
      rail.classList.add("pnt-rail-on");
      clearTimeout(timer);
      timer = setTimeout(() => rail.classList.remove("pnt-rail-on"), linger());
    }

    const target = isWindow ? window : scroller;
    const onScroll = () => show();
    target.addEventListener("scroll", onScroll, { passive: true });

    // The content changes size without the scroller doing so — the panel
    // rebuilds its rows in place, a group opens — so the contents are watched
    // as well as the box.
    const watched = isWindow ? document.body : scroller;
    const ro = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => update())
      : null;
    if (ro) ro.observe(watched);
    const mo = new MutationObserver(() => update());
    mo.observe(watched, { childList: true, subtree: true, characterData: true });

    // The flash on attach: there is more, said before any gesture.
    show();

    return {
      update,
      detach() {
        clearTimeout(timer);
        target.removeEventListener("scroll", onScroll);
        if (ro) ro.disconnect();
        mo.disconnect();
        rail.remove();
        scroller.classList.remove("pnt-scroller");
        shadowHost.classList.remove("pnt-more-above", "pnt-more-below");
      },
    };
  }

  window.pntRail = { attach };
})();
