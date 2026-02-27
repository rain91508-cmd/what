// Mock waveform data generator and manager
// Each hierarchy generates mock data only once

// Time unit conversions (to picoseconds)
export const TIME_UNIT_MULTIPLIERS = {
  ps: 1,
  ns: 1000,
  us: 1000000,
  ms: 1000000000,
  s: 1000000000000,
};

export type TimeUnit = 'ps' | 'ns' | 'us' | 'ms' | 's';

export interface Transition {
  time: number; // in ps
  value: 0 | 1;
}

export interface SignalMockData {
  fullPath: string;
  transitions: Transition[];
  maxTime: number; // maximum time in ps
  minUnitTime: number; // minimum unit time in ps (integer)
}

// Global cache for mock data - key is hierarchy path
const mockDataCache = new Map<string, SignalMockData>();

// Maximum time for mock data (in ps) - 1000 ns = 1 us
const MAX_TIME_PS = 1000000; // 1000 ns = 1,000,000 ps

// Number of transitions per signal
const TRANSITION_COUNT = 100;

// Minimum unit time (1 ps)
const MIN_UNIT_TIME_PS = 1;

/**
 * Generate mock waveform data for a signal
 * Each hierarchy generates data only once
 */
export function getOrCreateMockData(fullPath: string): SignalMockData {
  // Check cache first
  if (mockDataCache.has(fullPath)) {
    return mockDataCache.get(fullPath)!;
  }

  // Generate new mock data
  const transitions: Transition[] = [];
  
  // Generate random transition times (sorted) in ps
  const transitionTimes: number[] = [];
  for (let i = 0; i < TRANSITION_COUNT; i++) {
    transitionTimes.push(Math.floor(Math.random() * MAX_TIME_PS));
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
  let minInterval = MAX_TIME_PS;
  for (let i = 1; i < transitionTimes.length; i++) {
    const interval = transitionTimes[i] - transitionTimes[i - 1];
    if (interval > 0 && interval < minInterval) {
      minInterval = interval;
    }
  }
  // Minimum unit time is the smallest interval, or 1 ps if no transitions
  const minUnitTime = Math.max(MIN_UNIT_TIME_PS, Math.floor(minInterval / 10));

  const mockData: SignalMockData = {
    fullPath,
    transitions,
    maxTime: MAX_TIME_PS,
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
