/**
 * 线程自己的模型调用：不经过 Core 的主 session，所以才能并行。
 *
 * 端点默认跟随部署当前激活的 provider（读 config.json → providers/<名字>/config.json），
 * 也允许在扩展配置里单独指定。协议先按 Responses（DeepSeek 等 Coo 端点走这个），
 * 遇到 404/405 自动退回 Chat Completions，并记住这条端点的选择。
 *
 * 这里刻意做得很小：一次请求、一个超时、失败重试一次，不引入流式与工具调用。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ModelMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface EndpointConfig {
  endpoint: string;
  model: string;
  apiKeyEnv: string;
}

export interface ResolvedEndpoint {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 说明这条端点从哪儿来，给面板与报错用。 */
  source: string;
}

export interface CompleteOptions {
  instructions: string;
  messages: readonly ModelMessage[];
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** 与 Cortico 的 LLMUsage 同形，World 通过 reportUsage 交给宿主记账。 */
export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens?: number;
}

export interface CompletionResult {
  text: string;
  usage?: ModelUsage;
}

type Protocol = 'responses' | 'chat';

const protocolCache = new Map<string, Protocol>();

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null;
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** 与 Cortico 的 secretReader 同序：非空进程变量优先，其次文件里那一行，取到首个空白为止。 */
function readSecret(files: readonly string[], name: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  const pattern = new RegExp(`^[ \\t]*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*=[ \\t]*(\\S+)`, 'm');
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const matched = pattern.exec(readFileSync(file, 'utf8'));
      if (matched) return matched[1];
    } catch {
      /* 读不了就当没有 */
    }
  }
  return '';
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * 解析这次要用的端点。botDir 是部署目录；provider 目录在它的同级 `providers/` 下。
 * 返回 error 时不抛：World 会把它显示在面板里，并在每次调用时重试解析。
 */
export function resolveEndpoint(botDir: string, cfg: EndpointConfig): { endpoint?: ResolvedEndpoint; error?: string } {
  const deploy = readJson(join(botDir, 'config.json')) ?? {};
  const active = str(deploy.activeProvider);
  const providersRoot = join(botDir, '..', 'providers');
  const providerConf = active ? (readJson(join(providersRoot, active, 'config.json')) ?? {}) : {};
  const spec = providerConf.spec && typeof providerConf.spec === 'object' ? providerConf.spec as Record<string, unknown> : {};

  const baseUrl = (cfg.endpoint || str(providerConf.baseUrl) || '').replace(/\/+$/, '');
  const model = cfg.model || str(spec.model) || '';
  const secretName = cfg.apiKeyEnv || str(providerConf.secret) || '';
  const files = active ? [join(providersRoot, active, '.env'), join(botDir, '.env')] : [join(botDir, '.env')];
  const apiKey = secretName ? readSecret(files, secretName) : '';

  const source = cfg.endpoint
    ? '扩展配置里的端点'
    : active
      ? `当前 provider「${active}」`
      : '没有可用的 provider';

  if (!baseUrl) return { error: '找不到模型端点：请先在设置里配置一个 provider，或在扩展配置里填端点地址。' };
  if (!model) return { error: '找不到模型名：请在 provider 里选模型，或在扩展配置里填模型名。' };
  // 没声明 secret 的端点（本机 llamacpp 这类）允许不带鉴权；声明了却读不到才算错。
  if (secretName && !apiKey) {
    return { error: `找不到模型密钥（${secretName}）：请在设置的 provider 页填写，或在扩展配置里指定密钥变量名。` };
  }
  return { endpoint: { baseUrl, model, apiKey, source } };
}

/** 面板上能说的端点信息，不含密钥。 */
export function endpointLabel(botDir: string, cfg: EndpointConfig): { host: string; model: string; source: string; ready: boolean; error?: string } {
  const { endpoint, error } = resolveEndpoint(botDir, cfg);
  if (!endpoint) return { host: '', model: cfg.model, source: '', ready: false, error };
  let host = endpoint.baseUrl;
  try { host = new URL(endpoint.baseUrl).host; } catch { /* 保留原文 */ }
  return { host, model: endpoint.model, source: endpoint.source, ready: true };
}

function abortPair(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), Math.max(1000, timeoutMs));
  const onOuter = () => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', onOuter, { once: true });
  }
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    },
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function usageOf(raw: unknown, protocol: Protocol): ModelUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const details = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
  const input = protocol === 'responses' ? num(u.input_tokens) : num(u.prompt_tokens);
  const output = protocol === 'responses' ? num(u.output_tokens) : num(u.completion_tokens);
  const cache = protocol === 'responses'
    ? num(details(u.input_tokens_details).cached_tokens)
    : num(details(u.prompt_tokens_details).cached_tokens);
  const reasoning = protocol === 'responses'
    ? num(details(u.output_tokens_details).reasoning_tokens)
    : num(details(u.completion_tokens_details).reasoning_tokens);
  if (input === 0 && output === 0) return undefined;
  return {
    promptTokens: input,
    completionTokens: output,
    cacheHitTokens: Math.min(cache, input),
    cacheMissTokens: Math.max(0, input - Math.min(cache, input)),
    reasoningTokens: reasoning,
  };
}

function parseResponses(data: Record<string, unknown>): CompletionResult {
  if (data.error && typeof data.error === 'object') {
    throw new Error(str((data.error as Record<string, unknown>).message) || '模型返回了错误');
  }
  const output = Array.isArray(data.output) ? data.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (entry.type !== 'message') continue;
    const content = Array.isArray(entry.content) ? entry.content : [];
    for (const piece of content) {
      if (!piece || typeof piece !== 'object') continue;
      const part = piece as Record<string, unknown>;
      if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return { text: parts.join('\n').trim(), usage: usageOf(data.usage, 'responses') };
}

function parseChat(data: Record<string, unknown>): CompletionResult {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const message = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>).message : null;
  const usage = usageOf(data.usage, 'chat');
  if (!message || typeof message !== 'object') return { text: '', usage };
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return { text: content.trim(), usage };
  if (Array.isArray(content)) {
    return {
      text: content
        .map((part) => (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string' ? String((part as Record<string, unknown>).text) : ''))
        .join('')
        .trim(),
      usage,
    };
  }
  return { text: '', usage };
}

function headers(endpoint: ResolvedEndpoint): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
  };
}

async function callOnce(endpoint: ResolvedEndpoint, opts: CompleteOptions, protocol: Protocol): Promise<CompletionResult> {
  const body = protocol === 'responses'
    ? {
        model: endpoint.model,
        instructions: opts.instructions,
        input: opts.messages.map((m) => ({
          type: 'message',
          role: m.role,
          content: [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.text }],
        })),
        store: false,
        stream: false,
        max_output_tokens: opts.maxTokens,
        temperature: opts.temperature,
      }
    : {
        model: endpoint.model,
        messages: [
          { role: 'system', content: opts.instructions },
          ...opts.messages.map((m) => ({ role: m.role, content: m.text })),
        ],
        stream: false,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
      };
  const path = protocol === 'responses' ? '/responses' : '/chat/completions';
  const pair = abortPair(opts.timeoutMs, opts.signal);
  try {
    const response = await fetch(`${endpoint.baseUrl}${path}`, {
      method: 'POST',
      headers: headers(endpoint),
      body: JSON.stringify(body),
      signal: pair.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${raw.replace(/\s+/g, ' ').slice(0, 400)}`) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`返回的不是 JSON：${raw.slice(0, 200)}`);
    }
    const text = protocol === 'responses' ? parseResponses(data) : parseChat(data);
    if (!text.text) throw new Error('模型返回了空内容');
    return text;
  } finally {
    pair.clear();
  }
}

/**
 * 完成一次对话。失败重试一次（仅 429 / 5xx / 网络错误）；
 * Responses 返回 404/405 时自动改用 Chat Completions。
 */
export async function complete(endpoint: ResolvedEndpoint, opts: CompleteOptions): Promise<CompletionResult> {
  const cacheKey = `${endpoint.baseUrl}|${endpoint.model}`;
  let protocol: Protocol = protocolCache.get(cacheKey) ?? 'responses';
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await callOnce(endpoint, opts, protocol);
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number }).status;
      if ((status === 404 || status === 405) && protocol === 'responses') {
        protocol = 'chat';
        protocolCache.set(cacheKey, protocol);
        continue;
      }
      const retryable = status === undefined || status === 429 || status >= 500;
      if (attempt === 1 && retryable) {
        await sleep(1200);
        continue;
      }
      break;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  const status = (lastError as { status?: number })?.status;
  throw new Error(status ? `模型请求失败（HTTP ${status}）：${message.replace(/^HTTP \d+: /, '')}` : `模型请求失败：${message}`);
}
