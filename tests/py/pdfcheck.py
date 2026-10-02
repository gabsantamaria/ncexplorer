"""pdfcheck.py PDF OUT.json -- page count, page sizes, raster-image count and
text of every page of a PDF (used by tests/pyexport.test.mjs; needs pypdf).

An image is any /Image XObject (also inside Form XObjects, recursively) or an
inline image; a fully vector page has none."""
import json
import sys

from pypdf import PdfReader


def count_images(resources, seen):
    n = 0
    if not resources:
        return 0
    resources = resources.get_object()
    xobjects = resources.get("/XObject")
    if not xobjects:
        return 0
    for _name, ref in xobjects.get_object().items():
        obj = ref.get_object()
        key = getattr(ref, "idnum", None) or id(obj)
        if key in seen:
            continue
        seen.add(key)
        subtype = obj.get("/Subtype")
        if subtype == "/Image":
            n += 1
        elif subtype == "/Form":
            n += count_images(obj.get("/Resources"), seen)
    return n


def main(pdf_path, out_path):
    reader = PdfReader(pdf_path)
    pages = []
    for page in reader.pages:
        try:
            inline = len(page.images)
        except Exception as e:  # pragma: no cover
            inline = -1
            print("page.images failed: %s" % e)
        try:
            text = page.extract_text() or ""
        except Exception:  # pragma: no cover
            text = ""
        pages.append({
            "w": float(page.mediabox.width), "h": float(page.mediabox.height),
            "xobject_images": count_images(page.get("/Resources"), set()),
            "images": inline, "text": text,
        })
    meta = reader.metadata or {}
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump({"pages": pages, "title": str(meta.get("/Title", ""))}, fh)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
