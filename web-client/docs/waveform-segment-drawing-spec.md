# Waveform Segment Drawing Specification

## Overview

This document defines the rules for drawing waveform segments from tile-based data, supporting both LoD 0 (raw data) and LoD 1+ (min/max bucket data).

## Data Format

### Server Response Format

Each tile returns:

```
[Start Value] (time=0xFFFFFFFFFFFFFFFF, value=<value at tile start>)
[Transition 1] (time=t1, value=v1)  <- For LoD 0: actual transition
                                      <- For LoD 1+: min value
[Transition 2] (time=t1, value=v2)  <- For LoD 1+: max value (if min≠max)
[Transition 3] (time=t2, value=v3)  <- Next bucket
...
```

### Key Points

1. **Start Value**: Always present, time = `BOUNDARY_TIME_START` (0xFFFFFFFFFFFFFFFF)
2. **LoD 0**: Normal transitions with actual timestamps
3. **LoD 1+**: Min/Max pairs with same timestamp (bucket end time)
   - If min = max: only one record
   - If min ≠ max: two records (min first, max second)

## Drawing Rules

### Rule 1: First Tile Handling

For the **first tile** in the viewport:

```
IF tile has no normal transitions (only start value):
    Draw single segment from viewport_start to viewport_end
    Value = start_value
ELSE:
    Draw segment from viewport_start to first_transition.time
    Value = start_value
    
    FOR each transition i:
        Draw segment from transition[i].time to transition[i+1].time
        Value = transition[i].value
    
    Draw segment from last_transition.time to viewport_end
    Value = last_transition.value
```

### Rule 2: Non-First Tile Handling

For **subsequent tiles**:

```
IF tile has no normal transitions (only start value):
    // Use the last draw value from previous tile
    Draw single segment from tile_start to tile_end
    Value = previous_tile_last_draw_value
ELSE:
    // Note: No initial segment needed, continues from previous tile
    
    FOR each transition i:
        Draw segment from transition[i].time to transition[i+1].time
        Value = transition[i].value
    
    Draw segment from last_transition.time to tile_end
    Value = last_transition.value
```

**Important**: For non-first tiles without transitions, the segment should use the **last draw value from the previous tile**, not this tile's start value. This ensures waveform continuity across tiles.

**Viewport End Handling**: If the last tile's end time is before the viewport end time, extend the last segment to viewport_end using the last drawn value:

```
IF last_tile_end < viewport_end:
    Draw segment from last_tile_end to viewport_end
    Value = last_drawn_value
```

### Rule 3: Min/Max Handling (LoD 1+)

For LoD 1+ data with min/max pairs:

```
IF current transition has same time as next transition:
    // This is a min/max pair
    Draw segment from current_time to next_bucket_time
    Value = "toggling" (for 1-bit) or "min..max" (for multi-bit)
    Skip the max transition (don't draw separate segment)
ELSE:
    // Single value (min=max)
    Draw segment from current_time to next_bucket_time
    Value = current_value
```

## Algorithm

### Step 1: Parse Tile Data

```rust
fn parse_tile_data(data: &[u8]) -> Vec<Transition> {
    // Parse start value (time = BOUNDARY_TIME_START)
    // Parse normal transitions
    // For LoD 1+: Group min/max pairs by timestamp
}
```

### Step 2: Filter and Sort

```rust
fn process_transitions(transitions: Vec<Transition>, is_first_tile: bool) -> Vec<Transition> {
    // Separate start value from normal transitions
    // Sort normal transitions by time
    // Return filtered list
}
```

### Step 3: Generate Segments

```rust
fn generate_segments(
    transitions: &[Transition],
    start_value: Option<&Transition>,
    is_first_tile: bool,
    viewport_start: f64,
    viewport_end: f64,
) -> Vec<RenderSegment> {
    let mut segments = Vec::new();
    
    if transitions.is_empty() {
        // No normal transitions, draw start value across entire range
        if let Some(sv) = start_value {
            segments.push(RenderSegment {
                x0: viewport_start,
                x1: viewport_end,
                value: sv.value,
            });
        }
        return segments;
    }
    
    // First tile: draw from viewport start to first transition
    if is_first_tile {
        if let Some(sv) = start_value {
            segments.push(RenderSegment {
                x0: viewport_start,
                x1: transitions[0].time,
                value: sv.value,
            });
        }
    }
    
    // Draw transitions
    for i in 0..transitions.len() {
        let t0 = transitions[i].time;
        let t1 = if i + 1 < transitions.len() {
            transitions[i + 1].time
        } else {
            viewport_end
        };
        
        // Check for min/max pair (same timestamp)
        if i + 1 < transitions.len() && transitions[i].time == transitions[i + 1].time {
            // Min/Max pair - draw as toggling or range
            segments.push(RenderSegment {
                x0: t0,
                x1: t1,
                value: format_min_max(&transitions[i].value, &transitions[i + 1].value),
            });
            // Skip max transition
            continue;
        }
        
        segments.push(RenderSegment {
            x0: t0,
            x1: t1,
            value: transitions[i].value.clone(),
        });
    }
    
    segments
}
```

## Edge Cases

### Empty Tile

When a tile has no transitions in the requested range:
- Returns only start value
- Draw as horizontal line with start value

### Cross-Tile Continuity

Tiles are processed in time order:
1. Sort tiles by tile_id
2. Process each tile sequentially
3. Previous tile's last value becomes implicit start for next tile

### Min/Max Display

For cursor value query at time T:

```rust
fn get_value_at_time(transitions: &[Transition], time: u64) -> String {
    // Find bucket containing time T
    for i in 0..transitions.len() {
        if transitions[i].time > time {
            // Check if previous is min/max pair
            if i > 1 && transitions[i - 2].time == transitions[i - 1].time {
                return format("{}..{}", transitions[i - 2].value, transitions[i - 1].value);
            }
            return transitions[i - 1].value.clone();
        }
    }
    // Return last value
    transitions.last().map(|t| t.value.clone()).unwrap_or_default()
}
```

## Implementation Notes

1. **Time Conversion**: Convert u64 timestamps to f64 pixel coordinates
2. **Value Classification**: Use `classify_value()` to determine value type (zero/one/mixed)
3. **Rendering**: Single-bit signals use yHigh/yLow, multi-bit use min/max display
4. **Caching**: Store parsed transitions in signal_data cache for cursor queries

## Constants

```rust
const BOUNDARY_TIME_START: u64 = 0xFFFFFFFFFFFFFFFF;
```

## Example Scenarios

### Scenario 1: First Tile with Transitions

```
Tile 0: time=0-1000
Transitions:
  [Start] time=MAX, value=0
  [0] time=100, value=1
  [1] time=500, value=0

Segments:
  0-100: value=0 (start value)
  100-500: value=1
  500-1000: value=0
```

### Scenario 2: Non-First Tile with Transitions

```
Tile 1: time=1000-2000
Transitions:
  [Start] time=MAX, value=0 (from previous tile end)
  [0] time=1200, value=1
  [1] time=1500, value=0

Segments:
  1000-1200: value=0 (continues from previous)
  1200-1500: value=1
  1500-2000: value=0
```

### Scenario 3: Tile with Min/Max

```
Tile 0: time=0-1000, LoD=2
Transitions:
  [Start] time=MAX, value=0
  [0] time=256, value=0 (min)
  [1] time=256, value=1 (max)
  [2] time=512, value=1 (min=max)

Segments:
  0-256: value=0 (start value)
  256-512: toggling (0..1)
  512-1000: value=1
```

### Scenario 4: Empty Tile

```
Tile 0: time=0-1000
Transitions:
  [Start] time=MAX, value=1
  (no normal transitions)

Segments:
  0-1000: value=1
```
