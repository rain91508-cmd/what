// ============================================
// Driver Manager - Manage Driver Groups for Drivers Tab
// ============================================

import type { DriverGroup, DriverClickInfo } from '../../types/driver';

type DriverChangeListener = () => void;

class DriverManager {
  private driverGroups: DriverGroup[] = [];
  private listeners: DriverChangeListener[] = [];

  /**
   * Subscribe to driver group changes
   */
  subscribe(listener: DriverChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Notify all listeners of changes
   */
  private notify() {
    this.listeners.forEach(listener => listener());
  }

  /**
   * Get all driver groups
   */
  getDriverGroups(): DriverGroup[] {
    return [...this.driverGroups];
  }

  /**
   * Add a new driver group
   */
  addDriverGroup(info: DriverClickInfo & { drivers: Array<{ driverSignalGlobalId: number; line: number; driverDeclarationLine?: number }> }): string {
    const id = `driver_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const group: DriverGroup = {
      id,
      targetSignal: info.targetSignal,
      clickLocation: info.clickLocation,
      drivers: info.drivers.map(d => ({
        driverSignalGlobalId: d.driverSignalGlobalId,
        line: d.line,
        driverDeclarationLine: d.driverDeclarationLine,
      })),
      isExpanded: true,
      createdAt: Date.now(),
    };

    this.driverGroups.push(group);
    this.notify();
    return id;
  }

  /**
   * Delete a driver group
   */
  deleteDriverGroup(id: string): void {
    const index = this.driverGroups.findIndex(g => g.id === id);
    if (index !== -1) {
      this.driverGroups.splice(index, 1);
      this.notify();
    }
  }

  /**
   * Toggle group expanded state
   */
  toggleGroupExpanded(id: string): void {
    const group = this.driverGroups.find(g => g.id === id);
    if (group) {
      group.isExpanded = !group.isExpanded;
      this.notify();
    }
  }

  /**
   * Update driver full name (after async lookup)
   */
  updateDriverFullName(groupId: string, driverIndex: number, fullName: string): void {
    const group = this.driverGroups.find(g => g.id === groupId);
    if (group && group.drivers[driverIndex]) {
      group.drivers[driverIndex].driverFullName = fullName;
      this.notify();
    }
  }

  /**
   * Update driver file ID (after async lookup)
   */
  updateDriverFileId(groupId: string, driverIndex: number, fileId: number): void {
    const group = this.driverGroups.find(g => g.id === groupId);
    if (group && group.drivers[driverIndex]) {
      group.drivers[driverIndex].fileId = fileId;
      this.notify();
    }
  }

  /**
   * Clear all driver groups
   */
  clearAll(): void {
    this.driverGroups = [];
    this.notify();
  }

  /**
   * Get driver group count
   */
  getCount(): number {
    return this.driverGroups.length;
  }
}

// Singleton instance
export const driverManager = new DriverManager();
