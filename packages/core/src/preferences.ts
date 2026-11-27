import { accessPreferenceId, LIMITS } from '@zhaoye/contracts';

export const replyPreferenceId = 'concise-natural-replies';
export const detailedReplyPreference = '回答先给结论，再补充理由和与问题相关的细节。';

export interface PreferenceChange {
  id: string;
  text: string;
  operation: 'remember' | 'forget';
}

/** Recognize durable requests in a human message. Evidence and authorization are checked by the host. */
export function explicitPreference(message: string): PreferenceChange | null {
  const value = message.trim();
  if (/[\r\n`「」『』]/u.test(value) || /^(?:只在|这次|本轮|今天)/u.test(value)) return null;
  if (/^(?:别再记着|忘掉|取消)(?:我|那条)?(?:读不到|没有权限)/u.test(value))
    return { id: accessPreferenceId, text: '', operation: 'forget' };
  const forget = /^(?:请)?(?:忘掉|取消)(?:这条偏好)?[：:]\s*(.+)$/u.exec(value)?.[1];
  if (forget && [...forget].length <= LIMITS.profileText) {
    const match = explicitPreference(`以后${forget}`);
    return { id: match?.id ?? '', text: forget, operation: 'forget' };
  }
  if (/^(?:请)?(?:以后|今后|(?:长期)?记住|我的长期偏好|我希望以后)/u.test(value)) {
    if (
      /(?:读不到|看不到|打不开|没有权限).{0,20}(?:[，,就]\s*)?(?:先问我|直接问我|先向我|先找我)/u.test(
        value,
      ) &&
      !/(?:别|不要|无需|不用)问我/u.test(value)
    )
      return {
        id: accessPreferenceId,
        text: '读不到文件或数据时，先说清楚缺的是路径还是权限，并直接向用户询问。',
        operation: 'remember',
      };
    if (/(?:回复|回答)(?:都|请|尽量|要|先|默认|习惯)?(?:简短|简洁|一两句|短一点)/u.test(value))
      return {
        id: replyPreferenceId,
        text: '回答先说重点。日常简短，用户追问时再展开细节。',
        operation: 'remember',
      };
    if (/(?:回复|回答)(?:都|请|尽量|要|先|默认|习惯)?(?:详细|展开|多说一点)/u.test(value))
      return {
        id: replyPreferenceId,
        text: detailedReplyPreference,
        operation: 'remember',
      };
    const explicit =
      /^(?:请)?(?:长期)?记住(?:这个|这条|我的长期(?:协作)?偏好)?[：:，,]\s*(.+)$/u.exec(value);
    if (
      explicit?.[1] &&
      [...explicit[1]].length <= LIMITS.profileText &&
      !/^(?:今天|这次|本轮|只在|项目|我昨天|我今天)/u.test(explicit[1])
    )
      return { id: '', text: explicit[1], operation: 'remember' };
  }
  return null;
}

export function inferredPreference(message: string): boolean {
  return (
    message.length <= 300 &&
    /^(?:我(?:更|比较)喜欢|我习惯|我倾向于).{0,24}(?:回复|回答|沟通|先给结论|先问我)/u.test(
      message.trim(),
    ) &&
    !/[\n`]/u.test(message)
  );
}
