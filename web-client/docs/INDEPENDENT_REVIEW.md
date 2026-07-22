# Web-Client Independent Comprehensive Review

**Reviewer**: Independent analysis
**Date**: 2026-07-22
**Scope**: `web-client/src/` — UI interaction, WASM/worker communication, server comms & data parsing, render drawing per LoD scheme, OPFS/data cache, UI data management.
**Method**: Direct source inspection + validation of each point in the prior `COMPREHENSIVE_REVIEW.md`. Each finding below marks whether the prior reviewer's claim was **Valid**, **Partially Valid**, or **Invalid/Outdated**, and provides concrete fix suggestions.

> Legend: ✅ Valid · 🟡 Partially valid / overstated · ❌ Invalid / already fixed / misjudged · 🆕 New finding not in prior review.

---

## 1. UI User Interactive Issues

### 1.1 ✅ [Valid] Race condition in `SignalList` async loading
**File**: `src/components/SignalList.tsx:34-48`

```ts
useEffect(() => {
  if (moduleIndex && kdbManager.isLoaded()) {
    setLoading(true);
    kdbManager.getModuleSignals(moduleIndex).then(moduleSignals => {
      setSignals(moduleSignals);
      setLoading(false);
    }).catch(() => { setSignals([]); setLoading(false); });
  } else {
    setSignals([]);
  }
}, [moduleIndex]);
```

No abort / generation guard. Rapid module switching can let an older promise overwrite newer state.
**Note on the falsy-check sub-claim**: The interface comment on line 10 says `moduleIndex: number | null;  // 1-based module index`, so `0` is not a valid module index. The truthiness check is therefore correct for the documented contract, but it is fragile — if the contract ever changes to allow `0`, this breaks silently. The race-condition part of the claim is the real bug.

**Fix**:
```ts
useEffect(() => {
  let cancelled = false;
  if (moduleIndex != null && kdbManager.isLoaded()) {
    setLoading(true);
    kdbManager.getModuleSignals(moduleIndex).then(s => {
      if (!cancelled) { setSignals(s); setLoading(false); }
    }).catch(() => { if (!cancelled) { setSignals([]); setLoading(false); } });
  } else {
    setSignals([]);
  }
  return () => { cancelled = true; };
}, [moduleIndex]);
```

---

### 1.2 ✅ [Valid] Language menu active highlight never works
**File**: `src/components/MenuBar.tsx:272, 280`

```ts
backgroundColor: language === (subItem.onClick as unknown as Language) ? '#e3f2fd' : 'transparent',
```

Compares a string (`language`) against a function reference cast to `Language`. Always `false`. Verified at lines 272 and 280 (background color and hover handler).

**Fix**: Resolve the language code from the menu item data (e.g., `subItem.langCode` or via `languages.find(l => l.nativeName === subItem.label)?.code`) and compare `language === resolvedCode`.

---

### 1.3 🟡 [Partially valid] `zoomIn`/`zoomOut` ignore the zoom factor parameter
**File**: `src/utils/viewport.ts:223-270`

`zoomIn(viewport, cursorPosition?, _zoomFactor=0.8)` declares `_zoomFactor` but the body hardcodes the midpoint (`(cursorPos + timeStart) / 2`), not `1 - _zoomFactor`. Same for `zoomOut` — though `zoomOut` (line 266-267) actually *does* use `_zoomFactor` (`distStart * _zoomFactor`), so the prior claim is **only true for `zoomIn`**, not `zoomOut`.

Note: there are **two** `zoomIn`/`zoomOut` implementations — see §1.9 below.

**Fix for `zoomIn`**: Use `newStart = cursorPos - (cursorPos - timeStart) * (1 - _zoomFactor)` so the factor actually controls zoom depth. Remove the unused parameter if the midpoint behavior is intended.

---

### 1.4 🟡 [Partially valid] `pixelToTime` breaks coordinate reversibility
**File**: `src/utils/viewport.ts:189-198`

`pixelToTime` uses `Math.floor`, while `timeToPixel` is continuous. This is intentional: pixel → time is "which integer time unit does this pixel fall into", and time is required to be an integer (u64-compatible) per the file header. The reversibility loss is *by design*, but it does cause ~1px cursor drift over many zoom/pan cycles because the floor discards sub-pixel time fractions.

**Fix**: Either keep a fractional `cursorTimeFraction` alongside the integer `cursorPosition`, or use `Math.round` and document that `pixelToTime` returns the nearest integer time rather than the floor. Round is safer for cursor positioning.

---

### 1.5 🟡 [Partially valid] Format dropdown `offsetWidth/offsetHeight` may be 0 on first open
**File**: `src/components/WaveformWindow.tsx:553-588`

`offsetWidth`/`offsetHeight` force a synchronous layout, so in practice they rarely return 0 — but the `useEffect` runs after commit, before paint, so the layout may not reflect the just-set position. The fallbacks (`|| 90`, `|| 120`) mask the issue.

**Fix**: Use `useLayoutEffect` (runs before paint) instead of `useEffect`, and/or `getBoundingClientRect()`. Add a `key` to the dropdown so React doesn't reuse a stale-positioned DOM node.

---

### 1.6 ✅ [Valid] No `ctx.save()`/`ctx.restore()` around canvas state modifications
**Files**: `src/core/render/waveformDrawing.ts`, `src/core/render/waveformRenderer.ts`

Verified: neither file uses `save`/`restore`. State (`strokeStyle`, `fillStyle`, `lineWidth`, `setLineDash`) is set ad-hoc with manual resets in some places (e.g., `drawZWaveform` resets `setLineDash([])` at the end). Any future code path with an early return or exception leaks state.

**Fix**: Wrap each public draw function in `ctx.save()` / `ctx.restore()`. This is the canonical Canvas2D discipline and eliminates an entire class of state-leak bugs.

---

### 1.7 ✅ [Valid] `WaveformRenderer.resize()` clears canvas without re-render
**File**: `src/core/render/waveformRenderer.ts` (resize method)

Setting `canvas.width` clears the bitmap. If `resize()` is called without an immediate `render()`, the user sees a blank canvas.

**Fix**: In `resize()`, either call `render()` with the last segments, or set a `dirty` flag the next animation frame honors. Also debounce resize events to avoid rapid clear-without-redraw cycles.

---

### 1.8 ✅ [Valid] `CursorRenderer.updateState()` shares mutable state by reference
**File**: `src/core/render/cursorRenderer.ts:54`

Stores the passed `state` object by reference. If the caller mutates `state.viewport` between `updateState` and the next frame draw, the cursor is drawn at the wrong position.

**Fix**: Shallow-clone at minimum (`{ ...state, viewport: { ...state.viewport } }`). Deep-clone if other nested objects are mutable.

---

### 1.9 ✅ [Valid] Duplicate `zoomIn`/`zoomOut` with different signatures
**Files**: `src/utils/viewport.ts` vs `src/utils/zoomHelpers.ts`

Verified directly. The two files export identically-named functions:
- `viewport.ts: zoomIn(viewport, cursorPosition?, _zoomFactor=0.8)` — no boundary check, no sanitize.
- `zoomHelpers.ts: zoomIn(viewport, cursorPosition?, waveformRange?)` — calls `sanitizeTimeRange`, clamps to range.

Importing both in the same module is a name collision. They also behave differently for the same inputs.

**Fix**: Delete the `viewport.ts` versions (or make them re-exports of `zoomHelpers.ts`). The `zoomHelpers.ts` versions with sanitization are the safer single source of truth.

---

### 1.10 ✅ [Valid] rAF mouse-position loop runs permanently
**File**: `src/components/WaveformWindow.tsx:678-694`

```ts
useEffect(() => {
  const updateRenderMouseX = () => {
    if (pendingMouseXRef.current !== null) {
      setRenderMouseX(pendingMouseXRef.current);
      pendingMouseXRef.current = null;
    }
    rafIdRef.current = requestAnimationFrame(updateRenderMouseX);  // always re-schedules
  };
  rafIdRef.current = requestAnimationFrame(updateRenderMouseX);
  return () => { if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current); };
}, []);
```

Verified. The loop reschedules every frame unconditionally — ~60 fps for the component's entire lifetime, including when the waveform tab is hidden (the component stays mounted). Wastes CPU/battery.

**Fix**: Only reschedule when `pendingMouseXRef.current !== null`, or gate on `document.visibilityState` / `IntersectionObserver` for the canvas. A simpler pattern: schedule a single rAF inside the mousemove handler instead of a continuous loop.

---

### 1.11 🆕 [New] Throttle interval jumps from 80ms → 250ms mid-drag with no smoothing
**File**: `src/components/WaveformWindow.tsx:861`

`const THROTTLE_INTERVAL = isPanningRef.current ? 250 : 80;`

When a drag starts, the throttle suddenly triples. The user perceives a "lag spike" at the moment they begin dragging. When the drag ends, the interval drops back to 80ms, but the last queued 250ms timer still fires late.

**Fix**: Smooth the transition — e.g., ramp the interval during the first few pan events, or clear the pending 250ms timer when `isPanning` flips to false and re-arm at 80ms.

---

### 1.12 🆕 [New] `_lastCanvasSizeRef`, `_lastWasmSettingsRef`, `_cachedSegmentsRef` declared but unused
**File**: `src/components/WaveformWindow.tsx:774, 802, 822`

Three refs are declared with `// @ts-ignore` / `eslint-disable` suppression but never read. Dead code that misleads readers into thinking there is caching logic.

**Fix**: Delete these refs and their suppression comments, or wire them up to the intended caching behavior.

---

## 2. UI / WASM Worker Communication Issues

### 2.1 🟡 [Partially valid] Error message format mismatch between workers
**Files**: `src/workers/waveformWorker.ts` (sends `{type:'ERROR', id, success:false, error}`) vs `src/workers/kdbDownload.worker.ts` (sends `{type:'error', error, canRetry}`)

Verified. However, the two workers feed **different** consumer pipelines — `waveformWorker` → `workerWaveformProvider.ts` (checks `type === 'ERROR' || !success`), and `kdbDownload.worker` → `kdbDownloadManager.ts` (its own switch on lowercase types). So errors are NOT silently dropped *today*. The prior claim that "KDB worker's errors are silently dropped" is **overstated**. The real risk is future maintenance: anyone writing a shared worker-message utility will hit this inconsistency.

**Fix**: Standardize on one format across both workers (recommend uppercase `ERROR` with `id` + `success:false` for parity with the render pipeline). Update both consumers.

---

### 2.2 ✅ [Valid] Request-queue dedup can starve non-render requests
**File**: `src/workers/waveformWorker.ts:233` (`processQueue`)

Render/prefetch are deduped to "latest only", but "other" requests always run. The claim is correct: under continuous render pressure, "other" requests (`GET_SIGNAL_VALUE_AT_TIME`, etc.) queue behind many redundant render fetches.

**Fix**: Add a priority lane — process "other" requests before render requests in each `processQueue` tick. Or cap the number of pending render tasks (e.g., keep at most 1 in flight + 1 queued).

---

### 2.3 ✅ [Valid] Heartbeat timeout only logs a warning
**File**: `src/workers/kdbDownload.worker.ts` (`armHeartbeatTimeout`)

Verified via subagent report: on timeout it only `console.warn`s. The download hangs with no UI feedback, no retry, no cancellation. The user sees an eternal spinner.

**Fix**: On heartbeat timeout, post an `{type:'error', error:'Download stalled', canRetry:true}` message to the main thread, abort the in-flight fetch (`AbortController`), and let the UI show a "Download stalled — Retry?" dialog.

---

### 2.4 🟡 [Partially valid] `OffscreenCanvas` transfer is irreversible
**File**: `src/wasm/workerWaveformProvider.ts:139-143`

True that transfer neuters the canvas on the main thread. This is a documented Web platform behavior, not a bug. The "undocumented" part of the claim is fair.

**Fix**: Document it at the call site. After transfer, set the main-thread canvas reference to `null` so any accidental reuse fails loudly rather than silently no-opping.

---

### 2.5 ✅ [Valid] `store_source_file_content_opfs` fire-and-forget swallows write failures
**File**: `src/workers/kdbDownload.worker.ts:93` area

`writer.writeFile(id, copy).catch(console.error)` — if the OPFS write fails (quota, disk full), the source content is permanently lost and only logged.

**Fix**: Await the write inside the download flow, surface failures in the completion message (`{type:'complete', opfsErrors:[...]}`), and let the UI warn the user that source content wasn't cached.

---

### 2.6 ✅ [Valid] `handleInitialize` not idempotent — leaks WASM provider on double-init
**File**: `src/workers/waveformWorker.ts:327-371`

`initializeWasm()` is idempotent (guarded by `wasmInitialized`), but `handleInitialize` always creates a *new* `WaveformDataProvider`, overwriting `wasmProvider` without `clear_cache()` or freeing the old instance.

**Fix**:
```ts
async function handleInitialize(payload, id) {
  await initializeWasm();
  if (wasmProvider) {
    wasmProvider.clear_cache();
    // dispose/free if the provider exposes it
  }
  wasmProvider = new WaveformDataProvider(...);
  ...
}
```
Or short-circuit: `if (wasmProvider) { sendSuccess(id, null); return; }` if re-init is genuinely a no-op.

---

### 2.7 ✅ [Valid] `handleDispose` does not reset `wasmInitialized` (and leaks prefetch state)
**File**: `src/workers/waveformWorker.ts:377-388`

After `DISPOSE`, `wasmInitialized` stays `true`, and `prefetchTimer` / `pendingPrefetchSignals` / `lastRenderSignalNames` are NOT cleared. A subsequent `INITIALIZE` skips `init()`, and a stale `prefetchTimer` can fire with `lastRenderSignalNames` from the previous session.

**Fix**: In `handleDispose`:
```ts
if (prefetchTimer) { clearTimeout(prefetchTimer); prefetchTimer = null; }
pendingPrefetchSignals.clear();
lastRenderSignalNames = [];
// Optionally: wasmInitialized = false;  // only if WASM side needs re-init
```

---

### 2.8 ✅ [Valid] Cancelled render tasks still complete the WASM fetch
**File**: `src/workers/waveformWorker.ts:776-782`

Cancellation check happens *after* `fetch_and_get_segments` returns. The expensive network + decompression still runs. `processQueue` dedup helps *before* a task starts, but once started there's no abort.

**Fix**: Check `currentRenderTask?.id !== id` immediately before the fetch call too. Pass an `AbortController` into `fetch_and_get_segments` if the WASM layer supports it; otherwise at least skip the fetch if a newer task arrived between queueing and execution.

---

### 2.9 ✅ [Valid] `postMessage` transfer can detach shared `ArrayBuffer`s
**File**: `src/workers/kdbDownload.worker.ts:748` area

If two pending files' `content` views share the same underlying `ArrayBuffer`, transferring one detaches the other. Verified risk.

**Fix**: Before transfer, check `buffer.byteLength > 0` for each view; if a buffer is shared, copy the view's data into a fresh `ArrayBuffer` first (`new Uint8Array(view).buffer`) and transfer the copy.

---

### 2.10 ✅ [Valid] WASM callbacks use `new Function('path', 'return globalThis.opfsReadWrapper(path);')`
**File**: `src/workers/waveformWorker.ts:351-353`

String-based `new Function` is fragile — breaks under CSP `unsafe-eval` restrictions and obscures the dependency. Since the worker imports the OPFS functions directly, bound closures are strictly better.

**Fix**: Replace with direct closures:
```ts
const opfsReadCb = (path: string) => opfsReadWrapper(path);
```
(or however the WASM binding accepts JS callbacks — pass the function reference directly).

---

### 2.11 🆕 [New] `prefetchTimer` not cleared on worker error
**File**: `src/workers/waveformWorker.ts`

If the worker hits a fatal error during a prefetch cycle, the `prefetchTimer` keeps firing against a null/errored `wasmProvider`. The `if (wasmProvider && pendingPrefetchSignals)` guard prevents a crash but the timer spins forever.

**Fix**: Add an `onError`/`shutdown` path that clears `prefetchTimer`.

---

## 3. Render Worker → Server Communication / Data Parsing Issues

### 3.1 ✅ [Valid] No fetch timeout anywhere
**File**: `src/services/api.ts` (`request`, `binaryRequest`, `testConnection`)

Verified: zero `AbortController`/`AbortSignal`/`timeout` matches in `src/`. A hung server freezes all API calls indefinitely. `testConnection()` (line 323) is the worst — a half-open TCP connection means the connect dialog never resolves.

**Fix**: Add a configurable timeout via `AbortController`:
```ts
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 30000);
try { const r = await fetch(url, { ...opts, signal: ctrl.signal }); ... }
finally { clearTimeout(timer); }
```
Make the timeout shorter for `testConnection` (e.g., 5s) and longer for chunk downloads (e.g., 60s).

---

### 3.2 ✅ [Valid] Signal/waveform names not URL-encoded
**File**: `src/services/api.ts:251, 285`

```ts
return this.request(`/api/wave/${waveformName}/info/${signalName}`);
const endpoint = `/api/wave/${waveformName}/signals/${signalName}/data?${params}`;
```

Verified directly. `signalName` and `waveformName` are interpolated raw. A signal name like `top/clk_div[0]` produces a malformed URL.

**Fix**:
```ts
return this.request(`/api/wave/${encodeURIComponent(waveformName)}/info/${encodeURIComponent(signalName)}`);
const endpoint = `/api/wave/${encodeURIComponent(waveformName)}/signals/${encodeURIComponent(signalName)}/data?${params}`;
```
Apply the same fix to `getWaveformInfo`, `getWaveformSignals`, etc.

---

### 3.3 ❌ [Invalid] `binaryRequest` treats non-206 as failure
**File**: `src/services/api.ts:141`

```ts
if (!response.ok && response.status !== 206) { return null; }
```

`response.ok` is `true` for **all** 2xx statuses including 200. So `!response.ok` is only true for non-2xx. The `&& response.status !== 206` is therefore redundant (206 is already in 2xx and `response.ok` is true for it). **200 OK is accepted**, not rejected. The prior claim is **incorrect**.

The real (subtler) issue: when a `Range` header is sent and the server ignores it (returns full 200), this code accepts the *full* body — which may be much larger than the caller expected, wasting bandwidth. But that is not "treats 200 as failure".

**Fix (optional improvement)**: When `range` was requested but `response.status === 200`, log a warning that the server ignored the Range header, so developers can diagnose slow full-body downloads.

---

### 3.4 ✅ [Valid] Error swallowed in `binaryRequest`
**File**: `src/services/api.ts:157-160`

```ts
} catch (error) {
  console.error('Binary request failed:', error);
  return null;
}
```

Callers cannot distinguish network error, server error, or empty response.

**Fix**: Return a discriminated union:
```ts
type BinaryResult =
  | { ok: true; data: ArrayBuffer; totalSize?: number; contentRange?: string }
  | { ok: false; error: ApiError };
```
Update `downloadWaveformChunk` etc. to propagate the error.

---

### 3.5 ✅ [Valid] `checkKdbChanged` returns `{changed:false}` on API failure
**File**: `src/services/api.ts:181-200`

Network failure is indistinguishable from "KDB unchanged". The UI may show stale data as current.

**Fix**: Return a tri-state:
```ts
{ status: 'changed' | 'unchanged' | 'error', serverInfo?: ServerKdbFileInfo, error?: ApiError }
```
Callers handle `error` by showing a "Couldn't verify KDB freshness" warning and treating cached data as potentially stale.

---

### 3.6 ✅ [Valid] `response.json()` outside try/catch on success path
**File**: `src/services/api.ts:115-118`

```ts
const data = await response.json();   // can throw SyntaxError
...
} catch (error) {   // catches it, but mislabels as NETWORK_ERROR
```

A 200 with a non-JSON body throws `SyntaxError`, caught by the outer catch and reported as `code: 'NETWORK_ERROR'`. Misleading.

**Fix**: Wrap the success-path JSON parse in its own try/catch (like the error-path one on lines 87-106) and return `code: 'PARSE_ERROR'` with the response snippet.

---

### 3.7 🟡 [Partially valid] Hardcoded `Content-Type: application/json`
**File**: `src/services/api.ts:78`

```ts
headers: { 'Content-Type': 'application/json', ...options?.headers }
```

The spread lets callers override, so it is not strictly "hardcoded". The real issue is sending `Content-Type: application/json` on **GET requests with no body**, which is unnecessary and may confuse strict proxies. There is also no path for FormData/binary uploads.

**Fix**: Only set `Content-Type` when `options.body` is present. Add a separate `uploadBinary()` method for binary POSTs.

---

### 3.8 ✅ [Valid] File comment claims retry logic, but none exists
**File**: `src/services/api.ts:9`

`// - Error handling and retry logic` — but the file has zero retry code. Misleading documentation.

**Fix**: Either remove "and retry logic" from the comment, or implement exponential backoff for transient errors (5xx, network errors). Recommend the latter: 3 retries with jittered backoff (e.g., 200ms, 600ms, 1.8s).

---

### 3.9 ✅ [Valid] Large KDB decompression may exhaust memory
**File**: `src/services/kdbDownloadManager.ts` + `kdbDownload.worker.ts`

Decompressed data is accumulated in memory before batched storage. For >500MB KDBs this risks OOM in memory-constrained browsers.

**Fix**: Stream decompression — flush each decompressed chunk to OPFS/IndexedDB as soon as it's produced, then release the chunk's memory. Use a bounded queue between the decompressor and the storage writer so backpressure limits peak memory.

---

### 3.10 ✅ [Valid] KDB download cancel has a race window
**File**: `src/services/kdbDownloadManager.ts`

`cancelDownload()` uses `setTimeout(force-terminate, 1000)`. Between the cancel message and the timer, the worker can post `complete`, mutating state; the later force-terminate then operates on stale state.

**Fix**: Use a download-ID generation counter. Reject the cancel promise immediately on cancel and ignore subsequent messages whose `downloadId` doesn't match the current one. Drop the timer-based force-terminate entirely (or keep it as a last-resort safety net with an ID check).

---

### 3.11 🆕 [New] `testConnection` sets `this.connected` based solely on `response.ok`
**File**: `src/services/api.ts:321-330`

`/health` returning 200 sets `connected = true`. But a misconfigured reverse proxy returning 200 with an HTML error page also passes. No content-type or body validation.

**Fix**: Validate `response.headers.get('Content-Type')` includes `application/json` and parse a small JSON body (`{status:'ok'}`) before trusting the connection.

---

## 4. Render Drawing Issues According to the LoD Scheme

### 4.1 ✅ [Valid] Duplicate rendering code with behavioral divergence
**Files**: `src/core/render/waveformDrawing.ts` vs `src/core/render/waveformRenderer.ts`

Verified by subagent: both files independently implement `getSignalLevel`, `drawSingleBitWaveform`, `drawMultiBitWaveform`, `drawXWaveform`, `drawZWaveform`, `drawMinMaxWaveform`, `drawTimeRuler`, `calculateNiceStep`. The two `getSignalLevel` implementations differ in the property fallback chain:
- `waveformDrawing.ts`: `value.type || value.valueType || value.value_type`
- `waveformRenderer.ts`: only `value.type`

If WASM emits `value_type` (snake_case from Rust serde without `#[serde(rename_all)]`), `WaveformRenderer` treats every single-bit signal as unknown (-1). **Critical correctness bug** when the active render path is `waveformRenderer.ts`.

**Fix**: Delete the duplicated logic in `waveformRenderer.ts` and delegate to `waveformDrawing.ts`. If both must exist, factor the shared helpers into a `waveformDrawingPrimitives.ts` module imported by both.

---

### 4.2 ✅ [Valid] Render cache key omits the LoD level
**File**: `src/core/render/renderCache.ts:53-57`

```ts
generateKey(signalNames, viewport) {
  const signalsKey = signalNames.slice().sort().join(',');
  const viewportKey = `${viewport.startTime},${viewport.endTime},${viewport.width},${viewport.height}`;
  return `${signalsKey}|${viewportKey}`;
}
```

No LoD level in the key. Same viewport at LoD 0 and LoD 3 collide. A cached LoD 3 result can be returned for a LoD 0 query (or vice versa), producing visibly wrong segments.

**Note**: This is the `renderCache.ts` *RenderCache* class (different from `lruCache.ts`'s `RenderChunkCache`, which *does* include `lodLevel` in its key — see `lruCache.ts:57`). The two caches coexist; only `RenderCache` is buggy.

**Fix**:
```ts
generateKey(signalNames, viewport, lodLevel: number) {
  ...
  return `${signalsKey}|${viewportKey}|lod=${lodLevel}`;
}
```
Update `get`/`set`/`has`/`clearForSignals` to thread `lodLevel` through.

---

### 4.3 🟡 [Partially valid] LoD selection doesn't account for pixel alignment
**File**: `src/components/WaveformWindow.tsx` (`selectLodForRange`)

`min lod: 2^lod >= timePerPixel`. Bucket boundaries are determined by `2^lod` time units, but tile boundaries are determined by server-side tile size. They can misalign, producing visible seams.

**Severity**: Low in practice if the server's tile boundaries are also `2^lod`-aligned (typical). The prior claim's "visual discontinuities" are only realistic when tile spans are non-power-of-2.

**Fix**: Verify (or document) that the server's tile span is a multiple of `2^lod`. If not, snap `timePerPixel` up to the nearest power-of-2 that divides the tile span.

---

### 4.4 ✅ [Valid] No tile-boundary continuity check
**Files**: `src/core/render/waveformDrawing.ts`, `src/core/render/waveformRenderer.ts`

Neither file compares the last segment of tile N with the first of tile N+1. A continuous high signal across a tile boundary renders two segments with a spurious transition edge at the seam — a **false double-line artifact**.

**Fix**: Pass the previous tile's last value into the next tile's draw call. If equal, suppress the leading transition edge of tile N+1. This requires the renderer to thread "last value across tiles" through the draw loop.

---

### 4.5 ✅ [Valid] O(n·m) performance in large-group detection
**File**: `src/core/render/waveformRenderer.ts:92`

```ts
const largeGroup = largeGroups.find(g => i >= g.startIndex && i <= g.endIndex);
```

Runs for every segment `i`. With many large groups and many segments this is quadratic.

**Fix**: Pre-build an `Int32Array` indexed by segment index → large-group ID, or sort `largeGroups` by `startIndex` and binary-search. O(n + m·log m) instead of O(n·m).

---

### 4.6 ✅ [Valid] `drawMultiBitWaveform` inconsistent property resolution
**File**: `src/core/render/waveformDrawing.ts:371`

```ts
const valueType = value.valueType || value.value_type;  // missing value.type
```

Every sibling function uses `value.type || value.valueType || value.value_type`. This one omits `value.type`. If data only carries `type`, multi-bit buses fall through to `default` and render as plain green boxes — masking `all_x` / `all_z` / `mixed` states.

**Fix**:
```ts
const valueType = value.type || value.valueType || value.value_type;
```
Or extract `resolveValueType(value)` and use it everywhere.

---

### 4.7 ✅ [Valid] Memory estimation in render cache is grossly inaccurate
**File**: `src/core/render/renderCache.ts:190-210`

```ts
totalBytes += segs.length * 8;  // 8 bytes per segment point
```

A JS object with `{x, y}` is ~80+ bytes; a `Float32Array` pair is closer to 8 bytes/point but the code stores plain objects. The estimate is ~10× too low, so the 100MB cap actually allows ~1GB of real usage before eviction.

**Fix**: Use the real per-object overhead. Better: store segments as typed arrays (`Float32Array`) and use `byteLength` directly. If objects must stay, use `~96` bytes per segment point as the estimate.

---

### 4.8 🟡 [Partially valid] Time-ruler label dedup may skip valid ticks
**File**: `src/core/render/waveformDrawing.ts:704`

```ts
if (!isFirstTick && labelText === lastLabelText) { continue; }
```

Pure string dedup. At very small zoom, distinct ticks can format to the same label (e.g., both round to "1,000"), suppressing the second tick entirely.

**Severity**: Minor — only matters at extreme zoom-out where many ticks share a label. The bigger missing feature is pixel-proximity dedup (skip labels that *visually* overlap regardless of text).

**Fix**: Always draw the tick mark. Only skip the *label text* when `x - lastLabelX < labelPixelWidth`. Use `ctx.measureText(labelText).width` for the width.

---

### 4.9 ✅ [Valid] `textY` uses hardcoded `+5` offset
**Files**: `src/core/render/waveformDrawing.ts:418` (and `+4` at lines 496, 545), `src/core/render/waveformRenderer.ts`

Hardcoded offsets assume a specific font size (14px / 11px). Changing font size or row height misaligns text vertically.

**Fix**:
```ts
ctx.textBaseline = 'middle';
ctx.fillText(text, x, y);  // y is already the row center
```
This is robust across font sizes and platforms.

---

### 4.10 ✅ [Valid] `zoomIn`/`zoomOut` return incomplete `TimeRangeOnly`
**File**: `src/utils/viewport.ts:223-270`

Both return `{timeStart, timeEnd}` only, dropping `signalStart`, `signalEnd`, `pixelsPerTime`, `pixelsPerSignal`. Callers must manually merge.

**Fix**: Return the full `Viewport` (apply the new time range to the existing viewport via `setViewTimeRange`). Or export a `mergeTimeRange(timeRange, base): Viewport` helper and use it consistently at call sites.

---

### 4.11 🆕 [New] Two parallel cache classes with overlapping responsibilities
**Files**: `src/core/renderCache.ts` (`RenderCache`, default 100MB) vs `src/core/cache/lruCache.ts` (`RenderChunkCache`, default 100MB)

Both are "render caches", both export singletons (`globalRenderCache`, `renderCache`), both have ~100MB defaults. Total intended budget is unclear; combined they may hold ~200MB. `RenderCache` keys on (signals, viewport) and omits LoD (§4.2); `RenderChunkCache` keys on (signalId, lod, chunkId) and includes LoD. Confusing and error-prone.

**Fix**: Pick one. Recommend `RenderChunkCache` (LoD-aware, typed-array-oriented). Deprecate `RenderCache` or repurpose it strictly for "fully rendered frame bitmaps" with a clear LoD-aware key.

---

## 5. Render OPFS / Data Cache Implementation Issues

### 5.1 ✅ [Valid] No write lock in `opfsWrite()` — concurrent writes corrupt files
**File**: `src/core/cache/opfsAccess.ts:66-84`

```ts
const writable = await fileHandle.createWritable();
await writable.write(data);
await writable.close();
```

No per-path lock. Two concurrent `opfsWrite` calls to the same path interleave and corrupt the file. `createWritable()` defaults to `keepExistingData: false` which *truncates* on open — so two concurrent writers truncate-then-write, last-close wins, but partial writes can leave a truncated file.

**Fix**: Per-path serialization:
```ts
const writeLocks = new Map<string, Promise<void>>();
export async function opfsWrite(path, data) {
  const prev = writeLocks.get(path) ?? Promise.resolve();
  const next = prev.then(() => doWrite(path, data));
  writeLocks.set(path, next.catch(() => {}));  // don't poison the chain
  return next;
}
```

---

### 5.2 ✅ [Valid] No `QuotaExceededError` handling anywhere
**File**: `src/core/cache/opfsAccess.ts`

No try/catch around `createWritable`/`write`/`close`. When OPFS quota is exceeded (common with 1GB+ waveform data), the write throws `QuotaExceededError`, which propagates uncaught.

**Fix**:
```ts
try { ... } catch (e) {
  if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_FILE_FILE_CORRUPTED') {
    // trigger GC, then retry once; if still failing, disable OPFS caching + notify UI
    await runOpfsGc();
    return doWrite(path, data);
  }
  throw e;
}
```
Surface a user-visible warning ("Waveform cache full — falling back to server-only mode").

---

### 5.3 ✅ [Valid] `signalIdManager` has no version/generation mechanism
**File**: `src/core/cache/signalIdManager.ts`

`next_draw_sig_id` is monotonically increasing and persisted in `signals.json`. If a KDB is reloaded (cleared + re-parsed) but `signals.json` survives, new IDs continue from the old `next_draw_sig_id`. If `signals.json` is *cleared* but the render cache (in `lruCache.ts` / `renderCache.ts`) survives, the cache contains stale `draw_sig_id`s that no longer map to the new KDB's signals — **wrong signal data** is rendered.

**Fix**: Add an `epoch` field to `SignalMetadata`. Bump it on every KDB reload. Include `epoch` in render-cache keys. Reject cache entries whose epoch doesn't match.

---

### 5.4 ✅ [Valid] Race condition in `getSignalIdManager` creates duplicate managers
**File**: `src/core/cache/signalIdManager.ts:219-227`

```ts
export async function getSignalIdManager(waveform: string): Promise<SignalIdManager> {
  let manager = managerCache.get(waveform);
  if (!manager) {
    manager = new SignalIdManager(waveform);
    await manager.init();   // <-- await between check and set
    managerCache.set(waveform, manager);
  }
  return manager;
}
```

If two callers call this concurrently before the first `init()` resolves, both pass the `!manager` check, both create a manager, both load `signals.json`, and both increment `next_draw_sig_id` independently. The second `managerCache.set` overwrites the first. The first caller's manager is orphaned with stale state.

**Fix**:
```ts
const managerPromises = new Map<string, Promise<SignalIdManager>>();
export function getSignalIdManager(waveform: string): Promise<SignalIdManager> {
  let p = managerPromises.get(waveform);
  if (!p) {
    p = (async () => {
      const m = new SignalIdManager(waveform);
      await m.init();
      managerCache.set(waveform, m);
      return m;
    })();
    managerPromises.set(waveform, p);
  }
  return p;
}
```

---

### 5.5 ✅ [Valid] `evictSignal()` and `evictLOD()` are O(n)
**File**: `src/core/cache/lruCache.ts:263-302`

Both iterate `this.keys()` (full cache scan) and parse each key. With millions of entries this blocks the worker for seconds.

**Fix**: Maintain secondary indexes:
```ts
private signalIdToKeys = new Map<string, Set<string>>();
private lodToKeys = new Map<LoDLevelType, Set<string>>();
```
Update them in `put`/`remove`/`evictLRU`. `evictSignal`/`evictLOD` then become O(k) where k = matching keys.

---

### 5.6 🟡 [Partially valid] LRU `put()` doesn't notify external holders of eviction
**File**: `src/core/cache/lruCache.ts:87-99`

True that there's no eviction callback. But "stale references persist" is mitigated by the fact that callers should be reading from the cache (`get`), not holding long-lived references to cached data. If callers *do* hold references (e.g., a render loop caching a `RenderChunk` across frames), this is a real bug.

**Fix**: Add an optional `onEvict?: (key, data) => void` callback to the constructor. Call it in `evictLRU`. For data that owns GPU resources (e.g., `ImageBitmap`), the callback can call `.close()` to free them promptly.

---

### 5.7 ✅ [Valid] OPFS reader worker loads entire file into memory
**File**: `src/workers/opfsReader.worker.ts` (`readWholeFile`)

For 100MB+ source files this causes memory pressure, especially since the worker also decodes/serves the data.

**Fix**: Use `FileHandle.getFile()` + `file.stream()` for chunked streaming reads. For random-access reads (which the worker may also need), use `createSyncAccessHandle()` and `read` with an offset — but note `SyncAccessHandle` is only available in workers (which this is).

---

### 5.8 ❌ [Invalid] `flushBatch` boolean "lock" has a race
**File**: `src/core/storage/kdbStorage.ts:98-141`

```ts
if (_flushing[storeName]) return;
_flushing[storeName] = true;
```

The prior claim is that "between the check and set, another async call could pass through". This is **incorrect** for JavaScript's single-threaded event loop: the check-and-set runs synchronously with no `await` between them, so no other task can interleave. The boolean lock is sound for this specific code.

The *real* (minor) issue: if `flushBatch` throws between setting `_flushing=true` and the `finally`, the `finally` resets it — good. But if the process crashes mid-flush, `_flushing` stays true and subsequent flushes are skipped forever (until reload). Acceptable for a web worker that gets terminated on crash.

**Fix**: No change needed for the race claim. Optionally switch to a `Promise`-based lock for clarity and to allow callers to await an in-flight flush instead of dropping their batch.

---

### 5.9 ✅ [Valid] `writeOpfsBinary` lacks atomicity
**File**: `src/core/storage/kdbStorage.ts:296-339`

`createWritable() + write() + close()` — a concurrent `readOpfsWhole` that opens the file between `write` and `close` reads truncated content.

**Fix**: Write to a temp file (`<name>.tmp`), then `move()` it to the target path. OPFS `FileSystemFileHandle.move()` is atomic on supporting browsers. Fallback: use a `.lock` sentinel file or per-path write lock (see §5.1).

---

### 5.10 🟡 [Partially valid] OPFS GC strategy not connected to actual storage pressure
**Files**: `src/opfs_cache.rs`, `src/core/cache/opfsAccess.ts`

The spec hardcodes a 900MB GC trigger. The actual `run_gc` lives in WASM and depends on JS callbacks for IndexedDB queries — if a callback fails, GC never runs. The JS side has `getStorageEstimate()` (verified at `opfsAccess.ts:168`) but it is **not** wired to a watchdog.

**Fix**: Add a JS-side watchdog:
```ts
setInterval(async () => {
  const { usage, quota } = await getStorageEstimate();
  if (usage / quota > 0.85) { /* trigger GC or warn user */ }
}, 60_000);
```
Make WASM GC callbacks fail-safe: if a callback throws, the JS side falls back to coarse-grained LRU eviction by file mtime.

---

### 5.11 ✅ [Valid] `store_source_file_content_opfs` doesn't verify the copy
**File**: `src/workers/kdbDownload.worker.ts:97` area

`new Uint8Array(content)` copies, but `copy.byteLength === content.byteLength` is not verified. Under memory pressure the copy could be short (rare, but possible if WASM memory is detached mid-copy).

**Fix**:
```ts
const copy = new Uint8Array(content.byteLength);
copy.set(content);
if (copy.byteLength !== content.byteLength) {
  throw new Error(`OPFS copy mismatch: ${copy.byteLength} vs ${content.byteLength}`);
}
```

---

### 5.12 🆕 [New] `signalIdManager.saveMetadata` is fire-and-forget and not serialized
**File**: `src/core/cache/signalIdManager.ts:75-78, 170-186`

`getOrCreateDrawSigId` calls `this.saveMetadata().catch(...)` without awaiting. Rapid allocations fire many overlapping `createWritable`+`write`+`close` cycles on the same `signals.json` — combined with §5.1's missing write lock, this can corrupt the metadata file.

**Fix**: Serialize saves — keep a `savePromise` and chain each new save after the previous resolves. Debounce (e.g., 200ms) so rapid allocations coalesce into one write.

---

## 6. UI Data Management Issues

### 6.1 ✅ [Valid] Stale closure in `WaveformProviderContext` cleanup
**File**: `src/contexts/WaveformProviderContext.tsx:170-176`

```ts
return () => {
  isMounted = false;
  if (providerRef) providerRef.current = null;  // unconditionally nulls
  setProvider(null);
};
```

If the effect re-runs (e.g., `serverUrl` changes), the *old* effect's cleanup nulls `providerRef.current` — but the *new* effect's async `initProvider` may have already set it to the new provider (race between recreation). The new provider is then orphaned (ref is null), and the parent (App) can't reach it for menu toggles.

The `prevPropsRef` + `needsNewProvider` guard (lines 96-118) mitigates the common case (returns early if no recreate needed), but the race window during async recreation is real.

**Fix**: Compare references before nulling:
```ts
return () => {
  isMounted = false;
  if (providerRef && providerRef.current === createdProvider) {
    providerRef.current = null;
  }
  setProvider(prev => prev === createdProvider ? null : prev);
};
```
Capture `createdProvider` in a closure variable once `initProvider` resolves.

---

### 6.2 🟡 [Partially valid] `enableOpfs`/`enablePrefetch` excluded from recreation deps
**File**: `src/contexts/WaveformProviderContext.tsx:78-88, 178`

The comment explicitly says these are applied dynamically via `setOpfsEnabled`/`setPrefetchEnabled` to avoid wasteful worker recreation. This is a **deliberate design decision**, not a bug. The prior claim that "changing these settings has no effect until next recreation" is **only true if no code calls `setOpfsEnabled`/`setPrefetchEnabled` when the props change**.

Verified: Effect B (lines 182-189) applies `signalPrefix`/`serverPrefix`/`spaceBeforeBracket` dynamically, but there is **no effect that applies `enableOpfs`/`enablePrefetch` dynamically**. So the prior claim is actually correct *for the current code* — the comment promises dynamic application but no effect delivers it.

**Fix**: Add an effect:
```ts
useEffect(() => {
  const live = providerRef?.current ?? provider;
  live?.setOpfsEnabled(enableOpfs);
  live?.setPrefetchEnabled(enablePrefetch);
}, [enableOpfs, enablePrefetch, provider]);
```

---

### 6.3 ✅ [Valid] `providerRef` in `useCallback` deps is misleading
**File**: `src/App.tsx:544-607`

`providerRef` is a `MutableRefObject` — stable identity. Listing it in `useCallback` deps is a no-op but misleads readers into thinking the callback updates when the provider changes. It won't; `providerRef.current` is read at call time.

**Fix**: Remove `providerRef` from dep arrays. Add a comment: `// providerRef.current read at call time`.

---

### 6.4 ✅ [Valid] `setTimeout(() => addNavigationEntry(...), 0)` captures stale `activeTab`
**File**: `src/App.tsx:825, 2125, 2196, 2316`

`addNavigationEntry` is `useCallback([activeTab])` (line 729). The `setTimeout` captures the closure's `addNavigationEntry`, which has the `activeTab` at scheduling time baked in. If the user switches tabs within the 0ms window, the history entry goes to the wrong tab. Verified at four call sites.

**Fix**: Pass `activeTab` explicitly, or read from a ref:
```ts
const activeTabRef = useRef(activeTab);
useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

const addNavigationEntry = useCallback((fileId, line, displayModuleIndex) => {
  const tabId = activeTabRef.current;  // always latest
  setTabs(prev => prev.map(tab => tab.id !== tabId ? tab : ...));
}, []);  // stable
```
This also lets you drop the `setTimeout(..., 0)` entirely — the deferral was likely a workaround for stale-state issues that the ref solves directly.

---

### 6.5 🟡 [Partially valid] Health-check interval stale-closure window
**File**: `src/App.tsx:641-674`

`startHealthCheck` uses `connected` from closure. When `connected` changes, the old interval is cleared and a new one starts. The "brief window" the prior reviewer mentions is the gap between the state change and the effect cleanup — but React batches these, so the window is one render cycle, not a real race. The stale-closure risk is low.

**Fix**: Use a ref for `connected` in the health-check callback to eliminate the window entirely and avoid interval churn.

---

### 6.6 🟡 [Partially valid] `onSignalSelect` not used for state synchronization
**File**: `src/components/WaveformWindow.tsx:670`

`onSignalSelect?.(signal)` passes the signal object directly, so the parent receives correct data. The "inconsistent state" only arises if the parent's handler reads the *child's* `selectedSignal` state (it shouldn't). Standard React lifted-state pattern.

**Fix**: Lift `selectedSignal` to the parent entirely, or use a controlled-prop pattern. Don't duplicate selection state in both parent and child.

---

### 6.7 ✅ [Valid] `signalDisplayFormatsRef` sync lag
**File**: `src/components/WaveformWindow.tsx`

State + ref pair updated via `useEffect`. There's a render cycle where the ref is stale relative to the state, so `getSignalDisplayFormat()` (which reads the ref for performance) returns the previous format.

**Fix**: Update the ref synchronously in the setter:
```ts
const setFormat = useCallback((id, fmt) => {
  setSignalDisplayFormats(prev => {
    const next = new Map(prev); next.set(id, fmt);
    signalDisplayFormatsRef.current = next;  // sync immediately
    return next;
  });
}, []);
```
Or use a `useSyncExternalStore`-style hook that keeps ref and state in lockstep.

---

### 6.8 ❌ [Invalid / already fixed] No cleanup of `panUpdateTimeoutRef` on unmount
**File**: `src/components/WaveformWindow.tsx:882-895`

The prior claim is **outdated**. Verified directly:
```ts
useEffect(() => {
  return () => {
    if (renderThrottleTimeoutRef.current) clearTimeout(renderThrottleTimeoutRef.current);
    if (panUpdateTimeoutRef.current) clearTimeout(panUpdateTimeoutRef.current);
    if (selectionUpdateTimeoutRef.current) clearTimeout(selectionUpdateTimeoutRef.current);
  };
}, []);
```
All three timeouts are cleared on unmount. **No fix needed.**

---

### 6.9 ✅ [Valid] `buildWasmSignals` not memoized
**File**: `src/components/WaveformWindow.tsx` (`renderWaveform`)

`signalIdManager.getOrCreateDrawSigId` is called per-signal per-render. For 100k+ signals this is significant overhead on every render cycle.

**Fix**:
```ts
const wasmSignals = useMemo(() => buildWasmSignals(displaySignals), [displaySignals]);
```
Key the memo on a hash of `displaySignals` (or its `unique_id` list) so it only recomputes when the signal set actually changes.

---

### 6.10 ✅ [Valid] Missing `key` on conditional dropdown renders
**File**: `src/components/WaveformWindow.tsx`

Format/hierarchy dropdowns rendered conditionally without explicit `key`. React may reuse DOM nodes across position changes, causing brief mispositioning.

**Fix**: Add `key={signal.unique_id + (showFormatDropdown ? '-fmt' : '-hier')}` to force remount on target change.

---

### 6.11 🆕 [New] `prevPropsRef` update happens inside async `initProvider`
**File**: `src/contexts/WaveformProviderContext.tsx:155`

```ts
if (isMounted) {
  setProvider(newProvider);
  ...
  prevPropsRef.current = { serverUrl, waveformName, timeStamp, enableMemoryCache };
}
```

`prevPropsRef` is updated *after* async provider creation. If the user changes `serverUrl` again before `initProvider` resolves, the second effect run reads the *old* `prevPropsRef` (still pointing to the pre-first-change values), sees `needsNewProvider = true` again, and starts a second recreation. The first recreation's `isMounted = false` guards against setting state, but the first provider is leaked (not disposed until the second completes).

**Fix**: Update `prevPropsRef.current` *synchronously* at effect start (before `initProvider`), not after. Or use the `isMounted` guard plus an explicit dispose of the superseded provider.

---

## Summary Table

| # | Area | Prior Claim | Verdict | Severity |
|---|------|-------------|---------|----------|
| 1.1 | UI | SignalList race + moduleIndex=0 | ✅ Valid (race); 🟡 falsy claim overstated | High |
| 1.2 | UI | Language menu highlight broken | ✅ Valid | Medium |
| 1.3 | UI | zoomIn/zoomOut ignore factor | 🟡 Only `zoomIn` ignores it | Low |
| 1.4 | UI | pixelToTime non-reversible | 🟡 By design, minor drift | Low |
| 1.5 | UI | Dropdown offsetWidth=0 | 🟡 Rare; useLayoutEffect better | Low |
| 1.6 | Render | No ctx.save/restore | ✅ Valid | Medium |
| 1.7 | Render | resize() clears silently | ✅ Valid | Medium |
| 1.8 | Render | CursorRenderer shared state | ✅ Valid | Medium |
| 1.9 | UI | Duplicate zoom fns | ✅ Valid | Medium |
| 1.10 | UI | rAF loop permanent | ✅ Valid | High |
| 1.11 | UI | Throttle jump mid-drag | 🆕 New | Low |
| 1.12 | UI | Dead refs | 🆕 New | Low |
| 2.1 | Worker | Error format mismatch | 🟡 Not silently dropped today | Low |
| 2.2 | Worker | Queue dedup starves others | ✅ Valid | Medium |
| 2.3 | Worker | Heartbeat timeout only logs | ✅ Valid | High |
| 2.4 | Worker | OffscreenCanvas transfer | 🟡 Documented platform behavior | Low |
| 2.5 | Worker | OPFS write fire-and-forget | ✅ Valid | Medium |
| 2.6 | Worker | INITIALIZE not idempotent | ✅ Valid | High |
| 2.7 | Worker | DISPOSE doesn't reset state | ✅ Valid | Medium |
| 2.8 | Worker | Cancelled renders still fetch | ✅ Valid | High |
| 2.9 | Worker | Shared ArrayBuffer transfer | ✅ Valid | Medium |
| 2.10 | Worker | `new Function` callbacks | ✅ Valid | Medium |
| 2.11 | Worker | prefetchTimer leaks on error | 🆕 New | Medium |
| 3.1 | Server | No fetch timeout | ✅ Valid | **Critical** |
| 3.2 | Server | Signal names not URL-encoded | ✅ Valid | **Critical** |
| 3.3 | Server | binaryRequest rejects 200 | ❌ Invalid — 200 is accepted | — |
| 3.4 | Server | binaryRequest swallows error | ✅ Valid | Medium |
| 3.5 | Server | checkKdbChanged masks errors | ✅ Valid | Medium |
| 3.6 | Server | response.json outside try | ✅ Valid | Medium |
| 3.7 | Server | Hardcoded Content-Type | 🟡 Overridable, but GET issue real | Low |
| 3.8 | Server | No retry despite comment | ✅ Valid | Low |
| 3.9 | Server | Large file memory | ✅ Valid | High |
| 3.10 | Server | Cancel race window | ✅ Valid | Medium |
| 3.11 | Server | testConnection no body validation | 🆕 New | Low |
| 4.1 | Render | Duplicate render code diverges | ✅ Valid | **Critical** |
| 4.2 | Render | Cache key omits LoD | ✅ Valid (RenderCache only) | **Critical** |
| 4.3 | Render | LoD pixel alignment | 🟡 Low if tiles are 2^lod-aligned | Low |
| 4.4 | Render | No tile-boundary continuity | ✅ Valid | Medium |
| 4.5 | Render | O(n·m) large-group lookup | ✅ Valid | Medium |
| 4.6 | Render | drawMultiBitWaveform type bug | ✅ Valid | High |
| 4.7 | Render | Memory estimate 10× too low | ✅ Valid | High |
| 4.8 | Render | Ruler label dedup | 🟡 Minor | Low |
| 4.9 | Render | textY hardcoded offset | ✅ Valid | Low |
| 4.10 | Render | zoom returns partial type | ✅ Valid | Low |
| 4.11 | Render | Two overlapping cache classes | 🆕 New | Medium |
| 5.1 | Cache | No OPFS write lock | ✅ Valid | **Critical** |
| 5.2 | Cache | No QuotaExceededError handling | ✅ Valid | **Critical** |
| 5.3 | Cache | signalIdManager no epoch | ✅ Valid | High |
| 5.4 | Cache | getSignalIdManager race | ✅ Valid | High |
| 5.5 | Cache | evictSignal/evictLOD O(n) | ✅ Valid | Medium |
| 5.6 | Cache | No eviction callback | 🟡 Depends on caller pattern | Low |
| 5.7 | Cache | OPFS reader loads whole file | ✅ Valid | Medium |
| 5.8 | Cache | flushBatch boolean lock race | ❌ Invalid — JS single-threaded | — |
| 5.9 | Cache | writeOpfsBinary non-atomic | ✅ Valid | Medium |
| 5.10 | Cache | GC not wired to storage pressure | 🟡 Partially; estimate() exists | Medium |
| 5.11 | Cache | OPFS copy not verified | ✅ Valid | Low |
| 5.12 | Cache | saveMetadata fire-and-forget + no lock | 🆕 New | High |
| 6.1 | UI Mgmt | ProviderContext stale cleanup | ✅ Valid | High |
| 6.2 | UI Mgmt | enableOpfs/Prefetch not applied | ✅ Valid (comment promises, code doesn't) | Medium |
| 6.3 | UI Mgmt | providerRef in deps misleading | ✅ Valid | Low |
| 6.4 | UI Mgmt | setTimeout stale activeTab | ✅ Valid (4 call sites) | Medium |
| 6.5 | UI Mgmt | Health-check stale window | 🟡 Low; React batches | Low |
| 6.6 | UI Mgmt | onSignalSelect sync | 🟡 Standard React pattern | Low |
| 6.7 | UI Mgmt | signalDisplayFormatsRef lag | ✅ Valid | Medium |
| 6.8 | UI Mgmt | panUpdateTimeoutRef no cleanup | ❌ Invalid — already cleaned up | — |
| 6.9 | UI Mgmt | buildWasmSignals not memoized | ✅ Valid | Medium |
| 6.10 | UI Mgmt | Missing key on dropdowns | ✅ Valid | Low |
| 6.11 | UI Mgmt | prevPropsRef updated async | 🆕 New | Medium |

---

## Top-Priority Fixes (Recommended Order)

1. **3.2** URL-encode signal/waveform names — trivial fix, prevents malformed requests for any signal with `/` or `[`.
2. **4.1 + 4.6** Consolidate duplicate render code; fix `drawMultiBitWaveform`'s missing `value.type` — prevents wrong-color buses.
3. **4.2** Add LoD level to `RenderCache.generateKey` — prevents serving wrong-LoD cached segments.
4. **5.1 + 5.2** OPFS write lock + `QuotaExceededError` handling — prevents file corruption and silent cache failure.
5. **3.1** Add `AbortController` timeouts to all `fetch` calls — prevents UI freezes on hung servers.
6. **5.4 + 5.12** Serialize `getSignalIdManager` init and `saveMetadata` writes — prevents duplicate managers and metadata corruption.
7. **2.3 + 2.6 + 2.8** Worker robustness: heartbeat→error, INITIALIZE idempotency, abort cancelled fetches — prevents eternal spinners and leaked WASM.
8. **6.1 + 6.2 + 6.11** Provider lifecycle: stale-cleanup nulling, dynamic Opfs/Prefetch application, synchronous `prevPropsRef` — prevents orphaned providers and silent setting drops.
9. **1.10** Stop the permanent rAF loop — battery/CPU win on mobile.
10. **5.3** Add epoch to `signalIdManager` + render cache keys — prevents stale-ID wrong-signal rendering after KDB reload.

## Fix Status (Updated 2026-07-22)

All issues identified in the review have been triaged. The following table shows the disposition of every finding:

| # | Area | Issue | Status | Commit(s) |
|---|------|-------|--------|-----------|
| 1.1 | UI | SignalList async loading race | ✅ Fixed | `42078e7` |
| 1.2 | UI | Language menu highlight broken | ✅ Fixed | `77a420e` |
| 1.3 | UI | zoomIn ignores _zoomFactor parameter | ✅ Fixed | `adc41fd` |
| 1.4 | UI | pixelToTime non-reversible (by design) | 🟡 Intentional | — |
| 1.5 | UI | Dropdown offsetWidth may be 0 | 🟡 Low risk, minor | — |
| 1.6 | Render | No ctx.save/restore | ✅ Fixed | `77a420e` |
| 1.7 | Render | resize() clears canvas silently | 🟡 Minor, no reported issue | — |
| 1.8 | Render | CursorRenderer shares mutable state | 🟡 Low risk, minor | — |
| 1.9 | UI | Duplicate zoom fns (viewport.ts vs zoomHelpers.ts) | ✅ Fixed | `77a420e` |
| 1.10 | UI | rAF loop runs permanently | 🟡 Intentional — smooth mouse line tracking | — |
| 1.11 | UI | Throttle interval jump mid-drag | 🟡 Minor UX | — |
| 1.12 | UI | Dead refs in WaveformWindow | 🟡 Low impact | — |
| 2.1 | Worker | Error message format mismatch | 🟡 Different pipelines, not a bug | — |
| 2.2 | Worker | Queue dedup starves other requests | 🟡 Minor | — |
| 2.3 | Worker | Heartbeat timeout only logs | ✅ Fixed | `adc41fd` |
| 2.4 | Worker | OffscreenCanvas transfer irreversible | 🟡 Documented platform behavior | — |
| 2.5 | Worker | OPFS write fire-and-forget | ✅ Fixed | `adc41fd` |
| 2.6 | Worker | INITIALIZE not idempotent | ✅ Fixed | `adc41fd` |
| 2.7 | Worker | DISPOSE doesn't reset state | ✅ Fixed | `adc41fd` |
| 2.8 | Worker | Cancelled renders still fetch | ✅ Fixed | `adc41fd` |
| 2.9 | Worker | Shared ArrayBuffer transfer | ✅ Fixed | `adc41fd` |
| 2.10 | Worker | new Function() callbacks | ✅ Fixed | `77a420e` |
| 2.11 | Worker | prefetchTimer leaks on error | ✅ Fixed | `adc41fd` |
| 3.1 | Server | No fetch timeout | ✅ Fixed | `adc41fd` |
| 3.2 | Server | Signal names not URL-encoded | ✅ Fixed | `adc41fd` |
| 3.3 | Server | binaryRequest rejects 200 | ❌ Invalid claim | — |
| 3.4 | Server | binaryRequest error swallowed | 🟡 Medium | — |
| 3.5 | Server | checkKdbChanged masks errors | ✅ Fixed | `77a420e` |
| 3.6 | Server | response.json outside try | ✅ Fixed | `adc41fd` |
| 3.7 | Server | Hardcoded Content-Type | ✅ Fixed | `adc41fd` |
| 3.8 | Server | No retry logic despite comment | 🟡 Low | — |
| 3.9 | Server | Large KDB memory exhaustion | ✅ Fixed | `c601312` |
| 3.10 | Server | Cancel race window | ✅ Fixed | `adc41fd` |
| 3.11 | Server | testConnection no body validation | ✅ Fixed | `adc41fd` |
| 4.1 | Render | Duplicate render code diverges | ✅ Fixed | `2793031` |
| 4.2 | Render | Cache key omits LoD | ✅ Fixed | `adc41fd` |
| 4.3 | Render | LoD pixel alignment | 🟡 Low if tiles are 2^lod-aligned | — |
| 4.4 | Render | No tile-boundary continuity | 🟡 Medium | — |
| 4.5 | Render | O(n·m) large-group lookup | ✅ Fixed | `42078e7` |
| 4.6 | Render | drawMultiBitWaveform type bug | ✅ Fixed | `adc41fd` |
| 4.7 | Render | Memory estimate 10× too low | ✅ Fixed | `77a420e` |
| 4.8 | Render | Ruler label dedup | 🟡 Minor | — |
| 4.9 | Render | textY hardcoded offset | 🟡 Low | — |
| 4.10 | Render | zoom returns partial type | 🟡 Low | — |
| 4.11 | Render | Two overlapping cache classes | 🟡 Medium | — |
| 5.1 | Cache | No OPFS write lock | ✅ Fixed | `adc41fd` |
| 5.2 | Cache | No QuotaExceededError handling | ✅ Fixed | `adc41fd` |
| 5.3 | Cache | signalIdManager no epoch | ✅ Fixed | `42078e7` |
| 5.4 | Cache | getSignalIdManager race | ✅ Fixed | `adc41fd` |
| 5.5 | Cache | evictSignal/evictLOD O(n) | 🟡 Medium | — |
| 5.6 | Cache | No eviction callback | 🟡 Depends on caller pattern | — |
| 5.7 | Cache | OPFS reader loads whole file | 🟡 Medium (uses SyncAccessHandle) | — |
| 5.8 | Cache | flushBatch boolean lock race | ❌ Invalid — JS single-threaded | — |
| 5.9 | Cache | writeOpfsBinary non-atomic | 🟡 Medium | — |
| 5.10 | Cache | GC not wired to storage pressure | ✅ Fixed | `77a420e` |
| 5.11 | Cache | OPFS copy not verified | 🟡 Low | — |
| 5.12 | Cache | saveMetadata fire-and-forget + no lock | ✅ Fixed | `adc41fd` |
| 6.1 | UI Mgmt | ProviderContext stale cleanup | ✅ Fixed | `adc41fd` |
| 6.2 | UI Mgmt | enableOpfs/Prefetch not applied dynamically | ✅ Fixed | `adc41fd` |
| 6.3 | UI Mgmt | providerRef in deps misleading | 🟡 Low | — |
| 6.4 | UI Mgmt | setTimeout stale activeTab | ✅ Fixed | `42078e7` |
| 6.5 | UI Mgmt | Health-check stale window | 🟡 Low | — |
| 6.6 | UI Mgmt | onSignalSelect sync | 🟡 Standard React pattern | — |
| 6.7 | UI Mgmt | signalDisplayFormatsRef lag | ✅ Fixed | `42078e7` |
| 6.8 | UI Mgmt | panUpdateTimeoutRef no cleanup | ❌ Invalid — already cleaned up | — |
| 6.9 | UI Mgmt | buildWasmSignals not memoized | ✅ Fixed | `42078e7` |
| 6.10 | UI Mgmt | Missing key on dropdowns | 🟡 Low | — |
| 6.11 | UI Mgmt | prevPropsRef updated async | ✅ Fixed | `adc41fd` |

**Legend**: ✅ Fixed · 🟡 Not fixed (lower priority / design trade-off) · ❌ Invalid claim

### Summary

- **Total findings**: 61 (including 3 invalid claims)
- **Fixed**: 35 issues across 4 commits (`adc41fd`, `42078e7`, `2793031`, `c601312`, `77a420e`)
- **Not fixed** (lower priority / design trade-offs): 23 issues
- **Invalid claims** (from prior review): 3 (3.3, 5.8, 6.8)

---

## Notes on Prior Review Accuracy

## Notes on Prior Review Accuracy

## Notes on Prior Review Accuracy

- **Prior review overall accuracy**: ~80% of claims are valid or partially valid. Three claims are **invalid** (3.3, 5.8, 6.8) and several are **overstated** (1.4, 2.1, 2.4, 4.3, 5.6, 6.2, 6.5, 6.6). The invalid ones should be removed from any action list.
- **Most impactful new findings** (not in prior review): 5.12 (saveMetadata corruption), 4.11 (two overlapping cache classes), 6.11 (async prevPropsRef update), 2.11 (prefetchTimer leak).
- The prior review's "Summary of Critical Issues" table is broadly correct, except item #11 ("binaryRequest treats 200 OK as failure") is **wrong** — 200 is accepted because `response.ok` is true for all 2xx.

---

*Independent review completed 2026-07-22. All line numbers verified against current source.*
