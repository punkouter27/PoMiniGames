// Hands a string to the browser as a file the user saves.
//
// Used by the profile page's "Download my data" action. The payload is built server-side and
// arrives as a string, so there is nothing to serialise here — this module exists only because
// there is no way to trigger a save from C# without touching the DOM.
//
// The object URL is revoked on the next frame rather than immediately: Safari has historically
// cancelled the download if the URL is revoked in the same tick as the click.
export function saveText(fileName, text, mimeType) {
  const blob = new Blob([text], { type: mimeType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  // Must be in the document for the click to count as user-initiated in Firefox.
  document.body.appendChild(link);
  link.click();
  link.remove();

  requestAnimationFrame(() => URL.revokeObjectURL(url));
}

// Same hand-off for a Blob that already exists (the photo-mode PNG). saveText wraps a string in a
// Blob and does this; an image must not round-trip through a string.
export function saveBlob(fileName, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);   // a big file can still be streaming to disk next frame
}
