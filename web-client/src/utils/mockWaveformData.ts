// Mock waveform data generator and manager
// Each hierarchy generates mock data only once
// All times are in LoD0Units (integers)

export interface Transition {
  time: number; // in LoD0Units (integer)
  value: 0 | 1;
}

export interface SignalMockData {
  fullPath: string;
  transitions: Transition[];
  maxTime: number; // maximum time in LoD0Units (integer)
  minUnitTime: number; // minimum unit time in LoD0Units (integer)
}

// Global cache for mock data - key is hierarchy path
const mockDataCache = new Map<string, SignalMockData>();

// Maximum time for mock data (in LoD0Units) - 1000 units
// LoD0Unit = time_unit (server's time unit, typically 1ns)
const MAX_TIME_LOD0 = 1000; // 1000 LoD0Units

// Number of transitions per signal
const TRANSITION_COUNT = 100;

// Minimum unit time (1 LoD0Unit)
const MIN_UNIT_TIME_LOD0 = 1;

/**
 * Generate mock waveform data for a signal
 * Each hierarchy generates data only once
 * All times are in LoD0Units (integers)
 */
export function getOrCreateMockData(fullPath: string): SignalMockData {
  // Check cache first
  if (mockDataCache.has(fullPath)) {
    return mockDataCache.get(fullPath)!;
  }

  // Generate new mock data
  const transitions: Transition[] = [];

  // Generate random transition times (sorted) in LoD0Units
  const transitionTimes: number[] = [];
  for (let i = 0; i < TRANSITION_COUNT; i++) {
    transitionTimes.push(Math.floor(Math.random() * MAX_TIME_LOD0));
  }
  transitionTimes.sort((a, b) => a - b);

  // Generate alternating values starting from random initial value
  let currentValue: 0 | 1 = Math.random() > 0.5 ? 1 : 0;

  for (const time of transitionTimes) {
    transitions.push({
      time,
      value: currentValue,
    });
    currentValue = currentValue === 0 ? 1 : 0;
  }

  // Calculate minimum unit time based on minimum transition interval
  let minInterval = MAX_TIME_LOD0;
  for (let i = 1; i < transitionTimes.length; i++) {
    const interval = transitionTimes[i] - transitionTimes[i - 1];
    if (interval > 0 && interval < minInterval) {
      minInterval = interval;
    }
  }
  // Minimum unit time is the smallest interval, or 1 LoD0Unit if no transitions
  const minUnitTime = Math.max(MIN_UNIT_TIME_LOD0, Math.floor(minInterval / 10));

  const mockData: SignalMockData = {
    fullPath,
    transitions,
    maxTime: MAX_TIME_LOD0,
    minUnitTime,
  };

  // Cache the data
  mockDataCache.set(fullPath, mockData);

  return mockData;
}

/**
 * Get mock data for a signal if it exists
 */
export function getMockData(fullPath: string): SignalMockData | undefined {
  return mockDataCache.get(fullPath);
}

/**
 * Check if mock data exists for a signal
 */
export function hasMockData(fullPath: string): boolean {
  return mockDataCache.has(fullPath);
}

/**
 * Get transitions within a time range
 */
export function getTransitionsInRange(
  mockData: SignalMockData,
  timeStart: number,
  timeEnd: number
): Transition[] {
  return mockData.transitions.filter(
    t => t.time >= timeStart && t.time <= timeEnd
  );
}

/**
 * Get the value of a signal at a specific time
 */
export function getValueAtTime(mockData: SignalMockData, time: number): 0 | 1 {
  // Find the last transition before or at the given time
  let lastValue: 0 | 1 = 0;
  
  for (const transition of mockData.transitions) {
    if (transition.time <= time) {
      lastValue = transition.value;
    } else {
      break;
    }
  }
  
  return lastValue;
}

/**
 * Clear all mock data (useful for testing)
 */
export function clearMockData(): void {
  mockDataCache.clear();
}

/**
 * Get all cached hierarchy paths
 */
export function getCachedPaths(): string[] {
  return Array.from(mockDataCache.keys());
}
