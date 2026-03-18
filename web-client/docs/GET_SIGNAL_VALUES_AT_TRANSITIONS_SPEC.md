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
    signals_with_format: JsValue,                 // Signal list with display format (same as render)
    lod: Option<u32>,                             // Optional: Level of Detail (0=raw data, 1+=aggregated)
    enable_opfs: Option<bool>,                    // Optional: Override OPFS cache setting
    enable_memory_cache: Option<bool>,            // Optional: Override memory cache setting
    early_exit_on_insufficient_transitions: Option<bool>, // Optional: If true, exit early if first 10 tiles have <2 real transitions
) -> Result<JsValue, JsValue>
```

### SignalWithFormat Structure

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalWithFormat {
    pub global_id: u32,           // Global signal ID
    pub name: String,             // Signal name
    pub row: u32,                 // Row index (for ordering)
    pub width: u32,               // Signal width in bits
    pub draw_sig_id: u32,         // Drawing signal ID
    pub bit_extract: Option<BitExtractInfo>,  // Optional bit extraction info
    pub display_format: String,   // "hex" | "bin" | "oct" | "dec" - CRITICAL for value formatting
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BitExtractInfo {
    pub parent_name: String,      // Parent signal name
    pub msb: u32,                 // Most significant bit
    pub lsb: u32,                 // Least significant bit
}
```

**Note**: The `display_format` field is essential for formatting multi-bit signal values correctly. Each signal can have its own format (e.g., address as hex, counter as dec).

### Output Structure

```rust
#[derive(Debug, Clone, Serialize)]
pub struct RawSignalValuesResult {
    #[serde(rename = "searchStartTime")]
    pub search_start_time: u64,
    #[serde(rename = "searchEndTime")]
    pub search_end_time: u64,
    pub data: Vec<RawSignalValuesAtTime>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RawSignalValuesAtTime {
    pub time: u64,                          // Time point (in display units, converted from LoD0)
    pub values: Vec<RawValue>,              // Values for each signal (in signal list order)
}

/// Raw value at a specific time for a single signal
#[derive(Debug, Clone, Serialize)]
pub struct RawValue {
    #[serde(rename = "displayStr")]
    pub display_str: String,                // Formatted value string (respects display_format)
    
    #[serde(rename = "valueType")]
    pub value_type: String,                 // Value type classification:
                                            //   - "has_x": value contains 'X' characters
                                            //   - "has_z": value contains 'Z' characters
                                            //   - "mixed": value contains both 'X' and 'Z'
                                            //   - "numeric": pure numeric value (no X/Z)
    
    #[serde(rename = "hasTransition")]
    pub has_transition: bool,               // True if this signal had a transition at this exact time
                                            // False if using the value from a prior transition
}
```

**Note**: Each `RawValue` contains comprehensive metadata about the signal value:
- `value_type` indicates whether the value contains unknown (X) or high-impedance (Z) states
- `has_transition` indicates whether the signal actually changed at this time point

## Algorithm

### Step 1: Independent Data Fetching

```
1. Save current viewport and LoD settings
2. Set viewport to (search_start_time, search_end_time)
3. Set LoD to 0 (force raw data)
4. Fetch data in batches of 10 tiles at a time (prevents server timeout)
5. Call fetch_signals_data_batch_internal(signal_names, lod=0, custom_time_range)
6. Data is now cached in self.signal_data
```

### Step 2: Collect All Transition Times

```
1. Create a BTreeSet<u64> for sorted unique times
2. Insert search_start_time (mandatory first point)
3. For each batch of 10 tiles:
   - Fetch data for the batch
   - For each signal in signal_names:
      - Get SignalWaveData from self.signal_data
      - Iterate through all transitions
      - Add transition.time to set if within [search_start_time, search_end_time]
4. Result: sorted list of all time points where any signal changes
```

### Step 3: Build Result for Each Time Point

For each time in sorted_times (limited by result_max):
```
1. Re-fetch all required data for the collected times (optimized tile fetch)
2. For each signal in signal_names (in order):
   a. Find value at time:
      - Check if exact transition exists at this time
      - If not, find the most recent transition before this time
      - Use tile_info.start_value if no prior transition
   
   b. Format the value:
      - Use server_value_to_string() for basic conversion
      - Apply display_format from SignalWithFormat
      - Parse numeric value and format with proper radix
   
   c. Classify value type:
      - Check for X/Z characters (skip "0x" prefix for hex values)
      - Return "has_x", "has_z", "mixed", or "numeric"
   
   d. Determine has_transition:
      - true if exact transition match
      - false if using prior value
   
   e. Build RawValue

3. Convert time from LoD0 units to display units using display_unit_per_lod0_unit
4. Build RawSignalValuesAtTime
```

### Step 4: Cleanup and Return

```
1. Restore original viewport and LoD
2. Restore original cache settings
3. Convert search range times from LoD0 units to display units
4. Serialize and return RawSignalValuesResult with camelCase field names
```

## Key Implementation Details

### Finding Value at Time

```rust
fn find_value_at_time_in_signal(
    &self,
    signal_name: &str,
    target_time: u64,
) -> (Transition, bool) {
    let default_transition = Transition {
        time: 0,
        actual_time: 0,
        value_type: 0,
        value_len: 1,
        value: vec![b'0'],
    };
    
    let signal_data = match self.signal_data.get(signal_name) {
        Some(data) => data,
        None => return (default_transition, false),
    };
    
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
    (default_transition, false)
}
```

### Value Formatting

```rust
fn format_value_with_format(
    &self,
    transition: &Transition,
    width: u32,
    display_format: &str,
) -> String {
    // Convert raw bytes to string
    let raw_str = server_value_to_string(
        transition.value_type,
        transition.value_len,
        &transition.value,
    );
    
    // For single-bit signals, return as-is
    if width == 1 {
        return raw_str;
    }
    
    // For multi-bit signals, apply display format
    // Parse the raw string as a numeric value
    let numeric_value = if raw_str.starts_with("0x") || raw_str.starts_with("0X") {
        u64::from_str_radix(&raw_str[2..], 16).unwrap_or(0)
    } else if raw_str.starts_with("0b") || raw_str.starts_with("0B") {
        u64::from_str_radix(&raw_str[2..], 2).unwrap_or(0)
    } else if raw_str.starts_with("0o") || raw_str.starts_with("0O") {
        u64::from_str_radix(&raw_str[2..], 8).unwrap_or(0)
    } else {
        raw_str.parse::<u64>().unwrap_or(0)
    };
    
    match display_format {
        "hex" | "h" => format!("0x{:0width$X}", numeric_value, width = ((width + 3) / 4) as usize),
        "bin" | "b" => format!("0b{:0width$b}", numeric_value, width = width as usize),
        "oct" | "o" => format!("0o{:0width$o}", numeric_value, width = ((width + 2) / 3) as usize),
        "dec" | "d" => numeric_value.to_string(),
        _ => format!("0x{:0width$X}", numeric_value, width = ((width + 3) / 4) as usize), // Default to hex
    }
}
```

### Value Classification

```rust
fn classify_value_type(display_str: &str) -> &'static str {
    // For hex values like "0x1234", skip "0x" prefix for X/Z detection
    let check_str = if display_str.starts_with("0x") || display_str.starts_with("0X") {
        &display_str[2..]
    } else {
        display_str
    };
    
    let has_x = check_str.contains('X') || check_str.contains('x');
    let has_z = check_str.contains('Z') || check_str.contains('z');
    
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
| `fetch_signals_data_batch_internal` | `waveform_provider.rs:1221` | Direct use with explicit LoD and custom time range |
| `SignalWaveData` | `waveform_provider.rs:209` | Direct use |
| `server_value_to_string` | `waveform_provider.rs:147` | Direct use |
| `Transition` | `waveform_provider.rs:129` | Direct use |
| `tile_info` | `SignalWaveData.tile_info` | For start values |
| `transitions` | `SignalWaveData.transitions` | For change points |

### Modified Components

| Component | Modification |
|-----------|-------------|
| `fetch_signals_data_batch_internal` | Accepts custom_time_range parameter |

## TypeScript Interface Types

```typescript
// Get Signal Values at Transitions Types

/**
 * Signal with display format for getSignalValuesAtTransitions
 */
export interface SignalWithFormat {
  globalId: number;
  name: string;
  row: number;
  width: number;
  drawSigId: number;
  bitExtract?: {
    parentName: string;
    msb: number;
    lsb: number;
  };
  displayFormat: DisplayFormat;
}

/**
 * Raw value at a specific time for a single signal
 */
export interface RawValue {
  /** Formatted value string (respects display_format) */
  displayStr: string;
  
  /**
   * Value type classification:
   * - 'has_x': value contains 'X' characters (unknown state)
   * - 'has_z': value contains 'Z' characters (high-impedance state)
   * - 'mixed': value contains both 'X' and 'Z'
   * - 'numeric': pure numeric value (no X/Z states)
   */
  valueType: 'has_x' | 'has_z' | 'mixed' | 'numeric';
  
  /**
   * Indicates whether the signal had a transition at this exact time:
   * - true: this signal changed at this time point
   * - false: using the value from a prior transition (no change at this time)
   */
  hasTransition: boolean;
}

/**
 * All signal values at a specific time point
 */
export interface RawSignalValuesAtTime {
  time: number;
  values: RawValue[];
}

/**
 * Complete result for getSignalValuesAtTransitions
 */
export interface RawSignalValuesResult {
  searchStartTime: number;
  searchEndTime: number;
  data: RawSignalValuesAtTime[];
}

/**
 * Parameters for getSignalValuesAtTransitions
 */
export interface GetSignalValuesAtTransitionsParams {
  signalNames: string[];
  searchStartTime: number;
  searchEndTime: number;
  resultMax: number;
  signals: SignalWithFormat[];
  /**
   * Optional: Level of Detail (0=raw data, 1+=aggregated data)
   * If not provided, defaults to 0 (raw data)
   */
  lod?: number;
  /**
   * Optional: If true, exit early if first 10 tiles contain fewer than 2 real transitions
   * Defaults to false
   */
  earlyExitOnInsufficientTransitions?: boolean;
  // Prefix settings for signal name conversion (optional)
  signalPrefix?: string;
  serverPrefix?: string;
  spaceBeforeBracket?: boolean;
  // Time unit conversion factor (optional, defaults to 1.0)
  // Multiply LoD0 time by this factor to get display unit time
  displayUnitPerLoD0Unit?: number;
}
```

## Files to Modify (Implementation Complete)

### Rust/WASM Layer

1. **waveform_provider.rs** ✓
   - Added `SignalWithFormat` struct
   - Added `BitExtractInfo` struct
   - Added `RawSignalValuesResult`, `RawSignalValuesAtTime`, `RawValue` structs
   - Added `get_signal_values_at_transitions` function with enhanced parameters
   - Added `find_value_at_time_in_signal` helper
   - Added `format_value_with_format` helper
   - Added `classify_value_type` helper
   - Uses `fetch_signals_data_batch_internal` with custom time range

### TypeScript Interface Layer

2. **waveformProviderInterface.ts** ✓
   - Added `SignalWithFormat` interface
   - Added `RawSignalValuesResult`, `RawSignalValuesAtTime`, `RawValue` interfaces
   - Added `GetSignalValuesAtTransitionsParams` interface
   - Added `getSignalValuesAtTransitions` method signature

3. **workerWaveformProvider.ts** ✓
   - Implemented `getSignalValuesAtTransitions` method
   - Added message handling for `GET_SIGNAL_VALUES_AT_TRANSITIONS`

4. **waveformWorker.ts** ✓
   - Added `GET_SIGNAL_VALUES_AT_TRANSITIONS` case
   - Implemented `handleGetSignalValuesAtTransitions`
   - Handles prefix settings and time unit conversion

5. **waveformProviderAdapter.ts** ✓
   - Added `get_signal_values_at_transitions` method
   - Converts signal format and calls provider
   - Passes prefix settings and time unit conversion

## Performance Considerations

### Memory Management

- **signal_data** is temporary and cleared after each batch
- **Result size**: Limited by `result_max` parameter
- **Time complexity**: O(S × T) where S = signals, T = transitions
- **Tile batching**: Fetches 10 tiles at a time to prevent server timeout

### Optimization Opportunities Implemented

1. **Batch tile fetching**: Prevents large single requests
2. **Two-pass approach**: Collects all times first, then fetches data for result
3. **CamelCase serialization**: Directly compatible with TypeScript
4. **Time unit conversion**: Supports display units different from LoD0

### Limits

- `result_max`: Default 10,000, max 100,000 (configurable)
- Time range: Limited by available memory
- Signal count: Limited by `MAX_BATCH_SIZE` (256)
- Tile batch size: 10 tiles per batch (configurable via `TILES_PER_BATCH`)

## Additional Features Implemented

### Time Unit Conversion

- Uses `display_unit_per_lod0_unit` to convert LoD0 time units to display units
- Applied to both search range and individual time points
- Configurable per call via `GetSignalValuesAtTransitionsParams`

### Cache Control

- Optional `enable_opfs` parameter to override global OPFS setting
- Optional `enable_memory_cache` parameter to override global memory cache setting
- Original settings are restored after call completion

### Signal Name Prefix Support

- Supports `signalPrefix`, `serverPrefix`, and `spaceBeforeBracket` parameters
- Properly converts local signal names to server signal names
- Ensures correct signal name matching

## Error Handling

### Possible Errors

1. **Signal not found**: Return error or skip with warning
2. **Time range invalid**: Return error if start > end
3. **Memory exhausted**: Return partial results with truncation flag
4. **Network error**: Propagate from fetch_signals_data_batch
5. **JSON parse error**: Invalid signals_with_format input

### Error Response

```rust
Err(JsValue::from_str("Signal 'xyz' not found in cache"))
```

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
  ],
  // Optional: time unit conversion
  displayUnitPerLoD0Unit: 1000,  // LoD0 unit is ps, display is ns
  // Optional: prefix settings
  signalPrefix: 'work@',
  serverPrefix: '',
  spaceBeforeBracket: false,
  // Optional: cache settings
  enableOpfs: true,
  enableMemoryCache: true
});

// Result:
// {
//   searchStartTime: 1000000000,  // Converted to display units (ns)
//   searchEndTime: 2000000000,
//   data: [
//     { time: 1000000000, values: [
//       { displayStr: "0xABCD1234", valueType: "numeric", hasTransition: false },
//       { displayStr: "1024", valueType: "numeric", hasTransition: false }
//     ]},
//     { time: 1050000000, values: [
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

## Version History

- **v1.0** (Initial): Basic function signature and data structures
- **v1.1** (2026-03-18): 
  - Added optional cache control parameters
  - Added time unit conversion support
  - Added batch tile fetching (10 tiles per batch)
  - Added signal name prefix support
  - Updated data structures with camelCase serialization
  - Added BitExtractInfo struct
  - Updated algorithm with two-pass approach
- **v1.2** (Current, 2026-03-18): 
  - Added `lod` parameter to support LoD > 0 data
  - Added `has_toggle` field to `RawValue` to indicate bucket first/last pairs
  - Updated time collection to use `actual_time` for LoD > 0
  - Added detailed LoD > 0 data structure documentation
  - Updated TypeScript interfaces with new fields and parameters
