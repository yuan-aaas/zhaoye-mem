export interface DshPluginContext {
  host_id: string;
  registerTool?: (name: string, handler: (...args: unknown[]) => unknown) => void;
}
