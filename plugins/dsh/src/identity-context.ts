import {
  BUDGETS,
  type IdentityDocument,
  SECTION_NAMES,
  type SectionName,
  SectionNameSchema,
  ZhaoyeError,
} from '@zhaoye/contracts';

interface ReadArguments {
  section?: string | undefined;
  revision?: string | undefined;
  cursor?: string | undefined;
}

export function readIdentityPage(document: IdentityDocument, args: ReadArguments) {
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
  const parsed = SectionNameSchema.safeParse(section);
  if (!parsed.success) throw new ZhaoyeError('INVALID_INPUT', '请指定画像目录中的 section');
  if (revision !== undefined && !/^[1-9]\d{0,11}$/.test(revision)) {
    throw new ZhaoyeError('INVALID_INPUT', 'revision 必须是目录中的版本号');
  }
  if (revision !== undefined && Number(revision) !== document.revision) {
    throw new ZhaoyeError('CONFLICT', '画像版本已变更，请重新读取目录和所需章节', {
      revision: document.revision,
    });
  }
  return pageSection(document, parsed.data, offset);
}

function pageSection(document: IdentityDocument, section: SectionName, offset: number) {
  const content = [...JSON.stringify(document[section], null, 2)];
  if (offset >= content.length) throw new ZhaoyeError('INVALID_INPUT', '画像分页游标超出范围');

  function page(end: number) {
    return {
      revision: document.revision,
      section,
      content: content.slice(offset, end).join(''),
      next_cursor: end < content.length ? `${section}:${document.revision}:${end}` : null,
    };
  }

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
  // Prefer a nearby record boundary, while allowing long individual lines to span pages.
  const lineEnd = content.lastIndexOf('\n', hi - 1) + 1;
  const end = lineEnd > offset && hi - lineEnd <= 200 ? lineEnd : hi;
  return page(end);
}
