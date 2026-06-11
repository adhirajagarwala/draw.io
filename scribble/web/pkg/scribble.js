let wasm;

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_export_2.set(idx, obj);
    return idx;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

const cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : { decode: () => { throw Error('TextDecoder not available') } } );

if (typeof TextDecoder !== 'undefined') { cachedTextDecoder.decode(); };

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_export_2.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let WASM_VECTOR_LEN = 0;

const cachedTextEncoder = (typeof TextEncoder !== 'undefined' ? new TextEncoder('utf-8') : { encode: () => { throw Error('TextEncoder not available') } } );

const encodeString = (typeof cachedTextEncoder.encodeInto === 'function'
    ? function (arg, view) {
    return cachedTextEncoder.encodeInto(arg, view);
}
    : function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
        read: arg.length,
        written: buf.length
    };
});

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }

    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = encodeString(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let cachedFloat32ArrayMemory0 = null;

function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

const AppFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_app_free(ptr >>> 0, 1));

export class App {

    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AppFinalization.unregister(this);
        return ptr;
    }

    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_app_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    page_count() {
        const ret = wasm.app_page_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {string}
     */
    pdf_sha256() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.app_pdf_sha256(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    pointer_up() {
        wasm.app_pointer_up(this.__wbg_ptr);
    }
    /**
     * @param {number} page
     * @param {number} id
     * @returns {boolean}
     */
    delete_item(page, id) {
        const ret = wasm.app_delete_item(this.__wbg_ptr, page, id);
        return ret !== 0;
    }
    /**
     * Register a page's size (PDF coordinates at scale 1).
     * @param {number} index
     * @param {number} width
     * @param {number} height
     */
    ensure_page(index, width, height) {
        const ret = wasm.app_ensure_page(this.__wbg_ptr, index, width, height);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} i
     * @returns {boolean}
     */
    remove_note(i) {
        const ret = wasm.app_remove_note(this.__wbg_ptr, i);
        return ret !== 0;
    }
    /**
     * Switch display palette ("standard" | "safe"). Colors in files are
     * semantic names, so this changes rendering only — never the document.
     * @param {string} name
     * @returns {boolean}
     */
    set_palette(name) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.app_set_palette(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * `[width, height]` of a sketch note's canvas, or empty if not a sketch.
     * @param {number} i
     * @returns {Float32Array}
     */
    sketch_size(i) {
        const ret = wasm.app_sketch_size(this.__wbg_ptr, i);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Replace the content of an existing text note (empty content deletes it).
     * @param {number} page
     * @param {number} id
     * @param {string} content
     */
    update_text(page, id, content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.app_update_text(this.__wbg_ptr, page, id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Append a snipped clipping. Returns its index.
     * @param {string} png_b64
     * @param {number} source_page
     * @param {string} caption
     * @returns {number}
     */
    add_clipping(png_b64, source_page, caption) {
        const ptr0 = passStringToWasm0(png_b64, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(caption, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.app_add_clipping(this.__wbg_ptr, ptr0, len0, source_page, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {number} page
     * @param {number} id
     * @returns {Float32Array}
     */
    item_bbox_of(page, id) {
        const ret = wasm.app_item_bbox_of(this.__wbg_ptr, page, id);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {number} i
     * @returns {string}
     */
    note_caption(i) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.app_note_caption(this.__wbg_ptr, i);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Pointer press on a PDF page.
     * @param {number} page
     * @param {number} x
     * @param {number} y
     * @param {number} erase_radius
     */
    pointer_down(page, x, y, erase_radius) {
        wasm.app_pointer_down(this.__wbg_ptr, page, x, y, erase_radius);
    }
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} erase_radius
     */
    pointer_move(x, y, erase_radius) {
        wasm.app_pointer_move(this.__wbg_ptr, x, y, erase_radius);
    }
    /**
     * @param {number} page
     * @param {number} id
     * @returns {string}
     */
    text_content(page, id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.app_text_content(this.__wbg_ptr, page, id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Append an empty/with-content text block. Returns its index.
     * @param {string} content
     * @returns {number}
     */
    add_text_note(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.app_add_text_note(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Finish a move/resize, recording it as a single undoable step.
     */
    end_item_drag() {
        wasm.app_end_item_drag(this.__wbg_ptr);
    }
    /**
     * Draw all annotations for a sketch note onto the (cleared) canvas.
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} note
     * @param {number} scale
     */
    render_sketch(ctx, note, scale) {
        wasm.app_render_sketch(this.__wbg_ptr, ctx, note, scale);
    }
    /**
     * Pen / shape stroke width by named size.
     * @param {string} name
     * @returns {boolean}
     */
    set_pen_width(name) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.app_set_pen_width(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * Vector PDF content-stream operators for all annotations on `page`.
     * The host embeds these after drawing the page image; it must register
     * the resources named by `highlight_gstate_name()` / `text_font_name()`.
     * @param {number} page
     * @returns {string}
     */
    export_pdf_ops(page) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.app_export_pdf_ops(this.__wbg_ptr, page);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} note
     * @param {number} id
     * @returns {boolean}
     */
    is_text_sketch(note, id) {
        const ret = wasm.app_is_text_sketch(this.__wbg_ptr, note, id);
        return ret !== 0;
    }
    /**
     * Cancel any in-progress stroke/shape/drag/erase (e.g. pointer lost).
     */
    pointer_cancel() {
        wasm.app_pointer_cancel(this.__wbg_ptr);
    }
    /**
     * Record the SHA-256 (hex) of the loaded PDF. Computed by JS via WebCrypto.
     * @param {string} hex
     */
    set_pdf_sha256(hex) {
        const ptr0 = passStringToWasm0(hex, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.app_set_pdf_sha256(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {string}
     */
    text_font_name() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.app_text_font_name(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Append a blank sketch canvas of the given size. Returns its index.
     * Annotations on it are NOT undone by this call's history (they have
     * their own commands once drawn).
     * @param {number} width
     * @param {number} height
     * @returns {number}
     */
    add_sketch_note(width, height) {
        const ret = wasm.app_add_sketch_note(this.__wbg_ptr, width, height);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {number} note
     * @param {number} x
     * @param {number} y
     * @param {string} content
     */
    add_text_sketch(note, x, y, content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.app_add_text_sketch(this.__wbg_ptr, note, x, y, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Start moving an existing item (any kind). `x`, `y` is the grab point.
     * @param {number} page
     * @param {number} id
     * @param {number} x
     * @param {number} y
     * @returns {boolean}
     */
    begin_item_drag(page, id, x, y) {
        const ret = wasm.app_begin_item_drag(this.__wbg_ptr, page, id, x, y);
        return ret !== 0;
    }
    /**
     * @param {number} note
     * @param {number} id
     * @returns {Float32Array}
     */
    text_pos_sketch(note, id) {
        const ret = wasm.app_text_pos_sketch(this.__wbg_ptr, note, id);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * @param {number} note
     * @param {number} x
     * @param {number} y
     * @returns {number}
     */
    find_item_sketch(note, x, y) {
        const ret = wasm.app_find_item_sketch(this.__wbg_ptr, note, x, y);
        return ret;
    }
    /**
     * @param {number} note
     * @param {number} id
     * @returns {string}
     */
    item_kind_sketch(note, id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.app_item_kind_sketch(this.__wbg_ptr, note, id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} i
     * @returns {number}
     */
    note_source_page(i) {
        const ret = wasm.app_note_source_page(this.__wbg_ptr, i);
        return ret;
    }
    /**
     * @param {number} i
     * @param {string} content
     */
    update_note_text(i, content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.app_update_note_text(this.__wbg_ptr, i, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * PDF vector operators for a sketch note's annotations (for export).
     * @param {number} i
     * @returns {string}
     */
    sketch_export_ops(i) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.app_sketch_export_ops(this.__wbg_ptr, i);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} note
     * @param {number} id
     * @returns {boolean}
     */
    delete_item_sketch(note, id) {
        const ret = wasm.app_delete_item_sketch(this.__wbg_ptr, note, id);
        return ret !== 0;
    }
    /**
     * Scale the item under drag about an anchor point (a resize preview).
     * @param {number} anchor_x
     * @param {number} anchor_y
     * @param {number} sx
     * @param {number} sy
     */
    scale_dragged_item(anchor_x, anchor_y, sx, sy) {
        wasm.app_scale_dragged_item(this.__wbg_ptr, anchor_x, anchor_y, sx, sy);
    }
    /**
     * @param {number} note
     * @param {number} id
     * @param {string} content
     */
    update_text_sketch(note, id, content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.app_update_text_sketch(this.__wbg_ptr, note, id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} note
     * @param {number} id
     * @returns {Float32Array}
     */
    item_bbox_of_sketch(note, id) {
        const ret = wasm.app_item_bbox_of_sketch(this.__wbg_ptr, note, id);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * PDF ops for a pre-wrapped block of note text on an exported notes
     * page. `lines` are joined by '\n'; sanitization + escaping in Rust.
     * @param {string} lines
     * @param {number} x
     * @param {number} y_pdf
     * @param {number} size
     * @returns {string}
     */
    note_text_block_ops(lines, x, y_pdf, size) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(lines, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.app_note_text_block_ops(this.__wbg_ptr, ptr0, len0, x, y_pdf, size);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Pointer press on a sketch note (by its index in the notes list).
     * @param {number} note
     * @param {number} x
     * @param {number} y
     * @param {number} erase_radius
     */
    pointer_down_sketch(note, x, y, erase_radius) {
        wasm.app_pointer_down_sketch(this.__wbg_ptr, note, x, y, erase_radius);
    }
    /**
     * @param {number} note
     * @param {number} id
     * @returns {string}
     */
    text_content_sketch(note, id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.app_text_content_sketch(this.__wbg_ptr, note, id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} i
     * @param {string} caption
     */
    update_note_caption(i, caption) {
        const ptr0 = passStringToWasm0(caption, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.app_update_note_caption(this.__wbg_ptr, i, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {string}
     */
    highlight_gstate_name() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.app_highlight_gstate_name(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} note
     * @param {number} id
     * @param {number} x
     * @param {number} y
     * @returns {boolean}
     */
    begin_item_drag_sketch(note, id, x, y) {
        const ret = wasm.app_begin_item_drag_sketch(this.__wbg_ptr, note, id, x, y);
        return ret !== 0;
    }
    constructor() {
        const ret = wasm.app_new();
        this.__wbg_ptr = ret >>> 0;
        AppFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    redo() {
        wasm.app_redo(this.__wbg_ptr);
    }
    undo() {
        wasm.app_undo(this.__wbg_ptr);
    }
    /**
     * Draw all annotations for a PDF page onto the (cleared) canvas.
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} page
     * @param {number} scale
     */
    render(ctx, page, scale) {
        wasm.app_render(this.__wbg_ptr, ctx, page, scale);
    }
    /**
     * @param {number} page
     * @param {number} id
     * @returns {boolean}
     */
    is_text(page, id) {
        const ret = wasm.app_is_text(this.__wbg_ptr, page, id);
        return ret !== 0;
    }
    /**
     * @param {number} page
     * @param {number} x
     * @param {number} y
     * @param {string} content
     */
    add_text(page, x, y, content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.app_add_text(this.__wbg_ptr, page, x, y, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {boolean}
     */
    can_redo() {
        const ret = wasm.app_can_redo(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    can_undo() {
        const ret = wasm.app_can_undo(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    is_dirty() {
        const ret = wasm.app_is_dirty(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {number} i
     * @returns {string}
     */
    note_png(i) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.app_note_png(this.__wbg_ptr, i);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {string} name
     * @returns {boolean}
     */
    set_tool(name) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.app_set_tool(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
    /**
     * @param {number} page
     * @param {number} id
     * @returns {Float32Array}
     */
    text_pos(page, id) {
        const ret = wasm.app_text_pos(this.__wbg_ptr, page, id);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Display color (CSS) of `name` under the active palette, for swatches.
     * @param {string} name
     * @returns {string}
     */
    color_css(name) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.app_color_css(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Move the dragged item with the pointer (rigid, clamped to its surface).
     * @param {number} x
     * @param {number} y
     */
    drag_item(x, y) {
        wasm.app_drag_item(this.__wbg_ptr, x, y);
    }
    /**
     * @param {number} page
     * @param {number} x
     * @param {number} y
     * @returns {number}
     */
    find_item(page, x, y) {
        const ret = wasm.app_find_item(this.__wbg_ptr, page, x, y);
        return ret;
    }
    /**
     * @param {number} page
     * @param {number} id
     * @returns {string}
     */
    item_kind(page, id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.app_item_kind(this.__wbg_ptr, page, id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Load annotations from JSON. Input is treated as hostile: size-capped,
     * strictly parsed, fully validated. On any error the current document is
     * left untouched.
     * @param {string} json
     */
    load_json(json) {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.app_load_json(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Move a block up (delta = -1) or down (delta = +1).
     * @param {number} i
     * @param {number} delta
     * @returns {boolean}
     */
    move_note(i, delta) {
        const ret = wasm.app_move_note(this.__wbg_ptr, i, delta);
        return ret !== 0;
    }
    /**
     * "text" | "clipping" | "sketch" | "" (out of range).
     * @param {number} i
     * @returns {string}
     */
    note_kind(i) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.app_note_kind(this.__wbg_ptr, i);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} i
     * @returns {string}
     */
    note_text(i) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.app_note_text(this.__wbg_ptr, i);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    notes_len() {
        const ret = wasm.app_notes_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {string}
     */
    save_json() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.app_save_json(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {string} name
     * @returns {boolean}
     */
    set_color(name) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.app_set_color(this.__wbg_ptr, ptr0, len0);
        return ret !== 0;
    }
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                if (module.headers.get('Content-Type') != 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else {
                    throw e;
                }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);

    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };

        } else {
            return instance;
        }
    }
}

function __wbg_get_imports() {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbg_beginPath_0198cb08b8521814 = function(arg0) {
        arg0.beginPath();
    };
    imports.wbg.__wbg_ellipse_95f0fe1a522875d7 = function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7) {
        arg0.ellipse(arg1, arg2, arg3, arg4, arg5, arg6, arg7);
    }, arguments) };
    imports.wbg.__wbg_fillRect_c38d5d56492a2368 = function(arg0, arg1, arg2, arg3, arg4) {
        arg0.fillRect(arg1, arg2, arg3, arg4);
    };
    imports.wbg.__wbg_fillText_2a0055d8531355d1 = function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
        arg0.fillText(getStringFromWasm0(arg1, arg2), arg3, arg4);
    }, arguments) };
    imports.wbg.__wbg_lineTo_2fc468a0e2210784 = function(arg0, arg1, arg2) {
        arg0.lineTo(arg1, arg2);
    };
    imports.wbg.__wbg_moveTo_123c5e7629da2e1e = function(arg0, arg1, arg2) {
        arg0.moveTo(arg1, arg2);
    };
    imports.wbg.__wbg_rect_2e7beff911554fa5 = function(arg0, arg1, arg2, arg3, arg4) {
        arg0.rect(arg1, arg2, arg3, arg4);
    };
    imports.wbg.__wbg_restore_cc5ae2746f7b5043 = function(arg0) {
        arg0.restore();
    };
    imports.wbg.__wbg_save_c675a7a4bbd44e4a = function(arg0) {
        arg0.save();
    };
    imports.wbg.__wbg_scale_4105cc7f9ba9c045 = function() { return handleError(function (arg0, arg1, arg2) {
        arg0.scale(arg1, arg2);
    }, arguments) };
    imports.wbg.__wbg_setfillStyle_2205fca942c641ba = function(arg0, arg1, arg2) {
        arg0.fillStyle = getStringFromWasm0(arg1, arg2);
    };
    imports.wbg.__wbg_setfont_42a163ef83420b93 = function(arg0, arg1, arg2) {
        arg0.font = getStringFromWasm0(arg1, arg2);
    };
    imports.wbg.__wbg_setglobalAlpha_4673ca870e9d3439 = function(arg0, arg1) {
        arg0.globalAlpha = arg1;
    };
    imports.wbg.__wbg_setglobalCompositeOperation_9a7a92bac2fb7ffd = function() { return handleError(function (arg0, arg1, arg2) {
        arg0.globalCompositeOperation = getStringFromWasm0(arg1, arg2);
    }, arguments) };
    imports.wbg.__wbg_setlineCap_52b6d742c95a5630 = function(arg0, arg1, arg2) {
        arg0.lineCap = getStringFromWasm0(arg1, arg2);
    };
    imports.wbg.__wbg_setlineJoin_7e005d90ef83d627 = function(arg0, arg1, arg2) {
        arg0.lineJoin = getStringFromWasm0(arg1, arg2);
    };
    imports.wbg.__wbg_setlineWidth_ec730c524f09baa9 = function(arg0, arg1) {
        arg0.lineWidth = arg1;
    };
    imports.wbg.__wbg_setstrokeStyle_415833f3f0eb5076 = function(arg0, arg1, arg2) {
        arg0.strokeStyle = getStringFromWasm0(arg1, arg2);
    };
    imports.wbg.__wbg_stroke_c8939d3873477ffa = function(arg0) {
        arg0.stroke();
    };
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_export_2;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
        ;
    };
    imports.wbg.__wbindgen_string_new = function(arg0, arg1) {
        const ret = getStringFromWasm0(arg0, arg1);
        return ret;
    };
    imports.wbg.__wbindgen_throw = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };

    return imports;
}

function __wbg_init_memory(imports, memory) {

}

function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    __wbg_init.__wbindgen_wasm_module = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;


    wasm.__wbindgen_start();
    return wasm;
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();

    __wbg_init_memory(imports);

    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }

    const instance = new WebAssembly.Instance(module, imports);

    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('scribble_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    __wbg_init_memory(imports);

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
