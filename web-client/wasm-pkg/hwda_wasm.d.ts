/* tslint:disable */
/* eslint-disable */

export class KdbStreamParser {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Create a new streaming parser.
     */
    static create(kdb_id: string): KdbStreamParser;
    /**
     * Feed the complete compressed KDB data (including the 8-byte header).
     * Validates the magic number, decompresses, and parses the protobuf.
     * Call finalize() after this to free memory, then store_async() to persist.
     */
    feed_complete(data: Uint8Array): void;
    /**
     * Finalize: free the parsed data from memory (after store_async).
     * Returns the design name.
     */
    finalize(): string;
    /**
     * After feed_complete(), call this to store the parsed data to IndexedDB/OPFS.
     * Returns the design name on success.
     */
    store_async(): Promise<string>;
}

/**
 * Waveform data provider
 */
export class WaveformDataProvider {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Clear all cache data
     */
    clear_cache(): void;
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
     */
    fetch_and_get_segments(signal_names: string[]): Promise<any>;
    /**
     * Find transitions around a specific time for cursor snapping
     * Returns [prev_time, next_time] where null means no transition found
     * Note: BOUNDARY_TIME_START (0xFFFFFFFFFFFFFFFF) is excluded from results
     */
    find_transitions_around(signal_name: string, time: number): any;
    /**
     * Check if signal_data has data for the given signal
     * Returns an object with transition count and bucket count, or null if signal not found
     */
    getSignalDataStats(signal_name: string): any;
    /**
     * Returns the list of signal names the server reported as not found during
     * the last fetch. The UI uses this to drop signals that don't exist.
     * Built manually with js_sys to avoid any (de)serialization dependency.
     */
    get_not_found_signals(): any;
    /**
     * Get signal names (for testing)
     */
    get_signal_names(): any;
    /**
     * Get signal value at a specific time
     * Returns the value of the signal at the given time (from cached data)
     * If data is not cached, returns null
     * Handles BOUNDARY_TIME_START (0xFFFFFFFFFFFFFFFF) as the start-of-range value
     * display_format: optional display format override ("hex", "bin", "oct", "dec")
     */
    get_signal_value_at_time(signal_name: string, time: number, display_format?: string | null): any;
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
     */
    get_signal_values_at_transitions(signal_names: string[], search_start_time: bigint, search_end_time: bigint, result_max: number, signals_with_format: any, lod?: number | null, enable_opfs?: boolean | null, enable_memory_cache?: boolean | null, early_exit_on_insufficient_transitions?: boolean | null): Promise<any>;
    /**
     * Initialize with OPFS callbacks
     *
     * # Arguments
     * * `opfs_read` - JS callback: (path: string) -> Promise<Uint8Array | null>
     * * `opfs_write` - JS callback: (path: string, data: Uint8Array) -> Promise<()>
     * * `opfs_exists` - JS callback: (path: string) -> Promise<bool>
     * * `enable_opfs` - Whether to enable OPFS cache
     */
    init_with_opfs(opfs_read: Function, opfs_write: Function, opfs_exists: Function, enable_opfs: boolean): void;
    /**
     * Convert local signal name to server signal name
     * Step 1: Remove prefix (e.g., "work@tb_top.u_dut.signal" -> "tb_top.u_dut.signal")
     * Step 2: Add space before bracket if needed (e.g., "signal[7:0]" -> "signal [7:0]")
     * Note: No regex escaping needed for base64 encoding
     */
    local_to_server_name(local_name: string): string;
    /**
     * Create a new waveform data provider
     */
    constructor(server_url: string, waveform_name: string, signal_prefix: string, server_prefix: string, space_before_bracket: boolean, time_stamp: bigint);
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
     */
    prefetch_tiles(signal_names: string[]): Promise<void>;
    /**
     * Asynchronous prefetch that runs in a separate task without blocking render
     *
     * This function spawns a local async task to perform prefetch, allowing
     * render operations to continue in parallel.
     * OPFS and Memory cache are shared between render and prefetch via Arc.
     *
     * # Arguments
     * * `signal_names` - List of signal names to prefetch
     */
    prefetch_tiles_async(signal_names: string[]): void;
    /**
     * Set canvas dimensions
     * When width changes, adjust time_end to maintain the same time-to-pixel ratio
     * time_start remains fixed
     */
    set_canvas_dimensions(width: number, height: number, row_height: number): void;
    /**
     * Set signals with draw_sig_id (new API)
     *
     * # Arguments
     * * `signals_js` - Array of { global_id, name, row, width, draw_sig_id, display_format }
     */
    set_draw_list(signals_js: any): void;
    /**
     * Set memory cache enabled
     */
    set_memory_cache_enabled(enabled: boolean): void;
    /**
     * Set OPFS cache enabled (dynamic toggle)
     */
    set_opfs_enabled(enabled: boolean): void;
    /**
     * Set signals to render
     */
    set_signals(signals_js: any): void;
    /**
     * Set viewport
     */
    set_viewport(time_start: number, time_end: number): void;
    /**
     * Test signal name conversion (for debugging)
     */
    test_name_conversion(local_name: string): string;
    /**
     * Get current LoD based on viewport and canvas
     */
    readonly current_lod: number;
    /**
     * Get display format
     */
    display_format: string;
    /**
     * Get display unit per LoD0 unit (time conversion factor)
     */
    display_unit_per_lod0_unit: number;
    /**
     * Get memory cache enabled status
     */
    readonly memory_cache_enabled: boolean;
    /**
     * Get OPFS cache enabled status
     */
    readonly opfs_enabled: boolean;
    /**
     * Get server prefix
     */
    server_prefix: string;
    /**
     * Get server URL
     */
    readonly server_url: string;
    /**
     * Get signal prefix (local prefix)
     */
    signal_prefix: string;
    /**
     * Get space before bracket setting
     */
    space_before_bracket: boolean;
    /**
     * Get viewport time_end
     */
    readonly viewport_time_end: number;
    /**
     * Get viewport time_start
     */
    readonly viewport_time_start: number;
    /**
     * Get waveform name
     */
    readonly waveform_name: string;
}

/**
 * Parse KDB file and store directly to IndexedDB
 * Returns the design name on success
 */
export function parse_and_store_kdb(kdb_id: string, data: Uint8Array): Promise<string>;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_waveformdataprovider_free: (a: number, b: number) => void;
    readonly waveformdataprovider_clear_cache: (a: number) => void;
    readonly waveformdataprovider_current_lod: (a: number) => number;
    readonly waveformdataprovider_display_format: (a: number) => [number, number];
    readonly waveformdataprovider_display_unit_per_lod0_unit: (a: number) => number;
    readonly waveformdataprovider_fetch_and_get_segments: (a: number, b: number, c: number) => any;
    readonly waveformdataprovider_find_transitions_around: (a: number, b: number, c: number, d: number) => any;
    readonly waveformdataprovider_getSignalDataStats: (a: number, b: number, c: number) => any;
    readonly waveformdataprovider_get_not_found_signals: (a: number) => any;
    readonly waveformdataprovider_get_signal_names: (a: number) => any;
    readonly waveformdataprovider_get_signal_value_at_time: (a: number, b: number, c: number, d: number, e: number, f: number) => any;
    readonly waveformdataprovider_get_signal_values_at_transitions: (a: number, b: number, c: number, d: bigint, e: bigint, f: number, g: any, h: number, i: number, j: number, k: number) => any;
    readonly waveformdataprovider_init_with_opfs: (a: number, b: any, c: any, d: any, e: number) => void;
    readonly waveformdataprovider_local_to_server_name: (a: number, b: number, c: number) => [number, number];
    readonly waveformdataprovider_memory_cache_enabled: (a: number) => number;
    readonly waveformdataprovider_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: bigint) => number;
    readonly waveformdataprovider_opfs_enabled: (a: number) => number;
    readonly waveformdataprovider_prefetch_tiles: (a: number, b: number, c: number) => any;
    readonly waveformdataprovider_prefetch_tiles_async: (a: number, b: number, c: number) => void;
    readonly waveformdataprovider_server_prefix: (a: number) => [number, number];
    readonly waveformdataprovider_server_url: (a: number) => [number, number];
    readonly waveformdataprovider_set_canvas_dimensions: (a: number, b: number, c: number, d: number) => void;
    readonly waveformdataprovider_set_display_format: (a: number, b: number, c: number) => void;
    readonly waveformdataprovider_set_display_unit_per_lod0_unit: (a: number, b: number) => void;
    readonly waveformdataprovider_set_draw_list: (a: number, b: any) => [number, number];
    readonly waveformdataprovider_set_memory_cache_enabled: (a: number, b: number) => void;
    readonly waveformdataprovider_set_opfs_enabled: (a: number, b: number) => void;
    readonly waveformdataprovider_set_server_prefix: (a: number, b: number, c: number) => void;
    readonly waveformdataprovider_set_signal_prefix: (a: number, b: number, c: number) => void;
    readonly waveformdataprovider_set_signals: (a: number, b: any) => [number, number];
    readonly waveformdataprovider_set_space_before_bracket: (a: number, b: number) => void;
    readonly waveformdataprovider_set_viewport: (a: number, b: number, c: number) => void;
    readonly waveformdataprovider_signal_prefix: (a: number) => [number, number];
    readonly waveformdataprovider_space_before_bracket: (a: number) => number;
    readonly waveformdataprovider_test_name_conversion: (a: number, b: number, c: number) => [number, number];
    readonly waveformdataprovider_viewport_time_end: (a: number) => number;
    readonly waveformdataprovider_viewport_time_start: (a: number) => number;
    readonly waveformdataprovider_waveform_name: (a: number) => [number, number];
    readonly __wbg_kdbstreamparser_free: (a: number, b: number) => void;
    readonly kdbstreamparser_create: (a: number, b: number) => number;
    readonly kdbstreamparser_feed_complete: (a: number, b: number, c: number) => [number, number];
    readonly kdbstreamparser_finalize: (a: number) => [number, number, number, number];
    readonly kdbstreamparser_store_async: (a: number) => any;
    readonly parse_and_store_kdb: (a: number, b: number, c: number, d: number) => any;
    readonly wasm_bindgen__convert__closures_____invoke__hee2211cfdaee900c: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h35ddfd5fbe18a0cc: (a: number, b: number, c: any, d: any) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
