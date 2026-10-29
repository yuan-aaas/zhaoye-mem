/**
 * `presence/owner.json` 的公开投影。
 * 字段与 ARCHITECTURE §6.3 的 owner.json 示例保持一致。
 */
export interface OwnerInfo {
  host: string;
  host_name: string;
  pid: number;
  instance_id: string;
  session_id?: string;
  started_at: string;
  heartbeat_at: string;
  heartbeat_interval_ms: number;
  assistant_id: string;
  adapter_version: string;
}
