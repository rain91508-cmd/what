/**
 * OPFS Cache Module
 * 
 * Exports all cache-related functionality
 */

export { SignalIdManager, getSignalIdManager, clearSignalIdManagerCache } from './signalIdManager';
export { 
  opfsRead, 
  opfsWrite, 
  opfsExists, 
  opfsDelete, 
  opfsList,
  getStorageEstimate,
  isOpfsSupported,
  clearWaveformCache 
} from './opfsAccess';
