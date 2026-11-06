/**
 * 多线程 World 的配置段：worlds.threads。
 *
 * 只有一件事需要想清楚：留几个空位。其余都是模型与预算的常规旋钮。
 * 所有字段都是热的——池子每次派活现读这段配置。
 */
import type { ConfigGroup } from 'cortico/core/types.ts';

/** 池子满时的策略。 */
export type FullPolicy = 'queue' | 'borrow';

export interface ThreadsConfigSection {
  enabled: boolean;
  /** 线程总数上限（含空闲的），至少 1。 */
  maxThreads: number;
  /**
   * 空闲保底：任何时候至少留几条空闲线程。
   * 会被压到 maxThreads - 1：保底等于上限时，谁也没法开工。
   */
  reserveIdle: number;
  /** 池子满时：queue=排队等空位；borrow=临时借用保底那条。 */
  onFull: FullPolicy;
  /** 每条线程带几轮对话（一问一答算一轮）。 */
  historyTurns: number;
  /** 单次回复的 token 上限。 */
  maxTokens: number;
  temperature: number;
  /** 单次模型调用超时（秒）。 */
  timeoutSec: number;
  /** 端点地址；留空＝跟随当前激活的 provider。 */
  endpoint: string;
  /** 模型名；留空＝跟随当前激活的 provider。 */
  model: string;
  /** 密钥的环境变量名；留空＝用 provider 自己的 secret 名。 */
  apiKeyEnv: string;
}

export const THREADS_DEFAULTS: ThreadsConfigSection = {
  enabled: false,
  maxThreads: 4,
  reserveIdle: 1,
  onFull: 'queue',
  historyTurns: 8,
  maxTokens: 2048,
  temperature: 0.8,
  timeoutSec: 120,
  endpoint: '',
  model: '',
  apiKeyEnv: '',
};

export const THREADS_CONFIG_GROUP: ConfigGroup = {
  id: 'world:threads',
  owner: 'world:threads',
  schema: {
    type: 'object',
    title: '多线程',
    description:
      '让桌宠同时开几条独立的对话/任务线程：一条在干活时，另一条还能接话；'
      + '同时有两件事在跑时自动开第三条；池子始终至少留一条空闲线程接新消息。'
      + '这里调线程上限、空闲保底、满了怎么办，以及每条线程用的模型。'
      + '改完下一次派活就生效，不用重启。',
    properties: {
      'worlds.threads.maxThreads': {
        type: 'integer',
        title: '最多几条线程',
        minimum: 1,
        maximum: 8,
        'x-suffix': '条',
        'x-hot': true,
        description:
          '线程总数上限，含空闲的。默认 4：最多 3 条同时在忙，另 1 条空闲等着接新消息。'
          + '调大＝能同时处理更多事，但每次模型调用都会单独计费；调小＝更省，但容易排队。',
      },
      'worlds.threads.reserveIdle': {
        type: 'integer',
        title: '至少留几条空闲',
        minimum: 0,
        maximum: 7,
        'x-suffix': '条',
        'x-hot': true,
        description:
          '空闲保底，默认 1——这就是「始终有一个线程空闲」的那条。'
          + '空闲线程多于它时复用，否则开新线程，直到上限。'
          + '填 0 ＝ 不保底，池子可以全部排满；会被自动压到「最多几条线程 − 1」。',
      },
      'worlds.threads.onFull': {
        type: 'string',
        title: '池子满了怎么办',
        enum: ['queue', 'borrow'],
        'x-hot': true,
        description:
          'queue（默认）＝排队，等某条线程空出来，空闲保底不破。'
          + 'borrow＝临时借用那条保底的空闲线程，先干起来，等别的线程空下来再把保底补回去。'
          + 'borrow 更跟手，但借用期间没有空闲线程接突如其来的插话。',
      },
      'worlds.threads.historyTurns': {
        type: 'integer',
        title: '每条线程记几轮',
        minimum: 1,
        maximum: 40,
        'x-suffix': '轮',
        'x-hot': true,
        description:
          '每条线程带多少轮上下文（一问一答算一轮）。'
          + '线程被复用来接新任务时，旧上下文会一起带上；调大＝更连贯也更贵，调小＝更省。',
      },
      'worlds.threads.maxTokens': {
        type: 'integer',
        title: '单次回复上限',
        minimum: 128,
        maximum: 16384,
        'x-suffix': 'token',
        'x-hot': true,
        description: '每条线程一次回复最多生成多少 token。默认 2048，够一段完整的答复。',
      },
      'worlds.threads.temperature': {
        type: 'number',
        title: '温度',
        minimum: 0,
        maximum: 2,
        'x-hot': true,
        description: '0 更稳，1 更活。桌宠聊天默认 0.8；要它严格照资料答就调低。',
      },
      'worlds.threads.timeoutSec': {
        type: 'integer',
        title: '单次调用超时',
        minimum: 10,
        maximum: 600,
        'x-suffix': '秒',
        'x-hot': true,
        description: '一次模型请求最多等多久。超时按失败处理，线程回到空闲，并把原因报给桌宠。',
      },
      'worlds.threads.endpoint': {
        type: 'string',
        title: '端点地址（可留空）',
        'x-hot': true,
        description:
          '留空＝跟随当前激活的 provider（推荐）。'
          + '填了就用它，例如 https://api.deepseek.com；适合给线程单独接一个更便宜/更快的端点。',
      },
      'worlds.threads.model': {
        type: 'string',
        title: '模型名（可留空）',
        'x-hot': true,
        description: '留空＝用当前 provider 配置里的模型。填了则覆盖，例如 deepseek-flash。',
      },
      'worlds.threads.apiKeyEnv': {
        type: 'string',
        title: '密钥变量名（可留空）',
        'x-hot': true,
        description:
          '留空＝用 provider 自己的密钥（DEEPSEEK_API_KEY 等）。'
          + '填了则从部署 .env 或进程环境里读这个名字的变量，适合给线程单独一把 key。',
      },
    },
  },
};

/** 把活配置读成一份规整的设置；坏值用默认值兜底。 */
export function readThreadsConfig(cfg: Partial<ThreadsConfigSection> | undefined): ThreadsConfigSection {
  const c = cfg ?? {};
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const maxThreads = Math.max(1, Math.floor(num(c.maxThreads, THREADS_DEFAULTS.maxThreads)));
  return {
    enabled: c.enabled === true,
    maxThreads,
    reserveIdle: Math.min(Math.max(0, Math.floor(num(c.reserveIdle, THREADS_DEFAULTS.reserveIdle))), Math.max(0, maxThreads - 1)),
    onFull: c.onFull === 'borrow' ? 'borrow' : 'queue',
    historyTurns: Math.max(1, Math.floor(num(c.historyTurns, THREADS_DEFAULTS.historyTurns))),
    maxTokens: Math.max(128, Math.floor(num(c.maxTokens, THREADS_DEFAULTS.maxTokens))),
    temperature: Math.min(2, Math.max(0, num(c.temperature, THREADS_DEFAULTS.temperature))),
    timeoutSec: Math.max(10, Math.floor(num(c.timeoutSec, THREADS_DEFAULTS.timeoutSec))),
    endpoint: typeof c.endpoint === 'string' ? c.endpoint.trim() : '',
    model: typeof c.model === 'string' ? c.model.trim() : '',
    apiKeyEnv: typeof c.apiKeyEnv === 'string' ? c.apiKeyEnv.trim() : '',
  };
}
