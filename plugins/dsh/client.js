window.__ModuleLoader__.load({
  id: 'dsh-plugin-zhaoye',
  factory(require) {
    const { createElement: h, Fragment, useEffect, useRef, useState } = require('react');
    const route = '/api/zhaoye/onboarding';
    const panelId = 'zhaoye-onboarding';
    const openPanel = 'zhaoye:open-onboarding';
    const skillChange = 'zhaoye:skills-changed';
    const css = `
      .zhaoye-entry-mark {display:inline-flex;align-items:center;justify-content:center;line-height:1}
      .zhaoye-dialog {
        --z-bg:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,Canvas));
        --z-card:var(--dsw-alias-bg-module-platform,Canvas);
        --z-ink:var(--dsw-alias-label-primary,CanvasText);
        --z-muted:var(--dsw-alias-label-secondary,CanvasText);
        --z-border:var(--dsw-alias-border-l2,ButtonBorder);
        --z-accent:var(--dsw-alias-button-info-fill,Highlight);
        --z-accent-ink:var(--dsw-alias-label-primary-inverted,HighlightText);
        box-sizing:border-box;width:min(630px,calc(100vw - 32px));max-height:min(820px,calc(100dvh - 40px));padding:0;
        border:1px solid var(--z-border);border-radius:18px;color:var(--z-ink);opacity:1;
        /* Canvas keeps the surface opaque even with translucent theme tokens. */
        background:linear-gradient(var(--z-bg),var(--z-bg)) Canvas;
        box-shadow:0 26px 80px var(--dsw-alias-bg-mask-1,color-mix(in srgb,CanvasText 20%,transparent));
        font:14px/1.55 system-ui,sans-serif
      }
      .zhaoye-dialog::backdrop {background:color-mix(in srgb,var(--dsw-alias-label-primary,CanvasText) 26%,transparent);backdrop-filter:blur(2px)}
      .zhaoye-dialog .zhaoye-head,.zhaoye-dialog .zhaoye-foot {display:flex;align-items:center;justify-content:space-between;gap:14px;padding:16px 24px}
      .zhaoye-dialog .zhaoye-head {border-bottom:1px solid var(--z-border)}
      .zhaoye-dialog .zhaoye-foot {border-top:1px solid var(--z-border);position:sticky;bottom:0;background:inherit}
      .zhaoye-dialog .zhaoye-body {display:grid;gap:18px;padding:18px 24px}
      .zhaoye-dialog h2,.zhaoye-dialog h3,.zhaoye-dialog p {margin:0}
      .zhaoye-dialog h2 {font-size:21px;letter-spacing:.04em}
      .zhaoye-dialog h3,.zhaoye-dialog label {font-size:14px;font-weight:650}
      .zhaoye-dialog p,.zhaoye-dialog small {color:var(--z-muted)}
      .zhaoye-dialog .zhaoye-form {display:grid;gap:7px}
      .zhaoye-dialog .zhaoye-controls,.zhaoye-dialog .zhaoye-dir-top {display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .zhaoye-dialog input {flex:1 1 220px;min-width:0;padding:9px 10px;background:var(--z-card);border:1px solid var(--z-border);border-radius:8px;color:inherit;font:inherit}
      .zhaoye-dialog button,.zhaoye-skill-notice button {cursor:pointer;font:inherit}
      .zhaoye-dialog button {padding:7px 12px;border:1px solid var(--z-border);border-radius:8px;background:var(--z-card);color:inherit;white-space:nowrap}
      .zhaoye-dialog button:hover:not(:disabled) {border-color:var(--z-accent)}
      .zhaoye-dialog button:disabled {opacity:.5;cursor:default}
      .zhaoye-dialog .zhaoye-primary {background:var(--z-accent);color:var(--z-accent-ink);border-color:var(--z-accent);font-weight:650;padding:8px 16px}
      .zhaoye-dialog .zhaoye-primary:hover:not(:disabled) {background:color-mix(in srgb,var(--z-accent) 88%,var(--z-ink))}
      .zhaoye-dialog .zhaoye-close {padding:3px 10px;background:transparent;font-size:18px}
      .zhaoye-dirs,.zhaoye-skill-list {list-style:none;margin:0;padding:0;border:1px solid var(--z-border);border-radius:12px;background:var(--z-card)}
      .zhaoye-dirs li,.zhaoye-skill-list li {padding:10px 12px}
      .zhaoye-dirs li+li,.zhaoye-skill-list li+li {border-top:1px solid var(--z-border)}
      .zhaoye-dialog code {display:block;overflow-wrap:anywhere;color:var(--z-muted);font:12px/1.6 ui-monospace,monospace}
      .zhaoye-dialog .zhaoye-chip {color:var(--z-muted);font-size:12px}
      .zhaoye-dialog .zhaoye-chip[data-ready=true] {color:var(--z-accent)}
      .zhaoye-skill-section {display:grid;gap:7px}
      .zhaoye-skill-list li {display:flex;align-items:center;justify-content:space-between;gap:8px;overflow-wrap:anywhere}
      .zhaoye-skill-list {max-height:208px;overflow:auto}
      .zhaoye-dialog :focus-visible,.zhaoye-skill-notice button:focus-visible {outline:2px solid var(--dsw-alias-button-info-fill,Highlight);outline-offset:2px}
      .zhaoye-dialog .zhaoye-folders {display:grid;gap:6px;min-width:0;max-height:240px;overflow:auto;margin:0;padding:8px;border:1px solid var(--z-border);border-radius:10px}
      .zhaoye-folders button {text-align:left;white-space:normal;overflow-wrap:anywhere}
      .zhaoye-skill-notice {margin:5px auto;padding:8px 12px;border:1px solid var(--dsw-alias-border-l3,ButtonBorder);border-radius:9px;color:inherit;max-width:55ch;text-align:left;overflow-wrap:anywhere}
      .zhaoye-skill-notice button {margin-inline-start:8px;border:0;background:transparent;color:inherit;text-decoration:underline}
      @media(max-width:520px) {.zhaoye-dialog .zhaoye-head,.zhaoye-dialog .zhaoye-body,.zhaoye-dialog .zhaoye-foot{padding-inline:14px} .zhaoye-dialog .zhaoye-foot{align-items:flex-start}}
    `;

    async function api(input) {
      const response = await fetch(
        route,
        input
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(input),
            }
          : { cache: 'no-store' },
      );
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) throw new Error(data?.error ?? '暂时无法连接照夜，请重试');
      return data;
    }

    function setVisible(dialog, visible) {
      if (visible && !dialog.open) dialog.showModal();
      else if (!visible && dialog.open) dialog.close();
    }

    function directories(status) {
      const rows = [
        ['人格画像', '照夜的性格、协作偏好和画像版本', status.identity],
        ['记忆库', '本地 SQLite 备份和增量记录', status.backup],
        ['个人资产库', '日报、项目文件和技能', status.assets],
      ];
      return h(
        'ul',
        { className: 'zhaoye-dirs', 'aria-label': '本地数据目录' },
        rows.map(([name, description, item]) =>
          h(
            'li',
            { key: name },
            h(
              'div',
              { className: 'zhaoye-dir-top' },
              h('strong', null, name),
              h(
                'span',
                { className: 'zhaoye-chip', 'data-ready': item.ready },
                item.ready ? '就绪' : '待设置',
              ),
            ),
            h('small', null, description),
            h('code', null, item.path),
          ),
        ),
      );
    }

    function skills(status, busy, run) {
      const remaining = status.skills.filter((skill) => !skill.installed);
      const installed = status.skills.length - remaining.length;
      return h(
        'section',
        { className: 'zhaoye-skill-section', 'aria-label': '个人资产库技能' },
        h('h3', null, '个人资产库技能'),
        h(
          'p',
          null,
          status.skillIssue ??
            (status.skills.length
              ? `已安装到 DSH ${installed} 项 · 待安装 ${remaining.length} 项`
              : '个人资产库里暂未发现技能。'),
        ),
        remaining.length > 0 &&
          h(
            Fragment,
            null,
            h('small', null, 'DSH 技能安装目录'),
            h('code', null, status.skillsPath),
            h(
              'ul',
              { className: 'zhaoye-skill-list' },
              remaining.map((skill) =>
                h(
                  'li',
                  { key: skill.id },
                  h(
                    'div',
                    null,
                    h('strong', null, skill.name),
                    h('br'),
                    h('small', null, skill.asset),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: Boolean(busy),
                      'aria-label': `安装 ${skill.name}`,
                      onClick: () => run('install', { action: 'install', skillId: skill.id }),
                    },
                    '安装到 DSH',
                  ),
                ),
              ),
            ),
          ),
      );
    }

    function Panel({ ctx }) {
      const dialog = useRef(null);
      const lock = useRef(false);
      const [visible, setOpen] = useState(false);
      const [status, setStatus] = useState(null);
      const [path, setPath] = useState('');
      const [folder, setFolder] = useState(null);
      const [busy, setBusy] = useState('');
      const [error, setError] = useState('');
      async function perform(kind, work) {
        if (lock.current) return;
        lock.current = true;
        setBusy(kind);
        setError('');
        try {
          await work();
        } catch (problem) {
          setError(problem instanceof Error ? problem.message : '操作没有完成，请重试');
        } finally {
          lock.current = false;
          setBusy('');
        }
      }

      function showStatus(result) {
        setStatus(result);
        setPath(result.dataRoot);
      }

      function run(kind, request) {
        return perform(kind, async () => {
          const result = await api(request);
          if (kind === 'start') {
            const session = await ctx.sessions.create({ agentPreset: result.preset });
            ctx.uiWorkspace.openSession(session);
            setOpen(false);
          } else {
            showStatus(result);
            if (kind === 'configure') setFolder(null);
            if (kind === 'install')
              window.dispatchEvent(
                new CustomEvent(skillChange, {
                  detail: result.skills
                    .filter((skill) => !skill.installed)
                    .map((skill) => skill.name),
                }),
              );
          }
        });
      }

      function browseAt(directory) {
        return perform('pick', async () => {
          setFolder(await ctx.uiWorkspace.listDirectory(directory));
        });
      }

      function chooseDirectory() {
        return perform('pick', async () => {
          const desktop = window.__DSH_DIRECTORY_PICKER__;
          if (desktop?.pick) {
            const selected = await desktop.pick();
            if (selected) showStatus(await api({ action: 'configure', dataRoot: selected }));
            return;
          }
          const initial = status?.dataRoot;
          try {
            setFolder(await ctx.uiWorkspace.listDirectory(initial));
          } catch (problem) {
            if (problem?.rpcError?.code === 'directory-picker/unavailable') {
              const selected = await ctx.uiWorkspace.pickDirectory();
              if (selected) showStatus(await api({ action: 'configure', dataRoot: selected }));
            } else if (initial) {
              setFolder(await ctx.uiWorkspace.listDirectory());
            } else {
              throw problem;
            }
          }
        });
      }
      useEffect(() => {
        const present = () => setOpen(true);
        window.addEventListener(openPanel, present);
        return () => window.removeEventListener(openPanel, present);
      }, []);
      useEffect(() => {
        if (!dialog.current) return;
        setVisible(dialog.current, visible);
        if (visible) void run('check');
        else setFolder(null);
      }, [visible]);
      const changed = status && path.trim() !== status.dataRoot;
      const disabled = !status?.ready || changed || Boolean(busy);
      const configure = (directory, initialize = false) =>
        run('configure', { action: 'configure', dataRoot: directory, initialize });
      const applyEditedPath = () => {
        if (changed && path.trim()) void configure(path);
      };
      return h(
        'dialog',
        {
          ref: dialog,
          className: 'zhaoye-dialog',
          'aria-label': '照夜助手设置',
          onCancel: (event) => {
            event.preventDefault();
            setOpen(false);
          },
        },
        h(
          'header',
          { className: 'zhaoye-head' },
          h('h2', null, '照夜助手'),
          h(
            'button',
            {
              type: 'button',
              className: 'zhaoye-close',
              'aria-label': '关闭',
              onClick: () => setOpen(false),
            },
            '×',
          ),
        ),
        h(
          'div',
          { className: 'zhaoye-body', 'aria-busy': Boolean(busy) },
          h(
            'form',
            {
              className: 'zhaoye-form',
              onSubmit: (event) => {
                event.preventDefault();
                applyEditedPath();
              },
            },
            h('label', { htmlFor: 'zhaoye-data-root' }, '本地数据目录'),
            h(
              'div',
              { className: 'zhaoye-controls' },
              h('input', {
                type: 'text',
                id: 'zhaoye-data-root',
                value: path,
                onChange: (event) => setPath(event.target.value),
                onBlur: (event) => {
                  if (!event.relatedTarget?.hasAttribute('data-zhaoye-pick')) applyEditedPath();
                },
                autoComplete: 'off',
                spellCheck: false,
                disabled: Boolean(busy),
                placeholder: '输入照夜数据根的绝对路径',
              }),
              h(
                'button',
                {
                  type: 'button',
                  disabled: Boolean(busy),
                  'data-zhaoye-pick': '',
                  onClick: chooseDirectory,
                },
                '选择本地目录',
              ),
              status?.canInitialize &&
                !changed &&
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: !path.trim() || Boolean(busy),
                    onClick: () => configure(path, true),
                  },
                  '初始化目录',
                ),
            ),
          ),
          folder &&
            h(
              'section',
              { className: 'zhaoye-form', 'aria-label': '选择本地目录' },
              h('code', null, folder.path),
              h(
                'div',
                { className: 'zhaoye-controls' },
                folder.crumbs.at(-2) &&
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: Boolean(busy),
                      onClick: () => browseAt(folder.crumbs.at(-2).path),
                    },
                    '上一级',
                  ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: Boolean(busy),
                    onClick: () => configure(folder.path),
                  },
                  '选中此文件夹',
                ),
                h(
                  'button',
                  { type: 'button', disabled: Boolean(busy), onClick: () => setFolder(null) },
                  '取消',
                ),
              ),
              folder.entries.length > 0 &&
                h(
                  'div',
                  { className: 'zhaoye-folders' },
                  folder.entries.map((entry) =>
                    h(
                      'button',
                      {
                        key: entry.path,
                        type: 'button',
                        disabled: Boolean(busy),
                        onClick: () => browseAt(entry.path),
                      },
                      entry.name,
                    ),
                  ),
                ),
            ),
          busy === 'check' && h('p', { role: 'status' }, '正在检查本地目录…'),
          error && h('p', { role: 'alert' }, error),
          status?.issue && h('p', { role: 'status' }, status.issue),
          status && directories(status),
          status && skills(status, busy, run),
        ),
        h(
          'footer',
          { className: 'zhaoye-foot' },
          h(
            'p',
            null,
            status?.ready && !changed ? '你的个人助理已经入住。' : '准备就绪后即可开始对话。',
          ),
          h(
            'button',
            {
              className: 'zhaoye-primary',
              type: 'button',
              disabled,
              onClick: () => run('start', { action: 'start' }),
            },
            busy === 'start' ? '正在创建…' : '开始对话',
          ),
        ),
      );
    }

    const noticed = new Map();
    function FirstSkillNotice({ sessionId }) {
      const [names, setNames] = useState([]);
      useEffect(() => {
        if (!sessionId) return;
        let active = true;
        if (!noticed.has(sessionId)) {
          if (noticed.size >= 64) noticed.delete(noticed.keys().next().value);
          noticed.set(
            sessionId,
            api({ action: 'notice', sessionId })
              .then((data) => data.missing)
              .catch(() => {
                noticed.delete(sessionId);
                return [];
              }),
          );
        }
        noticed.get(sessionId).then((missing) => {
          if (active) setNames(missing);
        });
        const update = ({ detail }) => {
          setNames((current) => current.filter((name) => detail.includes(name)));
        };
        window.addEventListener(skillChange, update);
        return () => {
          active = false;
          window.removeEventListener(skillChange, update);
        };
      }, [sessionId]);
      if (!names.length) return null;
      return h(
        'aside',
        { className: 'zhaoye-skill-notice', role: 'status' },
        '这些个人资产库技能还未安装到 DSH。',
        h('span', null, names.join('、')),
        h(
          'button',
          { type: 'button', onClick: () => window.dispatchEvent(new Event(openPanel)) },
          '查看技能',
        ),
      );
    }

    return {
      inject: ['slots', 'layout', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style');
          style.textContent = css;
          document.head.append(style);
          return () => style.remove();
        });
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: panelId }, () => null),
        );
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: panelId,
              order: 2,
              label: () => '照夜',
            },
            ({ size = 16 }) =>
              h(
                'span',
                {
                  className: 'zhaoye-entry-mark',
                  style: { width: size, height: size, fontSize: size + 2 },
                  'aria-hidden': true,
                },
                '☾',
              ),
          ),
        );
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: panelId }, () => h(Panel, { ctx })),
        );
        ctx.effect(() => {
          const { panelInfo } = ctx.layout;
          let previous = panelInfo.getSnapshot().activePanelId;
          let disposed = false;
          const off = panelInfo.subscribe(() => {
            const { activePanelId } = panelInfo.getSnapshot();
            if (activePanelId !== panelId) {
              previous = activePanelId;
              return;
            }
            // The sidebar selects a main panel. Return to the previous view and open the dialog above it.
            queueMicrotask(() => {
              if (disposed || panelInfo.getSnapshot().activePanelId !== panelId) return;
              const exists = ctx.slots
                .entries('main')
                .some((entry) => entry.options.key === previous);
              ctx.layout.selectPanel(exists ? previous : null);
              window.dispatchEvent(new Event(openPanel));
            });
          });
          return () => {
            disposed = true;
            off();
          };
        });
        ctx.slots.inject('conversation.hero.options', () =>
          ctx.slots.register(
            {
              name: 'conversation.hero.options',
              id: 'zhaoye-skill-welcome',
              inject: (sessionId) => ({ sessionId }),
            },
            FirstSkillNotice,
          ),
        );
      },
    };
  },
});
