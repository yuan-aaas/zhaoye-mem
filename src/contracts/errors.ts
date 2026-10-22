import { ZodError } from 'zod';

export type ErrorCode =
  | 'INVALID_INPUT' | 'UNAUTHORIZED' | 'OUT_OF_SCOPE' | 'NOT_FOUND' | 'CONFLICT'
  | 'UNSUPPORTED' | 'SOURCE_UNAVAILABLE' | 'INDEX_PENDING' | 'COMMIT_UNKNOWN'
  | 'CORRUPT_DATA' | 'LOCKED' | 'BUDGET_EXCEEDED' | 'MODEL_NOT_CONFIGURED'
  | 'MODEL_ERROR' | 'TIMEOUT' | 'MAINTENANCE_REQUIRED';

const messages: Record<ErrorCode, string> = {
  INVALID_INPUT: '输入格式不正确，请检查命令参数。',
  UNAUTHORIZED: '当前操作没有明确授权。',
  OUT_OF_SCOPE: '目标超出已登记的项目或数据范围。',
  NOT_FOUND: '没有找到对应记录或任务。',
  CONFLICT: '数据版本已变化，请先重新查询后再操作。',
  UNSUPPORTED: '该功能尚未开放。',
  SOURCE_UNAVAILABLE: '此数据来源当前不可用。',
  INDEX_PENDING: '内容已保存，索引待修复；可重试查询恢复。',
  COMMIT_UNKNOWN: '提交结果暂时无法确认，请先运行 doctor 对账，不要重复执行。',
  CORRUPT_DATA: '本地数据校验失败，已停止写入；请先备份并检查。',
  LOCKED: '数据目录已被另一个助手进程占用。',
  BUDGET_EXCEEDED: '本次请求超过本地大小或调用预算。',
  MODEL_NOT_CONFIGURED: '尚未配置模型。设置 MODEL_API_KEY、MODEL_BASE_URL 和 MODEL_NAME 后重试。',
  MODEL_ERROR: '模型请求失败；未自动重试可能产生副作用的调用。',
  TIMEOUT: '操作超时，执行结果可能未知；请先查询任务状态。',
  MAINTENANCE_REQUIRED: '数据目录需要维护，当前只允许只读诊断。',
};

export class AssistantError extends Error {
  constructor(readonly code: ErrorCode, message = messages[code], readonly retry: 'never' | 'after_reconcile' = 'never') {
    super(message);
    this.name = 'AssistantError';
  }
}

export function userMessage(error: unknown): string {
  if (error instanceof AssistantError) return `${error.code}: ${error.message}`;
  if (error instanceof ZodError) return 'INVALID_INPUT: 输入格式不正确，请检查参数和 schema。';
  return 'INTERNAL_ERROR: 操作失败。详细内容未写入日志，请检查本地运行环境。';
}

