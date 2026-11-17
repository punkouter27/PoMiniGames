// Fallback clipboard helper used by AppErrorBoundary.
// navigator.clipboard requires a secure context (HTTPS or localhost);
// on http://192.168.x.x:5000 or other non-loopback HTTP origins, the modern
// API throws NotAllowedError. We degrade to a hidden <textarea> + execCommand
// so the "Copy diagnostic" button still works in those environments (e.g.
// LAN kiosk previews).
window.poCopyToClipboard = function (text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
  } catch (_) { /* fall through to legacy path */ }

  return new Promise(function (resolve, reject) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) resolve(); else reject(new Error('execCommand returned false'));
    } catch (e) {
      document.body.removeChild(ta);
      reject(e);
    }
  });
};
