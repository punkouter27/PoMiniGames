// Radzen moves an open popup (a dropdown's list) to <body> (Radzen.Blazor.js openPopup). The start, pause and end
// cards are modal <dialog>s in the browser's top layer, and a <body> child always paints under the top layer, so a
// dropdown on a card (GameIntro's map picker) opened its list behind the card. When the popup's anchor sits inside
// an open modal dialog, the popup is lifted into the top layer as a manual popover, at the same viewport position.
// Loaded as a classic script right after Radzen's own (index.html).
(function () {
  const R = window.Radzen;
  if (!R || typeof R.openPopup !== 'function' || !('showPopover' in HTMLElement.prototype)) return;
  const open = R.openPopup;
  const close = R.closePopup;

  R.openPopup = function (parent, id) {
    const result = open.apply(this, arguments);
    const popup = document.getElementById(id);
    if (popup && parent instanceof Element && parent.closest('dialog:modal')) {
      const at = popup.getBoundingClientRect();
      popup.setAttribute('popover', 'manual');
      try { popup.showPopover(); } catch { return result; }
      // The popover UA style centres it (inset: 0; margin: auto); pin it where Radzen placed it.
      Object.assign(popup.style, { position: 'fixed', inset: 'auto', margin: '0', top: `${at.top}px`, left: `${at.left}px` });
    }
    return result;
  };

  R.closePopup = function (id) {
    const popup = document.getElementById(id);
    if (popup && popup.hasAttribute('popover')) {
      try { popup.hidePopover(); } catch { /* already hidden */ }
      popup.removeAttribute('popover');
    }
    return close.apply(this, arguments);
  };
})();
