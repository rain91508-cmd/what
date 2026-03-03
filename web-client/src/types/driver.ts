// ============================================
// Driver Types for Message Window Drivers Tab
// ============================================

import type { DriverLocation } from './kdb';

/**
 * Single driver entry information
 */
export interface DriverEntry {
  /** Driver signal global ID */
  driverSignalGlobalId: number;
  /** Source line number where driver is located (assignment line) */
  line: number;
  /** Driver signal declaration line (where signal is defined) */
  driverDeclarationLine?: number;
  /** Driver signal full name (computed) */
  driverFullName?: string;
  /** Driver file ID */
  fileId?: number;
}

/**
 * Driver group - represents a clicked signal and its drivers
 */
export interface DriverGroup {
  /** Unique ID for this group */
  id: string;
  /** The signal that was clicked (target signal) */
  targetSignal: {
    /** Signal global ID */
    globalId: number;
    /** Signal full name */
    fullName: string;
    /** Parent module ID */
    parentModuleId: number;
  };
  /** Click location info */
  clickLocation: {
    /** File ID where click occurred */
    fileId: number;
    /** Line number where click occurred */
    lineNumber: number;
    /** File name */
    fileName: string;
  };
  /** Driver locations from signal */
  drivers: DriverEntry[];
  /** Whether the group is expanded */
  isExpanded: boolean;
  /** Timestamp when created */
  createdAt: number;
}

/**
 * Props for driver click handler
 */
export interface DriverClickInfo {
  /** Target signal info */
  targetSignal: {
    globalId: number;
    fullName: string;
    parentModuleId: number;
  };
  /** Click location */
  clickLocation: {
    fileId: number;
    lineNumber: number;
    fileName: string;
  };
  /** Driver locations */
  drivers: DriverLocation[];
}
