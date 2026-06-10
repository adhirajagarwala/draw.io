# Scribble — classroom PDF annotation tool

A small, security-first web tool for marking up question papers. Students open
a PDF, scribble with a pen, highlight, drop text notes, place tick/cross/
circle/arrow marks, and export an annotated PDF. All logic runs client-side in
**Rust → WebAssembly**; the server only ever serves static files and no data
ever leaves the machine.

**Quick start**

```sh
cd scribble/web
python3 -m http.server 8000   # open http://localhost:8000
```

See [`scribble/README.md`](scribble/README.md) for the full feature list,
build instructions, and the security design write-up.
[`instructions.md`](instructions.md) is the original design document.

Licensed under the [MIT License](LICENSE).
