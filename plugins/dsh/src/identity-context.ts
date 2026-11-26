import {
  BUDGETS,
  type ContinuityEntry,
  DSH_PERSONA_CODE_POINTS,
  type IdentityDocument,
  type ProfileEntry,
  type ProjectEntry,
  SECTION_NAMES,
  type SectionName,
  SectionNameSchema,
  ZhaoyeError,
} from '@zhaoye/contracts';

interface ReadArguments {
  section?: string | undefined;
  revision?: string | undefined;
  cursor?: string | undefined;
  item_id?: string | undefined;
  field?: string | undefined;
  offset?: string | undefined;
}

type Entry = ContinuityEntry | ProfileEntry | ProjectEntry;

function sectionName(input: string | undefined): SectionName {
  const parsed = SectionNameSchema.safeParse(input);
  if (!parsed.success) throw new ZhaoyeError('INVALID_INPUT', '请指定画像目录中的 section');
  return parsed.data;
}

function entries(document: IdentityDocument, section: SectionName): Entry[] {
  switch (section) {
    case 'user_profile':
      return [...document.user_profile.facts, ...document.user_profile.preferences];
    case 'character_profile':
      return document.character_profile.traits;
    case 'project_state':
      return document.project_state.projects;
    case 'continuity_memory':
      return document.continuity_memory.entries;
    case 'safety_kernel':
      throw new ZhaoyeError('INVALID_INPUT', '安全内核只支持按章节读取');
  }
}

function entryId(entry: Entry): string {
  return 'project_id' in entry ? entry.project_id : entry.id;
}

function comparable(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
}

function match(entry: Entry, query: string) {
  const id = entryId(entry);
  const title = 'project_id' in entry ? entry.name : 'text' in entry ? entry.text : entry.summary;
  const body =
    'project_id' in entry
      ? [entry.goal, ...entry.decisions, ...entry.progress, ...entry.blockers, ...entry.next_steps]
      : [];
  const normalizedId = comparable(id);
  const normalizedTitle = comparable(title);
  const excerpt = body.find((text) => comparable(text).includes(query));
  const updated = Date.parse(entry.updated_at);
  return {
    rank:
      normalizedId === query
        ? 4
        : normalizedTitle === query
          ? 3
          : normalizedId.includes(query) || normalizedTitle.includes(query)
            ? 2
            : excerpt !== undefined
              ? 1
              : 0,
    updated,
    hit: {
      item_id: id,
      summary: [...(excerpt ?? title)].slice(0, 28).join(''),
      updated_at: new Date(updated).toISOString(),
    },
  };
}

export function findIdentityItems(
  document: IdentityDocument,
  section: string,
  query: string,
  revision?: string,
) {
  assertRevision(document, revision);
  const selected = sectionName(section);
  const key = comparable(query);
  if (!key) throw new ZhaoyeError('INVALID_INPUT', '画像查找词不能为空');
  const matches = entries(document, selected)
    .map((entry) => match(entry, key))
    .filter((result) => result.rank > 0)
    .sort(
      (a, b) =>
        b.rank - a.rank || b.updated - a.updated || a.hit.item_id.localeCompare(b.hit.item_id),
    );
  const [first, second] = matches;
  const status =
    first === undefined
      ? 'no_match'
      : second?.rank === first.rank && first.rank < 4
        ? 'ambiguous'
        : 'found';
  const result = {
    revision: document.revision,
    section: selected,
    status,
    hits: matches.slice(0, 3).map(({ hit }) => hit),
    more: matches.length > 3,
  };
  while ([...JSON.stringify(result)].length > DSH_PERSONA_CODE_POINTS.findResult) {
    result.hits.pop();
    result.more = true;
  }
  return result;
}

function assertRevision(document: IdentityDocument, revision: string | undefined): void {
  if (revision !== undefined && !/^[1-9]\d{0,11}$/.test(revision))
    throw new ZhaoyeError('INVALID_INPUT', 'revision 必须是目录中的版本号');
  if (revision !== undefined && Number(revision) !== document.revision)
    throw new ZhaoyeError('CONFLICT', '画像版本已变更，请重新读取目录和所需章节', {
      revision: document.revision,
    });
}

export function readIdentityPage(document: IdentityDocument, args: ReadArguments) {
  if (args.item_id !== undefined || args.field !== undefined || args.offset !== undefined) {
    return readIdentityItem(document, args);
  }
  if (args.section === undefined && args.revision === undefined && args.cursor === undefined) {
    return { revision: document.revision, sections: SECTION_NAMES };
  }

  let section: string | undefined = args.section;
  let revision = args.revision;
  let offset = 0;
  if (args.cursor !== undefined) {
    if (section !== undefined || revision !== undefined) {
      throw new ZhaoyeError('INVALID_INPUT', 'cursor 须单独传入');
    }
    const match = /^([a-z_]+):([1-9]\d{0,11}):([1-9]\d{0,5})$/.exec(args.cursor);
    if (!match) throw new ZhaoyeError('INVALID_INPUT', '画像分页游标无效');
    [, section, revision] = match;
    offset = Number(match[3]);
  }
  const selected = sectionName(section);
  assertRevision(document, revision);
  return pageSection(document, selected, offset);
}

function pageSection(document: IdentityDocument, section: SectionName, offset: number) {
  return pageContent(JSON.stringify(document[section], null, 2), offset, (content, next) => ({
    revision: document.revision,
    section,
    content,
    next_cursor: next === null ? null : `${section}:${document.revision}:${next}`,
  }));
}

function readIdentityItem(document: IdentityDocument, args: ReadArguments) {
  const { cursor, field, item_id, offset, revision } = args;
  if (cursor !== undefined || item_id === undefined)
    throw new ZhaoyeError('INVALID_INPUT', '条目读取需要 item_id，续读使用 offset');
  if (offset !== undefined && (revision === undefined || !/^[1-9]\d{0,5}$/.test(offset))) {
    throw new ZhaoyeError('INVALID_INPUT', '条目续读需要有效 offset 和 revision');
  }
  assertRevision(document, revision);
  const section = sectionName(args.section);
  const entry = entries(document, section).find((item) => entryId(item) === item_id);
  if (!entry) throw new ZhaoyeError('NOT_FOUND', '当前范围没有该画像条目');
  if (field !== undefined && !Object.hasOwn(entry, field))
    throw new ZhaoyeError('INVALID_INPUT', '该条目没有指定字段');
  const value: unknown = field === undefined ? entry : entry[field as keyof Entry];
  const source = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return pageContent(source, Number(offset ?? 0), (content, next) => ({
    revision: document.revision,
    section,
    item_id,
    ...(field !== undefined ? { field } : {}),
    updated_at: new Date(entry.updated_at).toISOString(),
    content,
    next_offset: next === null ? null : String(next),
  }));
}

export function pageContent<T>(
  source: string,
  offset: number,
  createPage: (content: string, next: number | null) => T,
): T {
  const content = [...source];
  if (offset > 0 && offset >= content.length)
    throw new ZhaoyeError('INVALID_INPUT', '分页位置超出范围');
  const page = (end: number) =>
    createPage(content.slice(offset, end).join(''), end < content.length ? end : null);

  const budget = BUDGETS.toolResultCodePoints;
  // Measure the serialized tool result, including JSON escaping and the continuation cursor.
  const last = Math.min(content.length, offset + budget);
  if ([...JSON.stringify(page(last))].length <= budget) return page(last);
  let lo = offset + 1;
  let hi = last - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ([...JSON.stringify(page(mid))].length <= budget) lo = mid + 1;
    else hi = mid - 1;
  }
  if (hi <= offset) throw new ZhaoyeError('BUDGET_EXCEEDED', '返回的元数据超出工具预算');
  // Prefer a nearby record boundary, while allowing long individual lines to span pages.
  const lineEnd = content.lastIndexOf('\n', hi - 1) + 1;
  const end = lineEnd > offset && hi - lineEnd <= 200 ? lineEnd : hi;
  return page(end);
}
