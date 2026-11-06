// 多线程面板（浏览器端）。
//
// 纯 ESM、零依赖、没有构建步骤：默认导出 { panels: { live: { mount } } }。
// 只往 ctx.root 里写，只用 ctx.ui 的原语与宿主主题变量，所以明暗配色都跟着走。

const CSS = `
.ts-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin: 2px 0 12px; }
.ts-head .ts-now { font-size: 15px; font-weight: 600; color: var(--ink); }
.ts-head .ts-sub { font-size: 12.5px; color: var(--ink-soft); }
.ts-model { font-size: 12px; color: var(--ink-dim); margin: 6px 0 16px; line-height: 1.6; word-break: break-all; }
.ts-model.bad { color: var(--danger); }
.ts-sub-title { font-size: 12.5px; font-weight: 600; color: var(--ink-soft); margin: 20px 0 8px; letter-spacing: .02em; }
.ts-card { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 9px; background: var(--sheet-3); }
.ts-card.running { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
.ts-card.bad { border-color: color-mix(in srgb, var(--danger) 45%, var(--line)); }
.ts-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ts-id { font-family: var(--mono, ui-monospace, monospace); font-size: 12px; font-weight: 600; color: var(--ink-soft); }
.ts-title { font-size: 13.5px; font-weight: 600; color: var(--ink); flex: 1; min-width: 120px; }
.ts-meta { font-size: 12px; color: var(--ink-dim); margin-top: 5px; }
.ts-reply { font-size: 13px; color: var(--ink-soft); line-height: 1.65; margin-top: 7px; white-space: pre-wrap; word-break: break-word; }
.ts-reply.bad { color: var(--danger); }
.ts-empty { font-size: 12.5px; color: var(--ink-dim); padding: 6px 0 2px; }
.ts-q { font-size: 12.5px; color: var(--ink-soft); line-height: 1.7; }
.ts-q b { font-weight: 600; color: var(--ink); }
.ts-actions { margin-left: auto; }
`;

const TEXT = {
  zh: {
    title: '多线程 · 线程池',
    desc: '每条线程在忙什么、空了多久、最近一句说了什么；池子里还留没留着空闲的那一条。',
    busy: '在忙',
    idle: '空闲',
    queued: '排队',
    size: '线程',
    reserve: '空闲保底',
    reserveOk: '保底在岗',
    reserveMiss: '保底被借用',
    fullQueue: '满了排队',
    fullBorrow: '满了借用保底',
    noThreads: '还没有线程。派第一件事给桌宠，池子就会开线程。',
    noQueue: '没有排队的活。',
    queueTitle: '排队',
    threadsTitle: '线程',
    modelTitle: '模型',
    ready: '可用',
    notReady: '不可用',
    stop: '停掉',
    stopTitle: '停掉这条线程？',
    stopBody: (id, title) => `${id}「${title}」手头的活不会再有回报。`,
    stopDone: '已停掉',
    stopped: '已停止',
    noModel: '还没有可用的端点',
    task: '任务',
    held: '待处理',
    replies: '已回',
    idleSince: '刚空下来',
    err: '最近一次失败',
    refreshFailed: '面板刷新失败',
  },
  en: {
    title: 'Threads · live',
    desc: 'What each lane is doing, how long it has been idle, its latest line, and whether the spare lane is still there.',
    busy: 'busy',
    idle: 'idle',
    queued: 'queued',
    size: 'lanes',
    reserve: 'spare',
    reserveOk: 'spare in place',
    reserveMiss: 'spare lent out',
    fullQueue: 'queue when full',
    fullBorrow: 'borrow spare when full',
    noThreads: 'No lanes yet. Give the pet a task and one opens.',
    noQueue: 'Nothing queued.',
    queueTitle: 'Queue',
    threadsTitle: 'Lanes',
    modelTitle: 'Model',
    ready: 'ready',
    notReady: 'not ready',
    stop: 'Stop',
    stopTitle: 'Stop this lane?',
    stopBody: (id, title) => `Work held by ${id} "${title}" will not report back.`,
    stopDone: 'Stopped',
    stopped: 'Stopped',
    noModel: 'No endpoint yet',
    task: 'task',
    held: 'waiting',
    replies: 'replies',
    idleSince: 'just idle',
    err: 'last failure',
    refreshFailed: 'Could not refresh the panel',
  },
};

function textFor(language) {
  return language === 'zh' || language === 'zh-Hant' ? TEXT.zh : TEXT.en;
}

export default {
  panels: {
    live: {
      async mount(ctx) {
        const t = textFor(ctx.language);
        const ui = ctx.ui;
        const root = ctx.root;
        root.innerHTML = '';

        const style = document.createElement('style');
        style.textContent = CSS;
        root.append(style);

        const sheet = ui.sheet({ title: t.title, desc: t.desc });
        root.append(sheet.el);

        const head = ui.h('div', 'ts-head');
        const now = ui.h('span', 'ts-now', '');
        const sub = ui.h('span', 'ts-sub', '');
        head.append(now, sub);
        const stats = ui.statgrid();
        const model = ui.h('div', 'ts-model', '');
        const msg = ui.msgline('');
        msg.hidden = true;
        const threadsTitle = ui.h('div', 'ts-sub-title', t.threadsTitle);
        const threads = ui.h('div', '');
        const queueTitle = ui.h('div', 'ts-sub-title', t.queueTitle);
        const queue = ui.h('div', '');
        sheet.body.append(head, stats, model, msg, threadsTitle, threads, queueTitle, queue);

        const show = (bad, line) => {
          msg.hidden = !line;
          msg.textContent = line;
          msg.className = bad ? 'msgline bad' : 'msgline';
        };

        const card = (item) => {
          const el = ui.h('div', `ts-card ${item.state === 'running' ? 'running' : ''} ${item.lastError ? 'bad' : ''}`);
          const row = ui.h('div', 'ts-row');
          const id = ui.h('span', 'ts-id', item.id);
          const title = ui.h('span', 'ts-title', item.title || '—');
          const pill = ui.pill(item.state === 'running' ? t.busy : t.idle, item.state === 'running' ? 'on' : 'plain');
          const stop = ui.button(t.stop, {
            variant: 'plain',
            size: 'sm',
            onClick: async () => {
              if (item.state === 'running' && !(await ui.confirm({ title: t.stopTitle, body: t.stopBody(item.id, item.title || '—'), danger: true }))) return;
              try {
                const result = await ctx.invoke('stop', [item.id]);
                if (result && result.ok === false) throw new Error(result.error || 'stop failed');
                ui.toast(`${t.stopDone} ${item.id}`, 'ok');
                await refresh();
              } catch (error) {
                ui.toast(String(error && error.message ? error.message : error), 'bad');
              }
            },
          });
          const actions = ui.h('span', 'ts-actions');
          actions.append(stop);
          row.append(id, title, pill, actions);
          el.append(row);

          const bits = [];
          if (item.state === 'running') bits.push(`${t.task}：${ui.fmt.duration(item.elapsedMs)}`);
          else bits.push(t.idleSince);
          bits.push(`${t.replies} ${item.replies}`);
          if (item.pending > 0) bits.push(`${t.held} ${item.pending}`);
          const meta = ui.h('div', 'ts-meta', bits.join(' · '));
          el.append(meta);

          if (item.lastError) {
            el.append(ui.h('div', 'ts-reply bad', `${t.err}：${item.lastError}`));
          } else if (item.lastReply) {
            el.append(ui.h('div', 'ts-reply', item.lastReply));
          }
          return el;
        };

        const render = (data) => {
          const pool = data.pool || {};
          const threadsList = Array.isArray(data.threads) ? data.threads : [];
          const queueList = Array.isArray(data.queue) ? data.queue.filter((q) => q && q.title) : [];

          now.textContent = `${pool.running ?? 0} ${t.busy} · ${pool.idle ?? 0} ${t.idle} · ${pool.queued ?? 0} ${t.queued}`;
          sub.textContent = `${pool.size ?? 0}/${pool.max ?? 0} ${t.size} · ${t.reserve} ${pool.reserve ?? 0} · ${pool.onFull === 'borrow' ? t.fullBorrow : t.fullQueue}`;
          sub.title = pool.reserveMet ? t.reserveOk : t.reserveMiss;

          stats.innerHTML = '';
          stats.append(
            ui.stat({ k: t.busy, v: pool.running ?? 0, accent: (pool.running ?? 0) > 0 }),
            ui.stat({ k: t.idle, v: pool.idle ?? 0 }),
            ui.stat({ k: t.queued, v: pool.queued ?? 0 }),
            ui.stat({ k: t.size, v: `${pool.size ?? 0}/${pool.max ?? 0}` }),
            ui.stat({ k: t.reserve, v: pool.reserve ?? 0 }),
          );

          const m = data.model || {};
          model.className = m.ready ? 'ts-model' : 'ts-model bad';
          model.textContent = m.ready
            ? `${t.modelTitle}：${m.model || '?'} · ${m.host || '?'} · ${t.ready}${m.source ? `（${m.source}）` : ''}`
            : `${t.modelTitle}：${t.notReady}${m.error ? ` · ${m.error}` : ''}`;

          threads.innerHTML = '';
          if (threadsList.length === 0) {
            threads.append(ui.placeholder(t.noThreads));
          } else {
            for (const item of threadsList) threads.append(card(item));
          }

          queue.innerHTML = '';
          if (queueList.length === 0) {
            queue.append(ui.h('div', 'ts-empty', t.noQueue));
          } else {
            for (const item of queueList) {
              const line = ui.h('div', 'ts-q');
              const n = ui.h('b', '', `${item.position}. `);
              line.append(n, document.createTextNode(item.title || ''));
              if (item.text) line.append(ui.h('div', 'ts-meta', item.text));
              queue.append(line);
            }
          }
        };

        const refresh = async () => {
          try {
            const data = await ctx.invoke('snapshot');
            show(false, '');
            render(data);
          } catch (error) {
            show(true, `${t.refreshFailed}：${error && error.message ? error.message : error}`);
          }
        };

        await refresh();
        ctx.interval(() => { void refresh(); }, 2000);
      },
    },
  },
};
