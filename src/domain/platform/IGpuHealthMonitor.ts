export type GpuHealthStatus = 'healthy' | 'unavailable' | 'error';

export interface GpuDeviceInfo {
  vendor: string;
  model: string;
  memoryMb: number;
}

export interface GpuHealthReport {
  status: GpuHealthStatus;
  available: boolean;
  gpus: GpuDeviceInfo[];
  checkedAt: Date;
  containerName: string;
  error?: string;
}

export interface IGpuHealthMonitor {
  checkHealth(containerName: string): Promise<GpuHealthReport>;
}