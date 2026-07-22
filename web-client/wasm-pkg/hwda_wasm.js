/* @ts-self-types="./hwda_wasm.d.ts" */

export class KdbStreamParser {
    static __wrap(ptr) {
        const obj = Object.create(KdbStreamParser.prototype);
        obj.__wbg_ptr = ptr;
        KdbStreamParserFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        KdbStreamParserFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_kdbstreamparser_free(ptr, 0);
    }
    /**
     * Create a new streaming parser.
     * @param {string} kdb_id
     * @returns {KdbStreamParser}
     */
    static create(kdb_id) {
        const ptr0 = passStringToWasm0(kdb_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.kdbstreamparser_create(ptr0, len0);
        return KdbStreamParser.__wrap(ret);
    }
    /**
     * Feed the complete compressed KDB data (including the 8-byte header).
     * Validates the magic number, decompresses, and parses the protobuf.
     * Call finalize() after this to free memory, then store_async() to persist.
     * @param {Uint8Array} data
     */
    feed_complete(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.kdbstreamparser_feed_complete(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Finalize: free the parsed data from memory (after store_async).
     * Returns the design name.
     * @returns {string}
     */
    finalize() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.kdbstreamparser_finalize(this.__wbg_ptr);
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
     * After feed_complete(), call this to store the parsed data to IndexedDB/OPFS.
     * Returns the design name on success.
     * @returns {Promise<string>}
     */
    store_async() {
        const ret = wasm.kdbstreamparser_store_async(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) KdbStreamParser.prototype[Symbol.dispose] = KdbStreamParser.prototype.free;

/**
 * Waveform data provider
 */
export class WaveformDataProvider {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WaveformDataProviderFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_waveformdataprovider_free(ptr, 0);
    }
    /**
     * Clear all cache data
     */
    clear_cache() {
        wasm.waveformdataprovider_clear_cache(this.__wbg_ptr);
    }
    /**
     * Get current LoD based on viewport and canvas
     * @returns {number}
     */
    get current_lod() {
        const ret = wasm.waveformdataprovider_current_lod(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get display format
     * @returns {string}
     */
    get display_format() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.waveformdataprovider_display_format(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get display unit per LoD0 unit (time conversion factor)
     * @returns {number}
     */
    get display_unit_per_lod0_unit() {
        const ret = wasm.waveformdataprovider_display_unit_per_lod0_unit(this.__wbg_ptr);
        return ret;
    }
    /**
     * Fetch data and get segments in one call
     *
     * This is a convenience function that combines fetch_signals_data_batch and get_segments
     * to reduce JS-Rust boundary crossings and simplify the calling code.
     *
     * # Arguments
     * * `signal_names` - List of signal names to fetch and render
     *
     * # Returns
     * * Serialized RenderSegment array
     * @param {string[]} signal_names
     * @returns {Promise<any>}
     */
    fetch_and_get_segments(signal_names) {
        const ptr0 = passArrayJsValueToWasm0(signal_names, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.waveformdataprovider_fetch_and_get_segments(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Find transitions around a specific time for cursor snapping
     * Returns [prev_time, next_time] where null means no transition found
     * Note: BOUNDARY_TIME_START (0xFFFFFFFFFFFFFFFF) is excluded from results
     * @param {string} signal_name
     * @param {number} time
     * @returns {any}
     */
    find_transitions_around(signal_name, time) {
        const ptr0 = passStringToWasm0(signal_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.waveformdataprovider_find_transitions_around(this.__wbg_ptr, ptr0, len0, time);
        return ret;
    }
    /**
     * Check if signal_data has data for the given signal
     * Returns an object with transition count and bucket count, or null if signal not found
     * @param {string} signal_name
     * @returns {any}
     */
    getSignalDataStats(signal_name) {
        const ptr0 = passStringToWasm0(signal_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.waveformdataprovider_getSignalDataStats(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Returns the list of signal names the server reported as not found during
     * the last fetch. The UI uses this to drop signals that don't exist.
     * Built manually with js_sys to avoid any (de)serialization dependency.
     * @returns {any}
     */
    get_not_found_signals() {
        const ret = wasm.waveformdataprovider_get_not_found_signals(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get signal names (for testing)
     * @returns {any}
     */
    get_signal_names() {
        const ret = wasm.waveformdataprovider_get_signal_names(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get signal value at a specific time
     * Returns the value of the signal at the given time (from cached data)
     * If data is not cached, returns null
     * Handles BOUNDARY_TIME_START (0xFFFFFFFFFFFFFFFF) as the start-of-range value
     * display_format: optional display format override ("hex", "bin", "oct", "dec")
     * @param {string} signal_name
     * @param {number} time
     * @param {string | null} [display_format]
     * @returns {any}
     */
    get_signal_value_at_time(signal_name, time, display_format) {
        const ptr0 = passStringToWasm0(signal_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = isLikeNone(display_format) ? 0 : passStringToWasm0(display_format, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        const ret = wasm.waveformdataprovider_get_signal_value_at_time(this.__wbg_ptr, ptr0, len0, time, ptr1, len1);
        return ret;
    }
    /**
     * Get raw signal values at all transition points within a time range
     *
     * This function fetches LoD 0 data for the specified signals and time range,
     * then returns all signal values at each transition point.
     *
     * # Arguments
     * * `signal_names` - List of signal names to query
     * * `search_start_time` - Start of search range (inclusive)
     * * `search_end_time` - End of search range (inclusive)
     * * `result_max` - Maximum number of time points to return
     * * `signals_with_format` - Signal list with display format for each signal
     *
     * # Returns
     * * Serialized RawSignalValuesResult
     * @param {string[]} signal_names
     * @param {bigint} search_start_time
     * @param {bigint} search_end_time
     * @param {number} result_max
     * @param {any} signals_with_format
     * @param {number | null} [lod]
     * @param {boolean | null} [enable_opfs]
     * @param {boolean | null} [enable_memory_cache]
     * @param {boolean | null} [early_exit_on_insufficient_transitions]
     * @returns {Promise<any>}
     */
    get_signal_values_at_transitions(signal_names, search_start_time, search_end_time, result_max, signals_with_format, lod, enable_opfs, enable_memory_cache, early_exit_on_insufficient_transitions) {
        const ptr0 = passArrayJsValueToWasm0(signal_names, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.waveformdataprovider_get_signal_values_at_transitions(this.__wbg_ptr, ptr0, len0, search_start_time, search_end_time, result_max, signals_with_format, isLikeNone(lod) ? Number.MAX_SAFE_INTEGER : (lod) >>> 0, isLikeNone(enable_opfs) ? 0xFFFFFF : enable_opfs ? 1 : 0, isLikeNone(enable_memory_cache) ? 0xFFFFFF : enable_memory_cache ? 1 : 0, isLikeNone(early_exit_on_insufficient_transitions) ? 0xFFFFFF : early_exit_on_insufficient_transitions ? 1 : 0);
        return ret;
    }
    /**
     * Initialize with OPFS callbacks
     *
     * # Arguments
     * * `opfs_read` - JS callback: (path: string) -> Promise<Uint8Array | null>
     * * `opfs_write` - JS callback: (path: string, data: Uint8Array) -> Promise<()>
     * * `opfs_exists` - JS callback: (path: string) -> Promise<bool>
     * * `enable_opfs` - Whether to enable OPFS cache
     * @param {Function} opfs_read
     * @param {Function} opfs_write
     * @param {Function} opfs_exists
     * @param {boolean} enable_opfs
     */
    init_with_opfs(opfs_read, opfs_write, opfs_exists, enable_opfs) {
        wasm.waveformdataprovider_init_with_opfs(this.__wbg_ptr, opfs_read, opfs_write, opfs_exists, enable_opfs);
    }
    /**
     * Convert local signal name to server signal name
     * Step 1: Remove prefix (e.g., "work@tb_top.u_dut.signal" -> "tb_top.u_dut.signal")
     * Step 2: Add space before bracket if needed (e.g., "signal[7:0]" -> "signal [7:0]")
     * Note: No regex escaping needed for base64 encoding
     * @param {string} local_name
     * @returns {string}
     */
    local_to_server_name(local_name) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(local_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.waveformdataprovider_local_to_server_name(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Get memory cache enabled status
     * @returns {boolean}
     */
    get memory_cache_enabled() {
        const ret = wasm.waveformdataprovider_memory_cache_enabled(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Create a new waveform data provider
     * @param {string} server_url
     * @param {string} waveform_name
     * @param {string} signal_prefix
     * @param {string} server_prefix
     * @param {boolean} space_before_bracket
     * @param {bigint} time_stamp
     */
    constructor(server_url, waveform_name, signal_prefix, server_prefix, space_before_bracket, time_stamp) {
        const ptr0 = passStringToWasm0(server_url, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(waveform_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(signal_prefix, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(server_prefix, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.waveformdataprovider_new(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, space_before_bracket, time_stamp);
        this.__wbg_ptr = ret;
        WaveformDataProviderFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Get OPFS cache enabled status
     * @returns {boolean}
     */
    get opfs_enabled() {
        const ret = wasm.waveformdataprovider_opfs_enabled(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Prefetch tiles for the current viewport signals
     *
     * This function prefetches tiles in the background to improve user experience.
     * It checks tiles 4x before and after the current viewport, fetches missing data,
     * and stores it in OPFS cache only (not in signal_data memory cache).
     *
     * # Arguments
     * * `signal_names` - List of signal names to prefetch (typically the current draw list)
     *
     * # Returns
     * * Ok(()) if prefetch completed (errors are logged but not returned)
     * @param {string[]} signal_names
     * @returns {Promise<void>}
     */
    prefetch_tiles(signal_names) {
        const ptr0 = passArrayJsValueToWasm0(signal_names, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.waveformdataprovider_prefetch_tiles(this.__wbg_ptr, ptr0, len0);
        return ret;
    }
    /**
     * Asynchronous prefetch that runs in a separate task without blocking render
     *
     * This function spawns a local async task to perform prefetch, allowing
     * render operations to continue in parallel.
     * OPFS and Memory cache are shared between render and prefetch via Arc.
     *
     * # Arguments
     * * `signal_names` - List of signal names to prefetch
     * @param {string[]} signal_names
     */
    prefetch_tiles_async(signal_names) {
        const ptr0 = passArrayJsValueToWasm0(signal_names, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.waveformdataprovider_prefetch_tiles_async(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Get server prefix
     * @returns {string}
     */
    get server_prefix() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.waveformdataprovider_server_prefix(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get server URL
     * @returns {string}
     */
    get server_url() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.waveformdataprovider_server_url(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Set canvas dimensions
     * When width changes, adjust time_end to maintain the same time-to-pixel ratio
     * time_start remains fixed
     * @param {number} width
     * @param {number} height
     * @param {number} row_height
     */
    set_canvas_dimensions(width, height, row_height) {
        wasm.waveformdataprovider_set_canvas_dimensions(this.__wbg_ptr, width, height, row_height);
    }
    /**
     * Set display format (hex, bin, oct, dec)
     * @param {string} format
     */
    set display_format(format) {
        const ptr0 = passStringToWasm0(format, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.waveformdataprovider_set_display_format(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Set display unit per LoD0 unit (time conversion factor)
     * @param {number} factor
     */
    set display_unit_per_lod0_unit(factor) {
        wasm.waveformdataprovider_set_display_unit_per_lod0_unit(this.__wbg_ptr, factor);
    }
    /**
     * Set signals with draw_sig_id (new API)
     *
     * # Arguments
     * * `signals_js` - Array of { global_id, name, row, width, draw_sig_id, display_format }
     * @param {any} signals_js
     */
    set_draw_list(signals_js) {
        const ret = wasm.waveformdataprovider_set_draw_list(this.__wbg_ptr, signals_js);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Set memory cache enabled
     * @param {boolean} enabled
     */
    set_memory_cache_enabled(enabled) {
        wasm.waveformdataprovider_set_memory_cache_enabled(this.__wbg_ptr, enabled);
    }
    /**
     * Set OPFS cache enabled (dynamic toggle)
     * @param {boolean} enabled
     */
    set_opfs_enabled(enabled) {
        wasm.waveformdataprovider_set_opfs_enabled(this.__wbg_ptr, enabled);
    }
    /**
     * Set server prefix
     * @param {string} prefix
     */
    set server_prefix(prefix) {
        const ptr0 = passStringToWasm0(prefix, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.waveformdataprovider_set_server_prefix(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Set signal prefix (local prefix)
     * @param {string} prefix
     */
    set signal_prefix(prefix) {
        const ptr0 = passStringToWasm0(prefix, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.waveformdataprovider_set_signal_prefix(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Set signals to render
     * @param {any} signals_js
     */
    set_signals(signals_js) {
        const ret = wasm.waveformdataprovider_set_signals(this.__wbg_ptr, signals_js);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Set space before bracket
     * @param {boolean} space
     */
    set space_before_bracket(space) {
        wasm.waveformdataprovider_set_space_before_bracket(this.__wbg_ptr, space);
    }
    /**
     * Set viewport
     * @param {number} time_start
     * @param {number} time_end
     */
    set_viewport(time_start, time_end) {
        wasm.waveformdataprovider_set_viewport(this.__wbg_ptr, time_start, time_end);
    }
    /**
     * Get signal prefix (local prefix)
     * @returns {string}
     */
    get signal_prefix() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.waveformdataprovider_signal_prefix(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get space before bracket setting
     * @returns {boolean}
     */
    get space_before_bracket() {
        const ret = wasm.waveformdataprovider_space_before_bracket(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Test signal name conversion (for debugging)
     * @param {string} local_name
     * @returns {string}
     */
    test_name_conversion(local_name) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(local_name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.waveformdataprovider_test_name_conversion(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Get viewport time_end
     * @returns {number}
     */
    get viewport_time_end() {
        const ret = wasm.waveformdataprovider_viewport_time_end(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get viewport time_start
     * @returns {number}
     */
    get viewport_time_start() {
        const ret = wasm.waveformdataprovider_viewport_time_start(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get waveform name
     * @returns {string}
     */
    get waveform_name() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.waveformdataprovider_waveform_name(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) WaveformDataProvider.prototype[Symbol.dispose] = WaveformDataProvider.prototype.free;

/**
 * Parse KDB file and store directly to IndexedDB
 * Returns the design name on success
 * @param {string} kdb_id
 * @param {Uint8Array} data
 * @returns {Promise<string>}
 */
export function parse_and_store_kdb(kdb_id, data) {
    const ptr0 = passStringToWasm0(kdb_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.parse_and_store_kdb(ptr0, len0, ptr1, len1);
    return ret;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_92b29b0548f8b746: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_Number_9a4e0ecb0fa16705: function(arg0) {
            const ret = Number(arg0);
            return ret;
        },
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_bigint_get_as_i64_d968e41184ae354f: function(arg0, arg1) {
            const v = arg1;
            const ret = typeof(v) === 'bigint' ? v : undefined;
            getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_boolean_get_fa956cfa2d1bd751: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_c25d447a39f5578f: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_in_aca499c5de7ff5e5: function(arg0, arg1) {
            const ret = arg0 in arg1;
            return ret;
        },
        __wbg___wbindgen_is_bigint_2f76dc55065b4273: function(arg0) {
            const ret = typeof(arg0) === 'bigint';
            return ret;
        },
        __wbg___wbindgen_is_function_1ff95bcc5517c252: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_null_ea9085d691f535d3: function(arg0) {
            const ret = arg0 === null;
            return ret;
        },
        __wbg___wbindgen_is_object_a27215656b807791: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_undefined_c05833b95a3cf397: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_jsval_eq_e659fcf7b0e32763: function(arg0, arg1) {
            const ret = arg0 === arg1;
            return ret;
        },
        __wbg___wbindgen_jsval_loose_eq_db4c3b15f63fc170: function(arg0, arg1) {
            const ret = arg0 == arg1;
            return ret;
        },
        __wbg___wbindgen_number_get_394265ed1e1b84ee: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_b0ca35b86a603356: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg__wbg_cb_unref_fffb441def202758: function(arg0) {
            arg0._wbg_cb_unref();
        },
        __wbg_apply_23dd4d2439189415: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.apply(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_arrayBuffer_3b637f0fa65c5351: function() { return handleError(function (arg0) {
            const ret = arg0.arrayBuffer();
            return ret;
        }, arguments); },
        __wbg_call_8a2dd23819f8a60a: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_call_a6e5c5dce5018821: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_call_e3b662382210db98: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_clear_kdb_data_54d65f963a21d75b: function(arg0, arg1) {
            const ret = window.clear_kdb_data(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_done_89b2b13e91a60321: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_getHours_9f6561095682ce51: function(arg0) {
            const ret = arg0.getHours();
            return ret;
        },
        __wbg_getMilliseconds_0f73a1c695eb6447: function(arg0) {
            const ret = arg0.getMilliseconds();
            return ret;
        },
        __wbg_getMinutes_b0d5cd90bf9b8f22: function(arg0) {
            const ret = arg0.getMinutes();
            return ret;
        },
        __wbg_getSeconds_40c565b3a6cb05fe: function(arg0) {
            const ret = arg0.getSeconds();
            return ret;
        },
        __wbg_get_78f252d074a84d0b: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_c7eb1f358a7654df: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_unchecked_6e0ad6d2a41b06f6: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_with_ref_key_6412cf3094599694: function(arg0, arg1) {
            const ret = arg0[arg1];
            return ret;
        },
        __wbg_instanceof_ArrayBuffer_4480b9e0068a8adb: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Object_33f20e6f12439f3e: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Object;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Promise_4cb210c0b8f8c959: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Promise;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Response_c8b64b2256f01bec: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Response;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_309b927aaf7a3fc7: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Window_05ba1ee4f6781663: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Window;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_0677c962b281d01a: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_isSafeInteger_04f36e4056f1b851: function(arg0) {
            const ret = Number.isSafeInteger(arg0);
            return ret;
        },
        __wbg_iterator_6f722e4a93058b71: function() {
            const ret = Symbol.iterator;
            return ret;
        },
        __wbg_length_1f0964f4a5e2c6d8: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_370319915dc99107: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_log_888d7110832462a3: function(arg0, arg1) {
            console.log(getStringFromWasm0(arg0, arg1));
        },
        __wbg_log_d267660666346fb3: function(arg0) {
            console.log(arg0);
        },
        __wbg_new_0_3da9e97f24fc69be: function() {
            const ret = new Date();
            return ret;
        },
        __wbg_new_32b398fb48b6d94a: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_aec3e25493d729fe: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen__convert__closures_____invoke__h35ddfd5fbe18a0cc(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_new_cd45aabdf6073e84: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_da52cf8fe3429cb2: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_from_slice_77cdfb7977362f3c: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_typed_1824d93f294193e5: function(arg0, arg1) {
            try {
                var state0 = {a: arg0, b: arg1};
                var cb0 = (arg0, arg1) => {
                    const a = state0.a;
                    state0.a = 0;
                    try {
                        return wasm_bindgen__convert__closures_____invoke__h35ddfd5fbe18a0cc(a, state0.b, arg0, arg1);
                    } finally {
                        state0.a = a;
                    }
                };
                const ret = new Promise(cb0);
                return ret;
            } finally {
                state0.a = 0;
            }
        },
        __wbg_next_6dbf2c0ac8cde20f: function(arg0) {
            const ret = arg0.next;
            return ret;
        },
        __wbg_next_71f2aa1cb3d1e37e: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_now_86c0d4ba3fa605b8: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_of_85f52f8b6491a7ca: function(arg0) {
            const ret = Array.of(arg0);
            return ret;
        },
        __wbg_ok_acc5e3fb89668864: function(arg0) {
            const ret = arg0.ok;
            return ret;
        },
        __wbg_prototypesetcall_4770620bbe4688a0: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_d2ae3af0c1217ae6: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_queueMicrotask_0ab5b2d2393e99b9: function(arg0) {
            const ret = arg0.queueMicrotask;
            return ret;
        },
        __wbg_queueMicrotask_6a09b7bc46549209: function(arg0) {
            queueMicrotask(arg0);
        },
        __wbg_report_heartbeat_8ba933f61fced1d5: function() {
            window.report_heartbeat();
        },
        __wbg_report_kdb_progress_0e625d3958bc6810: function(arg0, arg1, arg2, arg3) {
            window.report_kdb_progress(arg0 >>> 0, arg1 >>> 0, getStringFromWasm0(arg2, arg3));
        },
        __wbg_resolve_2191a4dfe481c25b: function(arg0) {
            const ret = Promise.resolve(arg0);
            return ret;
        },
        __wbg_setTimeout_cfa2cf195c3738db: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.setTimeout(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_8535240470bf2500: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_8a16b38e4805b298: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_static_accessor_GLOBAL_4ef717fb391d88b7: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_8d1badc68b5a74f4: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_146583524fe1469b: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_f2829a2234d7819e: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_status_c45b3b9b3033184a: function(arg0) {
            const ret = arg0.status;
            return ret;
        },
        __wbg_store_drivers_opfs_82bf24ec085cb027: function(arg0, arg1, arg2, arg3) {
            const ret = window.store_drivers_opfs(getArrayU8FromWasm0(arg0, arg1), getStringFromWasm0(arg2, arg3));
            return ret;
        },
        __wbg_store_knowledge_base_19fafa64d27d7625: function(arg0, arg1, arg2) {
            const ret = window.store_knowledge_base(getStringFromWasm0(arg0, arg1), arg2);
            return ret;
        },
        __wbg_store_modules_opfs_835e24567bbd3314: function(arg0, arg1, arg2, arg3) {
            const ret = window.store_modules_opfs(getArrayU8FromWasm0(arg0, arg1), getStringFromWasm0(arg2, arg3));
            return ret;
        },
        __wbg_store_signal_defs_opfs_10744e293342695c: function(arg0, arg1, arg2, arg3) {
            const ret = window.store_signal_defs_opfs(getArrayU8FromWasm0(arg0, arg1), getStringFromWasm0(arg2, arg3));
            return ret;
        },
        __wbg_store_signals_opfs_eed3729b60e70875: function(arg0, arg1, arg2, arg3) {
            const ret = window.store_signals_opfs(getArrayU8FromWasm0(arg0, arg1), getStringFromWasm0(arg2, arg3));
            return ret;
        },
        __wbg_store_source_file_content_opfs_6cea52f09e2839a9: function(arg0, arg1, arg2, arg3, arg4) {
            const ret = window.store_source_file_content_opfs(arg0 >>> 0, getArrayU8FromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
            return ret;
        },
        __wbg_store_source_file_info_3c1df8bbdf57e847: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10, arg11) {
            const ret = window.store_source_file_info(arg0 >>> 0, getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4), getStringFromWasm0(arg5, arg6), arg7 >>> 0, getArrayI32FromWasm0(arg8, arg9), getStringFromWasm0(arg10, arg11));
            return ret;
        },
        __wbg_text_d3a29f7525a132c3: function() { return handleError(function (arg0) {
            const ret = arg0.text();
            return ret;
        }, arguments); },
        __wbg_then_16d107c451e9905d: function(arg0, arg1, arg2) {
            const ret = arg0.then(arg1, arg2);
            return ret;
        },
        __wbg_then_6ec10ae38b3e92f7: function(arg0, arg1) {
            const ret = arg0.then(arg1);
            return ret;
        },
        __wbg_value_a5d5488a9589444a: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Closure(Closure { owned: true, function: Function { arguments: [Externref], shim_idx: 172, ret: Result(Unit), inner_ret: Some(Result(Unit)) }, mutable: true }) -> Externref`.
            const ret = makeMutClosure(arg0, arg1, wasm_bindgen__convert__closures_____invoke__hee2211cfdaee900c);
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000004: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./hwda_wasm_bg.js": import0,
    };
}

function wasm_bindgen__convert__closures_____invoke__hee2211cfdaee900c(arg0, arg1, arg2) {
    const ret = wasm.wasm_bindgen__convert__closures_____invoke__hee2211cfdaee900c(arg0, arg1, arg2);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

function wasm_bindgen__convert__closures_____invoke__h35ddfd5fbe18a0cc(arg0, arg1, arg2, arg3) {
    wasm.wasm_bindgen__convert__closures_____invoke__h35ddfd5fbe18a0cc(arg0, arg1, arg2, arg3);
}

const KdbStreamParserFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_kdbstreamparser_free(ptr, 1));
const WaveformDataProviderFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_waveformdataprovider_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

const CLOSURE_DTORS = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(state => wasm.__wbindgen_destroy_closure(state.a, state.b));

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function makeMutClosure(arg0, arg1, f) {
    const state = { a: arg0, b: arg1, cnt: 1 };
    const real = (...args) => {

        // First up with a closure we increment the internal reference
        // count. This ensures that the Rust closure environment won't
        // be deallocated while we're invoking it.
        state.cnt++;
        const a = state.a;
        state.a = 0;
        try {
            return f(a, state.b, ...args);
        } finally {
            state.a = a;
            real._wbg_cb_unref();
        }
    };
    real._wbg_cb_unref = () => {
        if (--state.cnt === 0) {
            wasm.__wbindgen_destroy_closure(state.a, state.b);
            state.a = 0;
            CLOSURE_DTORS.unregister(state);
        }
    };
    CLOSURE_DTORS.register(real, state, state);
    return real;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

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
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedInt32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
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

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('hwda_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
