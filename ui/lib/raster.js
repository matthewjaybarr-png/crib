// SVG or JPEG -> PNG in the page (WebView2 / WebKitGTK / a browser): toolbooks keep only PNG pictures (schema.js). The
// browser draws the picture at its own size onto a canvas.
// Node has no canvas, so code that needs it takes this as a parameter (toPng) and the tests pass their own.

/** SVG or JPEG bytes -> PNG bytes, at the SVG's width and height attributes or the JPEG's size. */
export async function svgToPng(svg) {
  const url = URL.createObjectURL(new Blob([svg], { type: svg[0] === 0xff && svg[1] === 0xd8 ? "image/jpeg" : "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    const png = await new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error("could not make a PNG of the drawing"))), "image/png"));
    return new Uint8Array(await png.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}
