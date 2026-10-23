/**
 * PluginSlotManager — Exclusive slot system for plugin capabilities
 *
 * Manages named capability slots where only one plugin can occupy each slot.
 * Examples: "memory" (one memory plugin), "tts" (one TTS plugin),
 * "search" (one search override plugin).
 *
 * @layer Application
 * @phase 13 — Plugin Hook Pipeline (OpenClaw extraction)
 * @donor external/openclaw/src/plugins/slots.ts (109L) — adapted for DI
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Well-known slot names for plugin capability exclusivity.
 */
export type PluginSlotName =
  | 'memory'
  | 'tts'
  | 'search'
  | 'embedding'
  | 'moderation'
  | string; // Allow custom slot names

/**
 * Slot occupancy record.
 */
export interface SlotOccupancy {
  readonly slotName: PluginSlotName;
  readonly pluginId: string;
  readonly claimedAt: Date;
}

/**
 * Slot manager health report.
 */
export interface SlotManagerHealth {
  readonly totalSlots: number;
  readonly occupiedSlots: number;
  readonly slots: ReadonlyArray<SlotOccupancy>;
}

// ─── Interface ───────────────────────────────────────────────────────────────

export interface IPluginSlotManager {
  claim(slotName: PluginSlotName, pluginId: string): boolean;
  release(slotName: PluginSlotName, pluginId: string): boolean;
  getOccupant(slotName: PluginSlotName): string | undefined;
  isOccupied(slotName: PluginSlotName): boolean;
  getHealth(): SlotManagerHealth;
}

// ─── Implementation ──────────────────────────────────────────────────────────

export class PluginSlotManager implements IPluginSlotManager {
  private readonly slots = new Map<PluginSlotName, SlotOccupancy>();

  /**
   * Claim an exclusive slot for a plugin.
   *
   * @returns true if claimed successfully, false if slot already occupied by another plugin
   */
  claim(slotName: PluginSlotName, pluginId: string): boolean {
    const existing = this.slots.get(slotName);

    if (existing) {
      // Same plugin reclaiming → ok (idempotent)
      if (existing.pluginId === pluginId) return true;
      // Different plugin → blocked
      return false;
    }

    this.slots.set(slotName, {
      slotName,
      pluginId,
      claimedAt: new Date(),
    });

    return true;
  }

  /**
   * Release a slot held by a specific plugin.
   *
   * @returns true if released, false if slot not held by this plugin
   */
  release(slotName: PluginSlotName, pluginId: string): boolean {
    const existing = this.slots.get(slotName);
    if (!existing || existing.pluginId !== pluginId) return false;

    this.slots.delete(slotName);
    return true;
  }

  /**
   * Get the plugin occupying a slot.
   */
  getOccupant(slotName: PluginSlotName): string | undefined {
    return this.slots.get(slotName)?.pluginId;
  }

  /**
   * Check if a slot is occupied.
   */
  isOccupied(slotName: PluginSlotName): boolean {
    return this.slots.has(slotName);
  }

  /**
   * Get health report with slot occupancy metrics.
   */
  getHealth(): SlotManagerHealth {
    return {
      totalSlots: this.slots.size,
      occupiedSlots: this.slots.size,
      slots: Array.from(this.slots.values()),
    };
  }
}
