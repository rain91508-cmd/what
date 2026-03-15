# Get Signal Values at Transitions - Design Specification

## Overview

A new WASM function to fetch raw signal values at all transition points within a specified time range. This function operates independently of the render pipeline and returns data organized by time points rather than by signals.

## Use Cases

- Export raw waveform data for analysis
- Dump signal values at specific time points
- Integration with external tools requiring raw transition data

## Data Structures

### Input Parameters

```rust
#[wasm_bindgen]
pub async fn get_signal_values_at_transitions(
    &mut self,
    signal_names: Vec<String>,                    // List of signal names to query
    search_start_time: u64,                       // Start of search range (inclusive)
    search_end_time: u64,                         // End of search range (inclusive)
    result_max: usize,                            // Maximum number of time points to return
    signals_with_format: Vec<SignalWithFormat>,   // Signal list with display format (same as render)
) -> Result<JsValue, JsValue>
```

### SignalWithFormat Structure

```rust
#[derive(Serialize, Deserialize)]
struct SignalWithFormat {
    global_id: u32,           // Global signal ID
    name: String,             // Signal name
    row: u32,                 // Row index (for ordering)
    width: u32,               // Signal width in bits
    draw_sig_id: u32,         // Drawing signal ID
    bit_extract: Option<BitExtract>,  // Optional bit extraction info
    display_format: String,   // "hex" | "bin" | "oct" | "dec" - CRITICAL for value formatting
}

#[derive(Serialize, Deserialize)]
struct BitExtract {
    parent_name: String,      // Parent signal name
    msb: u32,                 // Most significant bit
    lsb: u32,                 // Least significant bit
}
```

**Note**: The `display_format` field is essential for formatting multi-bit signal values correctly. Each signal can have its own format (e.g., address as hex, counter as dec).

### Output Structure

```rust
#[derive(Serialize)]
struct RawSignalValuesResult {
    search_start_time: u64,
    search_end_time: u64,
    data: Vec<RawSignalValuesAtTime>,
}

#[derive(Serialize)]
struct RawSignalValuesAtTime {
    time: u64,                          // Time point (LoD0Unit)
    values: Vec<RawValue>,              // Values for each signal (in signal list order)
}

#[derive(Serialize)]
struct RawValue {
    display_str: String,                // Formatted value string (respects display_format)
    value_type: String,                 // "has_x" | "has_z" | "mixed" | "numeric"
    has_transition: bool,               // True if this signal changed at this exact time
}
```

## Algorithm

### Step 1: Independent Data Fetching

```
1. Save current viewport and LoD settings
2. Set viewport to (search_start_time, search_end_time)
3. Set LoD to 0 (force raw data)
4. Call fetch_signals_data_batch_internal(signal_names, lod=0)
5. Data is now cached in self.signal_data
```

### Step 2: Collect All Transition Times

```
1. Create a BTreeSet<u64> for sorted unique times
2. Insert search_start_time (mandatory first point)
3. For each signal in signal_names:
   - Get SignalWaveData from self.signal_data
   - Iterate through all transitions
   - Add transition.time to set if within [search_start_time, search_end_time]
4. Result: sorted list of all time points where any signal changes
```

### Step 3: Build Result for Each Time Point

For each time in sorted_times (limited by result_max):
```
For each signal in signal_names (in order):
    1. Find value at time:
       - Check if exact transition exists at this time
       - If not, find the most recent transition before this time
       - Use tile_info.start_value if no prior transition
    
    2. Format the value:
       - Use server_value_to_string() for basic conversion
       - Apply display_format from SignalWithFormat
       - For multi-bit: use format_multi_bit_value()
    
    3. Classify value type:
       - Check for X/Z characters
       - Return "has_x", "has_z", "mixed", or "numeric"
    
    4. Determine has_transition:
       - true if exact transition match
       - false if using prior value
    
    5. Build RawValue
```

### Step 4: Cleanup and Return

```
1. Restore original viewport and LoD
2. Optionally: clear signal_data to free memory
3. Serialize and return RawSignalValuesResult
```

## Key Implementation Details

### Finding Value at Time

```rust
fn find_value_at_time(
    signal_data: &SignalWaveData,
    target_time: u64,
) -> (Transition, bool) {
    // Check for exact match
    if let Ok(idx) = signal_data.transitions.binary_search_by_key(&target_time, |t| t.time) {
        return (signal_data.transitions[idx].clone(), true);
    }
    
    // Find most recent transition before target_time
    if let Some(trans) = signal_data.transitions.iter().filter(|t| t.time < target_time).last() {
        return (trans.clone(), false);
    }
    
    // Use tile start value
    for (tile_start, tile_end, _start_time, start_value) in &signal_data.tile_info {
        if target_time >= *tile_start && target_time <= *tile_end {
            return (start_value.clone(), false);
        }
    }
    
    // Default to '0'
    (Transition::default_zero(), false)
}
```

### Value Formatting

```rust
fn format_value(
    transition: &Transition,
    width: u32,
    display_format: &str,
) -> String {
    // Convert raw bytes to string
    let raw_str = server_value_to_string(
        transition.value_type,
        transition.value_len,
        &transition.value
    );
    
    // Apply display format for multi-bit signals
    if width > 1 {
        match display_format {
            "hex" => format_as_hex(&raw_str, width),
            "bin" => format_as_bin(&raw_str, width),
            "oct" => format_as_oct(&raw_str, width),
            "dec" => format_as_dec(&raw_str, width),
            _ => raw_str,
        }
    } else {
        raw_str
    }
}
```

### Value Classification

```rust
fn classify_value_type(display_str: &str) -> &'static str {
    let has_x = display_str.contains('X') || display_str.contains('x');
    let has_z = display_str.contains('Z') || display_str.contains('z');
    
    match (has_x, has_z) {
        (true, true) => "mixed",
        (true, false) => "has_x",
        (false, true) => "has_z",
        (false, false) => "numeric",
    }
}
```

## Reuse Strategy

### Fully Reused Components

| Component | Location | Usage |
|-----------|----------|-------|
| `fetch_signals_data_batch` | `waveform_provider.rs:1052` | Extract to `fetch_with_lod(lod)` |
| `SignalWaveData` | `waveform_provider.rs:209` | Direct use |
| `server_value_to_string` | `waveform_provider.rs:146` | Direct use |
| `format_multi_bit_value` | `waveform_provider.rs:~2320` | Direct use |
| `classify_value` | `waveform_provider.rs` | Direct use |
| `tile_info` | `SignalWaveData.tile_info` | For start values |
| `transitions` | `SignalWaveData.transitions` | For change points |

### Modified Components

| Component | Modification |
|-----------|-------------|
| `fetch_signals_data_batch` | Extract LoD parameter, make it configurable |

## Files to Modify

### Rust/WASM Layer

1. **waveform_provider.rs** (+200 lines)
   - Add `SignalWithFormat` struct
   - Add `RawSignalValuesResult`, `RawSignalValuesAtTime`, `RawValue` structs
   - Add `get_signal_values_at_transitions` function
   - Add `find_value_at_time` helper
   - Add `format_value_with_radix` helper
   - Refactor `fetch_signals_data_batch` to accept LoD parameter

### TypeScript Interface Layer

2. **waveformProviderInterface.ts** (+30 lines)
   - Add `SignalWithFormat` interface
   - Add `RawSignalValuesResult`, `RawSignalValuesAtTime`, `RawValue` interfaces
   - Add `getSignalValuesAtTransitions` method signature

3. **workerWaveformProvider.ts** (+40 lines)
   - Implement `getSignalValuesAtTransitions` method
   - Add message handling for `GET_SIGNAL_VALUES_AT_TRANSITIONS`

4. **waveformWorker.ts** (+50 lines)
   - Add `GET_SIGNAL_VALUES_AT_TRANSITIONS` case
   - Implement `handleGetSignalValuesAtTransitions`

5. **waveformProviderAdapter.ts** (+30 lines)
   - Add `get_signal_values_at_transitions` method
   - Convert signal format and call provider

## Performance Considerations

### Memory Management

- **signal_data** is temporary and cleared after each call
- **Result size**: Limited by `result_max` parameter
- **Time complexity**: O(S × T) where S = signals, T = transitions

### Optimization Opportunities

1. **Streaming**: For very large results, use JS callback to stream chunks
2. **Caching**: Cache signal_data if same viewport requested multiple times
3. **Parallel**: Process signals in parallel using Rayon (if supported in WASM)

### Limits

- `result_max`: Default 10,000, max 100,000 (configurable)
- Time range: Limited by available memory
- Signal count: Limited by `MAX_BATCH_SIZE` (256)

## Error Handling

### Possible Errors

1. **Signal not found**: Return error or skip with warning
2. **Time range invalid**: Return error if start > end
3. **Memory exhausted**: Return partial results with truncation flag
4. **Network error**: Propagate from fetch_signals_data_batch

### Error Response

```rust
Err(JsValue::from_str("Signal 'xyz' not found in cache"))
```

## Testing Strategy

### Unit Tests (Rust)

1. Test `find_value_at_time` with various scenarios
2. Test value formatting with different radix
3. Test time collection with overlapping signals

### Integration Tests (TypeScript)

1. Test with single signal, single transition
2. Test with multiple signals, overlapping transitions
3. Test with large time range (performance)
4. Test with missing signals (error handling)

## Example Usage

```typescript
const result = await adapter.getSignalValuesAtTransitions({
  signalNames: ['work@top.data', 'work@top.addr'],
  searchStartTime: 1000000,
  searchEndTime: 2000000,
  resultMax: 1000,
  signals: [
    {
      globalId: 1,
      name: 'work@top.data',
      row: 0,
      width: 32,
      drawSigId: 1,
      displayFormat: 'hex'  // Format data as hex
    },
    {
      globalId: 2,
      name: 'work@top.addr',
      row: 1,
      width: 16,
      drawSigId: 2,
      displayFormat: 'dec'  // Format address as decimal
    }
  ]
});

// Result:
// {
//   searchStartTime: 1000000,
//   searchEndTime: 2000000,
//   data: [
//     { time: 1000000, values: [
//       { displayStr: "0xABCD1234", valueType: "numeric", hasTransition: false },
//       { displayStr: "1024", valueType: "numeric", hasTransition: false }
//     ]},
//     { time: 1050000, values: [
//       { displayStr: "0xDEADBEEF", valueType: "numeric", hasTransition: true },
//       { displayStr: "1024", valueType: "numeric", hasTransition: false }
//     ]},
//     // ...
//   ]
// }
```

## Future Enhancements

1. **Streaming API**: For results > 100k points
2. **Filtering**: Only return signals that changed
3. **Compression**: Gzip large responses
4. **Caching**: Persistent cache for repeated queries
5. **Pagination**: Offset/limit for large result sets
