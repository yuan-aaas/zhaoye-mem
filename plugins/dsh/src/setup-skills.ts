import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ZhaoyeError } from '@zhaoye/contracts';
import type { SetupSkill } from './setup-api.js';

function missing(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function info(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
}

const skillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export async function inspectSkills(root: string, destination: string, installed: Set<string>) {
  const assets = join(root, 'assets');
  const base = join(assets, 'files');
  if (!(await info(assets))?.isDirectory() || !(await info(base))?.isDirectory()) return [];
  const skills: Array<SetupSkill & { directory: string }> = [];
  for (const asset of await readdir(base, { withFileTypes: true })) {
    if (!asset.isDirectory()) continue;
    const modules = join(base, asset.name, '01-skills');
    if (!(await info(modules))?.isDirectory()) continue;
    for (const entry of await readdir(modules, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(modules, entry.name);
      const document = join(directory, 'SKILL.md');
      const file = await info(document);
      if (!file?.isFile() || file.size > 1024 * 1024) continue;
      const text = await readFile(document, 'utf8');
      const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1];
      const raw = frontmatter?.match(/^name:[ \t]*([^\r\n]+)/mu)?.[1]?.trim();
      const name = raw?.replace(/^(['"])(.*)\1$/u, '$2');
      if (!name || name.length > 64 || !skillName.test(name)) continue;
      const local = await info(join(destination, name, 'SKILL.md'));
      skills.push({
        id: `${asset.name}/${entry.name}`,
        asset: asset.name,
        name,
        directory,
        installed: installed.has(name) || local?.isFile() === true,
      });
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

async function copyDirectory(from: string, to: string, root = false): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name === '.git' || (root && entry.name === 'SKILL.md')) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      await mkdir(target);
      await copyDirectory(source, target);
    } else if (entry.isFile()) {
      await copyFile(source, target, constants.COPYFILE_EXCL);
    } else {
      throw new ZhaoyeError('INVALID_INPUT', '技能目录含有链接或特殊文件，无法安装');
    }
  }
}

export async function installAssetSkill(
  skill: SetupSkill & { directory: string },
  destination: string,
) {
  if (skill.installed) return;
  await mkdir(destination, { recursive: true });
  if (!(await info(destination))?.isDirectory())
    throw new ZhaoyeError('INVALID_INPUT', 'DSH 技能目录必须是普通目录');
  const target = join(destination, skill.name);
  try {
    await mkdir(target);
  } catch (error) {
    if (await info(target)) throw new ZhaoyeError('CONFLICT', '同名技能目录已存在');
    throw error;
  }
  try {
    await copyDirectory(skill.directory, target, true);
    // Register the entry last so DSH only discovers a complete skill folder.
    await copyFile(
      join(skill.directory, 'SKILL.md'),
      join(target, 'SKILL.md'),
      constants.COPYFILE_EXCL,
    );
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}
