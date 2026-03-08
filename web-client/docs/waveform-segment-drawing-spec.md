# Waveform Segment Drawing Specification

## Overview

This document defines the rules for drawing waveform segments from tile-based data, supporting both LoD 0 (raw data) and LoD 1+ (first/last bucket data).

## Data Format

### Server Response Format (Updated)

Each tile returns for LoD 1+:

```
[Start Value] (time=0xFFFFFFFFFFFFFFFF, value=value before tile start)
[bucket 0] (time=0, value=first)                    <- if bucket has data
           (time=0, value=last)                     <- if bucket has multiple transitions
[bucket 1] (time=1, value=first)                    <- if bucket has data
           (time=1, value=last)                     <- if bucket has multiple transitions
...
[bucket 255] (time=255, value=first)                <- if bucket has data
             (time=255, value=last)                 <- if bucket has multiple transitions
```

### Key Points

1. **Start Value**: Always present, time = `BOUNDARY_TIME_START` (0xFFFFFFFFFFFFFFFF)
   - Value is the last value before tile start (searched backward)
   - If no previous value, defaults to 'X' (1-bit) or 'bXXX...X' (n-bit)

2. **LoD 0**: Normal transitions with absolute timestamps

3. **LoD 1+**: First/Last pairs with bucket offset (0-255)
   - **Time**: bucket offset within tile (0 to 255), NOT absolute time
   - **First**: value of first transition in bucket
   - **Last**: value of last transition in bucket (only present if multiple transitions)
   - **Empty bucket**: no records output for that bucket index

4. **Time Conversion**:
   ```
   bucket_absolute_time = tile_start + bucket_offset * (2^lod)
   ```

## Drawing Rules

### Rule 1: LoD 1+ Tile Drawing (Per Bucket)

For each tile at LoD 1+:

```
Value = start_value

FOR bucket_index from 0 to 255:
    bucket_start_time = tile_start + bucket_index * (2^lod)
    bucket_end_time = bucket_start_time + (2^lod)
    
    IF bucket_index not in tile.data:
        // Empty bucket: continue with current Value
        draw Value from bucket_start_time to bucket_end_time
        // Value remains unchanged
    ELSE IF tile.data[bucket_index] has first AND last:
        // Multiple transitions in bucket: draw toggling
        draw toggling from bucket_start_time to bucket_end_time
        Value = tile.data[bucket_index].last.value
    ELSE IF tile.data[bucket_index] has only first:
        // Single transition in bucket: draw stable value
        draw tile.data[bucket_index].first.value from bucket_start_time to bucket_end_time
        Value = tile.data[bucket_index].first.value
```

### Rule 2: First Tile Initial Segment

For the **first tile** in the viewport:

```
IF viewport_start < first_bucket_start_time:
    draw start_value from viewport_start to first_bucket_start_time
```

### Rule 3: Last Tile Final Segment

For the **last tile** in the viewport:

```
IF last_bucket_end_time < viewport_end:
    draw last_Value from last_bucket_end_time to viewport_end
```

### Rule 4: Cross-Tile Continuity

```
Tile 0: Value ends at last_bucket_last_value
Tile 1: start_value should equal Tile 0's last value (guaranteed by server)
```

## Algorithm

### Step 1: Parse Tile Data

```rust
fn parse_tile_data(data: &[u8], tile_start: u64, lod: u32) -> Vec<BucketData> {
    let bucket_size = 1u64 << lod;
    let mut buckets = Vec::new();
    
    // Parse start value (time = BOUNDARY_TIME_START)
    let start_value = parse_start_value(data);
    
    // Parse bucket data
    for each record in data:
        if record.time == BOUNDARY_TIME_START:
            continue;  // Skip start value
        
        let bucket_offset = record.time as u32;  // 0-255
        let bucket_start = tile_start + (bucket_offset as u64) * bucket_size;
        
        // Check if this is first or last for the bucket
        // (same offset means first/last pair)
    
    buckets
}
```

### Step 2: Generate Segments for LoD 1+

```rust
fn generate_lod_segments(
    tile_start: u64,
    lod: u32,
    buckets: &HashMap<u32, BucketData>,
    start_value: &str,
    viewport_start: u64,
    viewport_end: u64,
) -> Vec<RenderSegment> {
    let bucket_size = 1u64 << lod;
    let mut segments = Vec::new();
    let mut current_value = start_value.to_string();
    
    for bucket_idx in 0..256u32 {
        let bucket_start = tile_start + (bucket_idx as u64) * bucket_size;
        let bucket_end = bucket_start + bucket_size;
        
        // Skip if outside viewport
        if bucket_end < viewport_start || bucket_start > viewport_end {
            continue;
        }
        
        // Clamp to viewport
        let draw_start = bucket_start.max(viewport_start);
        let draw_end = bucket_end.min(viewport_end);
        
        match buckets.get(&bucket_idx) {
            None => {
                // Empty bucket: draw current value
                segments.push(RenderSegment {
                    time_start: draw_start,
                    time_end: draw_end,
                    value: current_value.clone(),
                    is_toggle: false,
                });
            }
            Some(bucket) => {
                if bucket.has_last() {
                    // Multiple transitions: draw toggling
                    segments.push(RenderSegment {
                        time_start: draw_start,
                        time_end: draw_end,
                        value: "toggling".to_string(),
                        is_toggle: true,
                        first_value: Some(bucket.first.value.clone()),
                        last_value: Some(bucket.last.value.clone()),
                    });
                    current_value = bucket.last.value.clone();
                } else {
                    // Single transition: draw stable value
                    segments.push(RenderSegment {
                        time_start: draw_start,
                        time_end: draw_end,
                        value: bucket.first.value.clone(),
                        is_toggle: false,
                    });
                    current_value = bucket.first.value.clone();
                }
            }
        }
    }
    
    segments
}
```

## Drawing Styles

### Single-Bit Signals

| Bucket State | Visual Style |
|--------------|--------------|
| Empty (continue value) | Horizontal line at current level (high/low) |
| Single transition | Horizontal line at transition value |
| First/Last pair (toggle) | **Toggling pattern**: gray box with diagonal lines or "toggling" text |

### Multi-Bit Signals

| Bucket State | Visual Style |
|--------------|--------------|
| Empty (continue value) | Rectangle with current value |
| Single transition | Rectangle with transition value |
| First/Last pair (toggle) | **Range display**: "first..last" or checkerboard pattern |

## Implementation Notes

1. **Time Conversion**: 
   - Server sends bucket offset (0-255)
   - Client converts to absolute time: `tile_start + offset * (2^lod)`

2. **Value State Tracking**:
   - Maintain `current_value` across buckets
   - Update after each non-empty bucket
   - Use for empty buckets and cross-tile continuity

3. **Toggling Detection**:
   - **Key change**: toggling = has first AND last (regardless of values)
   - Even if first.value == last.value, still draw as toggling

4. **Empty Bucket Handling**:
   - No data from server for that bucket index
   - Continue drawing with `current_value`
   - Do not change `current_value`

5. **Viewport Clipping**:
   - Clip each bucket to viewport boundaries
   - Handle partial buckets at viewport edges

## Constants

```rust
const BOUNDARY_TIME_START: u64 = 0xFFFFFFFFFFFFFFFF;
const TILE_SPAN_MULTIPLIER: u32 = 256;  // Buckets per tile
```

## Example Scenarios

### Scenario 1: Empty Buckets

```
Tile: time=0-1024, LoD=2 (bucket_size=4)
Buckets:
  [Start] value=0
  [0] offset=0, first=1           <- bucket 0 has data
  [1] empty                       <- bucket 1 empty
  [2] empty                       <- bucket 2 empty
  [3] offset=3, first=0, last=1   <- bucket 3 has toggle

Drawing:
  0-4: value=0 (start value, before bucket 0)
  4-8: value=1 (bucket 0)
  8-12: value=1 (bucket 1 empty, continue)
  12-16: value=1 (bucket 2 empty, continue)
  16-20: toggling (bucket 3)
```

### Scenario 2: Cross-Tile Continuity

```
Tile 0: time=0-1024
  [Start] value=0
  [255] offset=255, first=1, last=0  <- ends with value=0

Tile 1: time=1024-2048
  [Start] value=0  <- matches Tile 0's last value
  [0] offset=0, first=1

Drawing:
  Tile 0 ends with value=0
  Tile 1 starts with value=0 (continuous)
```

### Scenario 3: Toggle with Same Values

```
Tile: time=0-256, LoD=0 (but using LoD 1+ format)
Bucket:
  [Start] value=0
  [10] offset=10, first=1, last=1  <- first=last, but still toggle!

Drawing:
  0-10: value=0
  10-11: toggling (drawn as toggle even though first=last!)
```

## Migration from Min/Max to First/Last

### Key Changes

| Aspect | Old (Min/Max) | New (First/Last) |
|--------|---------------|------------------|
| Time | Absolute timestamp | Bucket offset (0-255) |
| Toggle condition | min ≠ max | has first AND last |
| Empty bucket | Use start value | Continue current value |
| Value progression | min→max | first→last |

### Client Adaptation

1. **Time parsing**: Convert offset to absolute time
2. **Toggle detection**: Check for first/last pair presence
3. **Value tracking**: Update with last.value after each bucket
4. **Empty handling**: Continue drawing with current value
