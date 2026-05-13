/**
 * Drop-in replacement for @novnc/novnc/lib/util/browser.js that avoids the
 * top-level `await` on line 179 (WebCodecs H.264 detection) which breaks
 * Rollup / esbuild bundling.  All other exports are kept identical.
 */
"use strict";

Object.defineProperty(exports, "__esModule", { value: true });

/* ---- touch / pointer ---------------------------------------------------- */
var isTouchDevice = exports.isTouchDevice =
  'ontouchstart' in document.documentElement ||
  document.ontouchstart !== undefined ||
  navigator.maxTouchPoints > 0 ||
  navigator.msMaxTouchPoints > 0;

window.addEventListener('touchstart', function onFirstTouch() {
  exports.isTouchDevice = isTouchDevice = true;
  window.removeEventListener('touchstart', onFirstTouch, false);
}, false);

var dragThreshold = exports.dragThreshold = 10 * (window.devicePixelRatio || 1);

/* ---- browser detection -------------------------------------------------- */
var ua = navigator.userAgent;
exports.isAndroid   = /android/i.test(ua);
exports.isBlink     = !!(window.chrome) && !!window.CSS;
exports.isChrome    = !!window.chrome && !/Edge|Edg\/|OPR\//.test(ua);
exports.isChromeOS  = /CrOS/.test(ua);
exports.isChromium  = !!(window.chrome);
exports.isEdge      = /Edg\//.test(ua);
exports.isFirefox   = /Firefox/.test(ua);
exports.isGecko     = /Gecko\//.test(ua);
exports.isIOS       = /iPad|iPhone|iPod/.test(ua);
exports.isMac       = /Mac/.test(navigator.platform);
exports.isOpera     = /OPR\//.test(ua);
exports.isSafari    = /^((?!chrome|android).)*safari/i.test(ua);
exports.isWebKit    = /WebKit\//.test(ua);
exports.isWindows   = /Win/.test(navigator.platform);

/* ---- cursor URI support -------------------------------------------------- */
var _supportsCursorURIs = false;
try {
  var target = document.createElement('canvas');
  target.style.cursor = 'url("data:image/x-icon;base64,AAACAAEAC") 2 2, default';
  _supportsCursorURIs = target.style.cursor.indexOf('url') === 0;
} catch (_e) { /* ignore */ }
exports.supportsCursorURIs = _supportsCursorURIs;

/* ---- scrollbar gutter ---------------------------------------------------- */
var _hasScrollbarGutter = true;
try {
  var container = document.createElement('div');
  container.style.visibility = 'hidden';
  container.style.overflow = 'scroll';
  document.body.appendChild(container);
  var child = document.createElement('div');
  container.appendChild(child);
  _hasScrollbarGutter = container.offsetWidth - child.offsetWidth !== 0;
  container.parentNode.removeChild(container);
} catch (_e) { /* ignore */ }
exports.hasScrollbarGutter = _hasScrollbarGutter;

/* ---- WebCodecs H.264 (async detection intentionally skipped) ------------ */
// Stub returns false; H.264 hardware decode is an optional optimisation and
// not required for correct VNC rendering.
exports.supportsWebCodecsH264Decode = false;
