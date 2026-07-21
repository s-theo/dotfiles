import { Plugin } from "@utils/pluginBase";
import { Api } from "teleproto";
import { getPrefixes } from "@utils/pluginManager";
import type { Low } from "lowdb";
import { JSONFilePreset } from "lowdb/node";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { TelegramFormatter } from "@utils/telegramFormatter";
import { TelegraphFormatter } from "@utils/telegraphFormatter";
import { execFile } from "child_process";
import fs from "fs";
import * as path from "path";
import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from "axios";
import sharp from "sharp";
import http from "http";
import https from "https";
import { promisify } from "util";
import { safeGetReplyMessage } from "@utils/safeGetMessages";

interface ProviderConfig {
  tag: string;
  url: string;
  key: string;
  type?: ProviderType;
  stream: boolean;
  responses: boolean;
}

interface TelegraphItem {
  url: string;
  title: string;
  createdAt: string;
}

interface DB {
  configs: Record<string, ProviderConfig>;
  currentChatTag: string;
  currentChatModel: string;
  currentSearchTag: string;
  currentSearchModel: string;
  currentImageTag: string;
  currentImageModel: string;
  currentVideoTag: string;
  currentVideoModel: string;
  imagePreview: boolean;
  imageSaveToFavorites: boolean;
  promptOptimize: boolean;
  videoPromptOptimize: boolean;
  promptLength?: "short" | "medium" | "long";
  videoPromptLength?: "short" | "medium" | "long";
  videoPreview: boolean;
  videoSaveToFavorites: boolean;
  videoAudio: boolean;
  videoDuration: number;
  prompt: string;
  collapse: boolean;
  timeout: number;
  telegraphToken: string;
  telegraph: {
    enabled: boolean;
    limit: number;
    list: TelegraphItem[];
  };
}

type AIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

const extractPromptOptimizeFlag = (prompt: string): {
  prompt: string;
  optimizePrompt: boolean;
} => {
  const optimizePrompt = /(?:^|\s)--opt(?:\s|$)/.test(prompt);
  return {
    prompt: prompt.replace(/(?:^|\s)--opt(?=\s|$)/g, " ").replace(/\s+/g, " ").trim(),
    optimizePrompt,
  };
};

const IMAGE_PROMPT_LENGTH_LABELS = {
  short: "80-180字",
  medium: "150-300字",
  long: "250-500字",
} as const;

const VIDEO_PROMPT_LENGTH_LABELS = {
  short: "120-260字",
  medium: "200-400字",
  long: "300-600字",
} as const;

type PromptLengthMode = keyof typeof IMAGE_PROMPT_LENGTH_LABELS;

type PromptOptimizationCommand =
  | { type: "status" }
  | { type: "toggle"; enabled: boolean }
  | { type: "length-status" }
  | { type: "length"; mode: PromptLengthMode };

const normalizePromptLengthMode = (value?: string): PromptLengthMode => {
  const lowered = (value || "").trim().toLowerCase();
  if (lowered === "medium" || lowered === "long") return lowered;
  return "short";
};

const parsePromptOptimizationCommand = (
  args: string[],
  feature: "image" | "video",
): PromptOptimizationCommand => {
  const option = args[2]?.toLowerCase();
  if (!option && args.length === 2) return { type: "status" };

  if ((option === "on" || option === "off") && args.length === 3) {
    return { type: "toggle", enabled: option === "on" };
  }

  if (option === "length") {
    if (args.length === 3) return { type: "length-status" };
    const mode = args[3]?.toLowerCase();
    if (
      args.length === 4 &&
      (mode === "short" || mode === "medium" || mode === "long")
    ) {
      return { type: "length", mode };
    }
  }

  if (
    args.length === 3 &&
    (option === "short" || option === "medium" || option === "long")
  ) {
    return { type: "length", mode: option };
  }

  throw new UserError(
    buildCommandUsage(
      `aix ${feature} optimize [on|off|length [short|medium|long]]`,
    ),
  );
};

const getPromptLengthInstruction = (
  mode: string | undefined,
  labels: typeof IMAGE_PROMPT_LENGTH_LABELS | typeof VIDEO_PROMPT_LENGTH_LABELS,
): string => {
  const normalized = normalizePromptLengthMode(mode);
  return `只输出提示词正文，不要解释、标题、Markdown、引号；中文输入就中文输出；控制在 ${labels[normalized]}。`;
};

const buildMultiImagePromptPlanRequest = (
  prompt: string,
  count: number,
  lengthMode?: PromptLengthMode,
): string =>
  [
    "把用户的生图需求规划成多条可直接用于图像模型的自然提示词。",
    `必须返回 ${count} 条，每条都保留用户核心主题，并通过具体的动作、表情、场景、构图、视角、色彩、材质、风格或画面文字形成明显不同的创作方案。`,
    "如果用户要求表情包带文字，为每条设计贴合画面的不同中文短文字，并直接写入各自画面描述。",
    "不要在提示词中写第几张、必须不同、不要重复、不要拼图、不要九宫格、只生成一张等程序控制说明。",
    getPromptLengthInstruction(lengthMode, IMAGE_PROMPT_LENGTH_LABELS),
    "只返回严格 JSON 字符串数组，不要 Markdown、标题、序号或解释。",
    `数组必须恰好包含 ${count} 个非空字符串。`,
    "",
    "用户需求：",
    prompt,
  ].join("\n");

const parseMultiImagePromptPlan = (text: string, count: number): string[] => {
  const raw = (text || "").trim();
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const tryArray = (value: any): string[] => {
    if (!Array.isArray(value) || value.length !== count) return [];
    const prompts = value.map((item) => typeof item === "string" ? item.replace(/\s+/g, " ").trim() : "");
    return prompts.every(Boolean) ? prompts : [];
  };
  try {
    const direct = tryArray(JSON.parse(cleaned));
    if (direct.length === count) return direct;
  } catch {}
  const jsonArrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (jsonArrayMatch) {
    try {
      const extracted = tryArray(JSON.parse(jsonArrayMatch[0]));
      if (extracted.length === count) return extracted;
    } catch {}
  }
  const linePrompts = cleaned
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)、．])\s*/, "").trim())
    .filter(Boolean);
  return linePrompts.length === count ? linePrompts : [];
};

const buildImageRequirementAnalysisRequest = (
  prompt: string,
  lengthMode?: PromptLengthMode,
): string =>
  [
    "分析用户完整的生图需求，并规划最终需要逐张生成的独立图片提示词。",
    "你需要理解自然语言中的数量、分类、列举、各几张和每张对应内容。",
    "例如“Emby海报板块，如电视剧、电影、动漫、综艺”应规划为4条分别对应这些板块的提示词；“电视剧和电影各两张，动漫一张”应规划为5条。",
    "如果用户只说生成5张某主题但没有逐项指定，请规划5条主题一致但内容、构图或用途不同的提示词。",
    "如果用户明确写了第一张、第二张或编号列表，必须保持每张对应关系，不得交换、遗漏或合并。",
    "所有图片共享的主题、角色、品牌、风格、配色、背景和尺寸要求必须合并进每一条提示词。",
    "每条只描述一张独立图片，不要写总数量、第几张、拼图、分屏、九宫格或程序控制说明。",
    getPromptLengthInstruction(lengthMode, IMAGE_PROMPT_LENGTH_LABELS),
    "只返回严格 JSON：{\"prompts\":[\"提示词1\",\"提示词2\"]}，不要 Markdown、标题或解释。",
    "prompts 数组长度就是最终生成数量；普通单图需求返回1条。",
    "",
    "用户完整需求：",
    prompt,
  ].join("\n");

const parseImageRequirementAnalysis = (text: string): string[] => {
  const raw = (text || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const parseValue = (value: any): string[] => {
    const source = Array.isArray(value) ? value : value?.prompts;
    if (!Array.isArray(source)) return [];
    const prompts = source
      .map((item: any) => typeof item === "string" ? item.replace(/\s+/g, " ").trim() : "")
      .filter(Boolean);
    return prompts.length > 0 ? prompts : [];
  };
  try {
    const direct = parseValue(JSON.parse(raw));
    if (direct.length > 0) return direct;
  } catch {}
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      const extracted = parseValue(JSON.parse(objectMatch[0]));
      if (extracted.length > 0) return extracted;
    } catch {}
  }
  return [];
};

const needsExplicitStickerTextPrompt = (prompt: string): boolean => {
  const compact = (prompt || "").replace(/\s+/g, "").trim();
  return /表情包|贴纸|貼紙|sticker/i.test(compact) && /文字|字|字幕|文案|台词|臺詞|加字|写字|帶字|带字|text/i.test(compact);
};

const buildStickerTextFallbackPrompts = (prompt: string, count: number): string[] => {
  const stickerTexts = ["我裂开了", "别催我", "收到啦", "太难了", "笑死", "安排上"];
  return Array.from({ length: count }, (_, i) =>
    `${prompt}，做成清晰可爱的社交平台表情包构图，主体表情夸张有辨识度，干净背景，高对比描边，在画面中加入醒目的中文短文字「${stickerTexts[i % stickerTexts.length]}」，文字要清楚可读并贴合表情。`
  );
};

const buildImagePromptOptimizationRequest = (prompt: string, lengthMode?: PromptLengthMode): string =>
  [
    "把用户的生图需求改写成更适合图像模型的提示词。",
    "要求：保留原意，不换主题；补足主体、场景、构图、光线、色彩、风格和氛围。",
    "如果有参考图/贴纸/头像，只提炼视觉特征和气质，不要写成看图说明。",
    "头像、表情包、贴纸类需求要强化识别度、表情、干净背景和社交平台构图。",
    "如果用户要求表情包带文字，必须设计贴合画面的中文短文字，并明确写入画面描述。",
    getPromptLengthInstruction(lengthMode, IMAGE_PROMPT_LENGTH_LABELS),
    "",
    "用户需求：",
    prompt,
  ].join("\n");

const buildVideoPromptOptimizationRequest = (prompt: string, lengthMode?: PromptLengthMode): string =>
  [
    "把用户的视频生成需求改写成更适合视频模型的提示词。",
    "要求：保留原意，不换主题；补足主体、动作、镜头运动、场景、光线、色彩、风格和氛围。",
    "如果有参考图/贴纸/头像，只提炼视觉特征和气质，不要写成看图说明。",
    "视频提示词要强调动态过程、镜头变化和时间感；不要要求拼接、分屏、九宫格。",
    getPromptLengthInstruction(lengthMode, VIDEO_PROMPT_LENGTH_LABELS),
    "",
    "用户需求：",
    prompt,
  ].join("\n");

const sanitizeOptimizedImagePrompt = (text: string, fallback: string): string => {
  const cleaned = (text || "")
    .replace(/^```[\w-]*\s*/i, "")
    .replace(/```$/i, "")
    .replace(/^优化后的提示词[:：]\s*/i, "")
    .replace(/^\s*\d+[.)、．]\s*/gm, "")
    .replace(/^\s*prompt\s*[:：]\s*/gim, "")
    .trim();
  const compact = cleaned.replace(/\s+/g, " ").trim();
  return compact || fallback;
};


const buildPromptOptimizationStatusText = (prompt: string): string =>
  `🧠 <b>正在优化生图提示词...</b>\n\n` +
  `<b>📝 原始 Prompt</b>\n` +
  `<blockquote expandable>${htmlEscape(prompt)}</blockquote>`;

const buildOptimizedPromptStatusText = (prompt: string): string =>
  `✅ <b>提示词已优化，正在生图...</b>\n\n` +
  `<b>🖼️ 优化后 Prompt</b>\n` +
  `<blockquote expandable>${htmlEscape(prompt)}</blockquote>\n` +
  `<i>⏳ 这条优化结果会在 10 秒后自动删除</i>`;

const buildMultiPromptStatusText = (title: string, prompts: string[]): string =>
  `✅ <b>${htmlEscape(title)}</b>\n\n` +
  prompts
    .map(
      (prompt, index) =>
        `<b>${index + 1}.</b>\n<blockquote expandable>${htmlEscape(prompt)}</blockquote>`,
    )
    .join("\n\n") +
  `\n<i>⏳ 这条优化结果会在 10 秒后自动删除</i>`;

const buildGeneratedPromptListText = (prompts: string[]): string =>
  prompts
    .map(
      (prompt, index) =>
        `${index + 1}. ${htmlEscape(prompt)}`,
    )
    .join("\n\n");

const runAIWithTimeout = async (
  aiService: AIService,
  request: string,
  imageParts: AIContentPart[],
  parentToken: AbortToken,
  timeoutMs: number,
): Promise<{ text: string; images: AIImage[] }> => {
  const requestToken = aiService.createAbortToken();
  const abortFromParent = () =>
    requestToken.abort(parentToken.reason || "操作已取消");
  if (parentToken.aborted) {
    abortFromParent();
  } else {
    parentToken.signal.addEventListener("abort", abortFromParent, {
      once: true,
    });
  }
  const timeoutId = setTimeout(() => requestToken.abort("请求超时"), timeoutMs);
  try {
    return await aiService.callAI(request, imageParts, requestToken);
  } finally {
    clearTimeout(timeoutId);
    parentToken.signal.removeEventListener("abort", abortFromParent);
    aiService.releaseToken(requestToken);
  }
};

interface AIMedia {
  data?: Buffer;
  url?: string;
  mimeType: string;
}

type AIImage = AIMedia;
type AIVideo = AIMedia;

type ResolvedImageData = {
  data: Buffer;
  mimeType: string;
};

interface AbortToken {
  readonly aborted: boolean;
  readonly reason?: string;
  readonly signal: AbortSignal;
  abort(reason?: string): void;
  throwIfAborted(): void;
}

interface FeatureHandler {
  readonly command: string;
  execute(msg: Api.Message, args: string[]): Promise<void>;
}

const execFileAsync = promisify(execFile);

type AuthMode = "bearer" | "query-key";

const PROVIDER_MODES = ["chat", "search", "image", "video"] as const;
type ProviderMode = (typeof PROVIDER_MODES)[number];

const MODE_META = {
  chat: {
    tagKey: "currentChatTag",
    modelKey: "currentChatModel",
    tagIcon: "💬",
    modelIcon: "🧠",
  },
  search: {
    tagKey: "currentSearchTag",
    modelKey: "currentSearchModel",
    tagIcon: "🔎",
    modelIcon: "📚",
  },
  image: {
    tagKey: "currentImageTag",
    modelKey: "currentImageModel",
    tagIcon: "🖼️",
    modelIcon: "🎨",
  },
  video: {
    tagKey: "currentVideoTag",
    modelKey: "currentVideoModel",
    tagIcon: "🎬",
    modelIcon: "📹",
  },
} as const satisfies Record<
  ProviderMode,
  {
    tagKey: keyof DB;
    modelKey: keyof DB;
    tagIcon: string;
    modelIcon: string;
  }
>;

const PROVIDER_TYPES = [
  "openai-compatible",
  "openai",
  "gemini",
  "doubao",
  "moonshot",
  "local-cliproxy",
] as const;

type ProviderType = (typeof PROVIDER_TYPES)[number];
const PROVIDER_TYPE_OPTIONS = PROVIDER_TYPES.join("/");

type ProviderStrategy =
  | "openai-rest"
  | "gemini-rest"
  | "doubao-rest"
  | "gemini-image-rest"
  | "gemini-video-rest";

type ModelMatchRule = {
  type: "prefix" | "exact" | "includes" | "regex";
  value: string;
};

type ImageDefaults = {
  size?: string;
  quality?: string;
  responseFormat?: "b64_json" | "url";
  extraParams?: Record<string, any>;
};

type VideoDefaults = {
  responseFormat?: "b64_json" | "url";
  extraParams?: Record<string, any>;
};

type ProviderModelRule = {
  match: ModelMatchRule;
  override: Partial<ProviderModeConfig>;
};

type ProviderModeConfig = {
  strategy: ProviderStrategy;
  endpoint?: string;
  authMode?: AuthMode;
  baseUrlType?: "origin" | "openai" | "gemini" | "raw";
  imageDefaults?: ImageDefaults;
  videoDefaults?: VideoDefaults;
  imageUrlPolicy?: "any" | "data-only";
  supportsEdit?: boolean;
  modelRules?: ProviderModelRule[];
};

type ProviderProfile = {
  id: ProviderType;
  authMode?: AuthMode;
  modes: Partial<Record<ProviderMode, ProviderModeConfig>>;
};

type VideoImageMode = "auto" | "reference" | "first" | "firstlast";

type ChatContext = {
  providerConfig: ProviderConfig;
  model: string;
  config: DB;
  modeConfig: ProviderModeConfig;
  question: string;
  images: AIContentPart[];
  token?: AbortToken;
};

type ImageContext = {
  providerConfig: ProviderConfig;
  model: string;
  config: DB;
  modeConfig: ProviderModeConfig;
  prompt: string;
  image?: AIImage;
  token?: AbortToken;
};

type VideoContext = {
  providerConfig: ProviderConfig;
  model: string;
  config: DB;
  modeConfig: ProviderModeConfig;
  prompt: string;
  images: AIContentPart[];
  imageMode: VideoImageMode;
  token?: AbortToken;
};

type StrategyHandler = {
  chat?: (ctx: ChatContext) => Promise<{ text: string; images: AIImage[] }>;
  search?: (ctx: ChatContext) => Promise<{
    text: string;
    sources: Array<{ url: string; title?: string }>;
  }>;
  image?: (ctx: ImageContext) => Promise<AIImage[]>;
  video?: (ctx: VideoContext) => Promise<AIVideo[]>;
};

const DEFAULT_PROVIDER_TYPE: ProviderType = "openai";

const mapHostsToProviderType = (
  hostList: string[],
  providerType: ProviderType,
): Record<string, ProviderType> => {
  const out: Record<string, ProviderType> = {};
  for (const h of hostList) {
    const host = h.trim();
    if (!host) continue;
    out[host] = providerType;
  }
  return out;
};

const createProviderProfile = (
  id: ProviderType,
  options: Omit<ProviderProfile, "id">,
): ProviderProfile => ({
  id,
  ...options,
});

const createOpenAIProfile = (
  id: "openai-compatible" | "openai",
): ProviderProfile =>
  createProviderProfile(id, {
    authMode: "bearer",
    modes: {
      chat: { strategy: "openai-rest" },
      search: { strategy: "openai-rest" },
      image: { strategy: "openai-rest", supportsEdit: true },
      video: { strategy: "openai-rest", endpoint: "chat/completions" },
    },
  });

const PROVIDER_PROFILES: Record<ProviderType, ProviderProfile> = {
  "openai-compatible": createOpenAIProfile("openai-compatible"),
  openai: createOpenAIProfile("openai"),
  gemini: createProviderProfile("gemini", {
    authMode: "query-key",
    modes: {
      chat: { strategy: "gemini-rest" },
      search: { strategy: "gemini-rest" },
      image: { strategy: "gemini-rest" },
      video: {
        strategy: "gemini-video-rest",
        baseUrlType: "gemini",
        endpoint: "v1beta/models/{model}:generateVideos",
      },
    },
  }),
  doubao: createProviderProfile("doubao", {
    authMode: "bearer",
    modes: {
      chat: {
        strategy: "openai-rest",
        baseUrlType: "origin",
        endpoint: "api/v3/chat/completions",
        imageUrlPolicy: "data-only",
      },
      image: {
        strategy: "doubao-rest",
        baseUrlType: "origin",
        endpoint: "api/v3/images/generations",
        imageDefaults: {
          size: "2K",
          responseFormat: "url",
          extraParams: {
            sequential_image_generation: "disabled",
            watermark: true,
          },
        },
        supportsEdit: true,
      },
      video: {
        strategy: "doubao-rest",
        baseUrlType: "origin",
        endpoint: "api/v3/contents/generations/tasks",
        videoDefaults: {
          extraParams: {},
        },
      },
    },
  }),
  moonshot: createProviderProfile("moonshot", {
    authMode: "bearer",
    modes: {
      chat: { strategy: "openai-rest" },
    },
  }),
  "local-cliproxy": createProviderProfile("local-cliproxy", {
    authMode: "query-key",
    modes: {
      chat: { strategy: "openai-rest", baseUrlType: "openai" },
      search: {
        strategy: "openai-rest",
        baseUrlType: "openai",
        modelRules: [
          {
            match: { type: "includes", value: "gemini" },
            override: {
              strategy: "gemini-rest",
              baseUrlType: "gemini",
            },
          },
        ],
      },
      image: {
        strategy: "gemini-image-rest",
        baseUrlType: "gemini",
        endpoint: "models/{model}:generateContent",
        authMode: "query-key",
        supportsEdit: true,
      },
      video: {
        strategy: "openai-rest",
        baseUrlType: "openai",
        endpoint: "chat/completions",
      },
    },
  }),
};

const PROVIDER_HOST_TYPES: Record<string, ProviderType> = {
  "generativelanguage.googleapis.com": "gemini",
  "ark.cn-beijing.volces.com": "doubao",
  "api.openai.com": "openai",
  "api.moonshot.cn": "moonshot",
  ...mapHostsToProviderType(["127.0.0.1", "api.abjj.de"], "local-cliproxy"),
};

const getProviderHost = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

const isHttpUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

const isProviderType = (value: string): value is ProviderType =>
  (PROVIDER_TYPES as readonly string[]).includes(value);

const normalizeProviderType = (value: unknown): ProviderType | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return isProviderType(normalized) ? normalized : undefined;
};

const resolveProviderType = (
  providerConfig?: Pick<ProviderConfig, "url" | "type"> | null,
): ProviderType => {
  const configuredType = normalizeProviderType(providerConfig?.type);
  if (configuredType) return configuredType;
  const host = providerConfig?.url ? getProviderHost(providerConfig.url) : null;
  if (!host) return DEFAULT_PROVIDER_TYPE;
  return PROVIDER_HOST_TYPES[host] ?? DEFAULT_PROVIDER_TYPE;
};

const getProviderProfile = (
  providerConfig?: Pick<ProviderConfig, "url" | "type"> | null,
): ProviderProfile => PROVIDER_PROFILES[resolveProviderType(providerConfig)];

const isOpenAIProviderType = (providerType: ProviderType): boolean =>
  providerType === "openai" || providerType === "openai-compatible";

const formatProviderTypeLabel = (
  providerConfig: Pick<ProviderConfig, "url" | "type">,
): string => {
  const configuredType = normalizeProviderType(providerConfig.type);
  if (configuredType) return configuredType;
  return `auto -> ${resolveProviderType(providerConfig)}`;
};

const mergeDefaults = <T extends { extraParams?: Record<string, any> }>(
  a?: T,
  b?: T,
): T | undefined => {
  if (!a && !b) return undefined;
  return {
    ...(a || {}),
    ...(b || {}),
    extraParams: { ...(a?.extraParams || {}), ...(b?.extraParams || {}) },
  } as T;
};

const matchModelRule = (model: string, rule: ModelMatchRule): boolean => {
  if (!model) return false;
  if (rule.type === "exact") return model === rule.value;
  if (rule.type === "prefix") return model.startsWith(rule.value);
  if (rule.type === "includes") return model.includes(rule.value);
  if (rule.type === "regex") {
    try {
      return new RegExp(rule.value).test(model);
    } catch {
      return false;
    }
  }
  return false;
};

const resolveModeConfig = (
  profile: ProviderProfile,
  mode: ProviderMode,
  model: string,
): ProviderModeConfig | undefined => {
  const base = profile.modes[mode];
  if (!base) return undefined;
  const rules = base.modelRules || [];
  const matchedRule = rules.find((rule) => matchModelRule(model, rule.match));
  if (!matchedRule) return { ...base };
  const ruleOverrides = matchedRule.override || {};
  return {
    ...base,
    ...ruleOverrides,
    imageDefaults: mergeDefaults(
      base.imageDefaults,
      ruleOverrides.imageDefaults,
    ),
    videoDefaults: mergeDefaults(
      base.videoDefaults,
      ruleOverrides.videoDefaults,
    ),
  };
};

const resolveBaseUrl = (
  providerConfig: ProviderConfig,
  modeConfig: ProviderModeConfig,
): string => {
  const baseType = modeConfig.baseUrlType ?? "raw";
  if (baseType === "origin") {
    return new URL(providerConfig.url).origin;
  }
  if (baseType === "openai") {
    return normalizeOpenAIBaseUrl(providerConfig.url);
  }
  if (baseType === "gemini") {
    return normalizeGeminiBaseUrl(providerConfig.url);
  }
  return providerConfig.url;
};

const resolveEndpointUrl = (baseUrl: string, endpoint?: string): string => {
  if (!endpoint) return baseUrl;
  if (/^https?:\/\//.test(endpoint)) return endpoint;
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const cleaned = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
  return new URL(cleaned, base).toString();
};

const resolveResponsesEndpointUrl = (
  providerConfig: ProviderConfig,
  modeConfig: ProviderModeConfig,
): string => {
  const baseUrl = resolveBaseUrl(providerConfig, modeConfig);
  const currentUrl = modeConfig.endpoint
    ? resolveEndpointUrl(baseUrl, modeConfig.endpoint)
    : baseUrl;
  const responsesBaseUrl = normalizeOpenAIBaseUrl(currentUrl);
  return resolveEndpointUrl(responsesBaseUrl, "responses");
};

const getMessageText = (m?: Api.Message | null): string => {
  if (!m) return "";
  const text = (m as any).message ?? (m as any).text ?? "";
  return typeof text === "string" ? text : "";
};

const htmlEscape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const getMainPrefix = (): string => getPrefixes()[0] || "";

const buildCommandUsage = (command: string): string =>
  `用法: <code>${htmlEscape(
    command.startsWith("aix")
      ? `${getMainPrefix()}${command}`
      : command,
  )}</code>`;

const buildMissingConfigMessage = (mode: ProviderMode): string => {
  const prefix = getMainPrefix();
  return (
    `请先配置 API 并设置模型\n` +
    `使用 <code>${htmlEscape(`${prefix}aix config add <tag...> <url> <key> [type]`)}</code> ` +
    `和 <code>${htmlEscape(`${prefix}aix model ${mode} <tag...> <model-path>`)}</code>`
  );
};

const requireConfiguredMode = (config: DB, mode: ProviderMode): void => {
  const { tagKey, modelKey } = MODE_META[mode];
  const tag = config[tagKey];
  if (!tag || !config[modelKey] || !config.configs[tag]) {
    throw new UserError(buildMissingConfigMessage(mode));
  }
};

const parseStrictInteger = (value?: string): number | null => {
  if (!value || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const buildResponsesInputContent = (
  text: string,
  images: AIContentPart[],
): Array<
  | { type: "input_text"; text: string }
  | {
      type: "input_image";
      image_url: string;
    }
> => {
  const parts: Array<
    | { type: "input_text"; text: string }
    | {
        type: "input_image";
        image_url: string;
      }
  > = [];

  if (text.trim()) {
    parts.push({ type: "input_text", text: text.trim() });
  }

  for (const part of images) {
    if (part.type !== "image_url") continue;
    parts.push({
      type: "input_image",
      image_url: part.image_url.url,
    });
  }

  return parts;
};

const extractErrorMessage = (error: any): string => {
  const msgText = typeof error?.message === "string" ? error.message : "";
  const reasonText =
    typeof error?.cause === "string"
      ? error.cause
      : error?.cause
        ? String(error.cause)
        : error?.config?.signal?.reason
          ? String(error.config.signal.reason)
          : "";

  if ((msgText + reasonText).includes("请求超时")) return "请求超时";
  if ((msgText + reasonText).includes("__AIX_SILENT_CANCEL__")) return "__AIX_SILENT_CANCEL__";
  if ((msgText + reasonText).includes("服务已停止")) return "操作已取消";
  if (error?.name === "AbortError" || msgText.toLowerCase().includes("aborted"))
    return "操作已取消";
  if (error?.code === "ECONNABORTED") return "请求超时";
  if (error?.response?.status === 429) return "请求过于频繁，请稍后重试";
  return (
    error?.response?.data?.error?.message ||
    error?.response?.data?.message ||
    msgText ||
    "未知错误"
  );
};

class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

const requireUser = (condition: any, message: string): void => {
  if (!condition) throw new UserError(message);
};

type ProcessingKind = "chat" | "search" | "image" | "video";

const PROCESSING_TEXT: Record<ProcessingKind, string> = {
  chat: "💬 <b>正在处理 chat 任务</b>",
  search: "🔎 <b>正在处理 search 任务</b>",
  image: "🖼️ <b>正在处理 image 任务</b>",
  video: "🎬 <b>正在处理 video 任务</b>",
};

const formatErrorForDisplay = (error: any): string => {
  if (
    error instanceof UserError ||
    error?.name === "AbortError" ||
    (typeof error?.message === "string" &&
      error.message.toLowerCase().includes("aborted"))
  ) {
    const extracted = extractErrorMessage(error);
    if (extracted === "请求超时") return `❌ <b>错误:</b> 请求超时`;
    const msg = error instanceof UserError ? error.message : "操作已取消";
    return `🚫 ${msg}`;
  }
  return `❌ <b>错误:</b> ${extractErrorMessage(error)}`;
};

const sendProcessing = async (
  msg: Api.Message,
  kind: ProcessingKind,
): Promise<void> => {
  await MessageSender.sendOrEdit(msg, PROCESSING_TEXT[kind], {
    parseMode: "html",
  });
};

const sendErrorMessage = async (
  msg: Api.Message,
  error: any,
  trigger?: Api.Message,
): Promise<void> => {
  if (extractErrorMessage(error) === "__AIX_SILENT_CANCEL__") return;
  await MessageSender.sendOrEdit(trigger || msg, formatErrorForDisplay(error), {
    parseMode: "html",
  });
};

const parseDataUrl = (
  url: string,
): { mimeType: string; data: Buffer } | null => {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: Buffer.from(match[2], "base64") };
};

const normalizeDownloadedMedia = async (
  downloaded: any,
): Promise<Buffer | null> => {
  if (!downloaded) return null;
  if (Buffer.isBuffer(downloaded)) return downloaded;
  if (typeof downloaded === "string" && downloaded.length > 0) {
    try {
      const stat = await fs.promises.stat(downloaded);
      if (!stat.isFile()) return null;
      return await fs.promises.readFile(downloaded);
    } catch {
      return null;
    }
  }
  return null;
};



const getImageExtensionForMime = (mimeType: string): string => {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  return ".jpg";
};

const extractFirstFrame = async (buffer: Buffer): Promise<Buffer | null> => {
  try {
    return await sharp(buffer, { animated: true }).png().toBuffer();
  } catch {
    return null;
  }
};

const getDocumentThumb = (doc: Api.Document): Api.TypePhotoSize | undefined => {
  const thumbs = doc.thumbs || [];
  if (thumbs.length === 0) return undefined;
  return thumbs[thumbs.length - 1];
};

const resolveImageInputs = async (
  parts: AIContentPart[],
  httpClient: HttpClient,
  token?: AbortToken,
  options?: { allowFailures?: boolean },
): Promise<ResolvedImageData[]> => {
  const allowFailures = options?.allowFailures ?? false;
  const imageParts = parts.filter(
    (part): part is Extract<AIContentPart, { type: "image_url" }> =>
      part.type === "image_url",
  );

  const resolvePart = async (
    part: Extract<AIContentPart, { type: "image_url" }>,
  ): Promise<ResolvedImageData | null> => {
    token?.throwIfAborted();
    const dataUrl = parseDataUrl(part.image_url.url);
    if (dataUrl) {
      return { data: dataUrl.data, mimeType: dataUrl.mimeType };
    }
    const image = await resolveAIImageData(
      { url: part.image_url.url, mimeType: "image/jpeg" },
      httpClient,
      token,
    );
    return image?.data
      ? { data: image.data, mimeType: image.mimeType }
      : null;
  };

  if (!allowFailures) {
    for (const part of imageParts) {
      const resolved = await resolvePart(part);
      if (resolved) return [resolved];
    }
    return [];
  }

  const resolved = await Promise.all(
    imageParts.map(async (part) => {
      try {
        return await resolvePart(part);
      } catch {
        return null;
      }
    }),
  );
  return resolved.filter(
    (item): item is ResolvedImageData => item !== null,
  );
};

const resolveMergedImageParts = async (
  parts: AIContentPart[],
  httpClient: HttpClient,
  token?: AbortToken,
): Promise<AIImage | null> => {
  const resolved = await resolveImageInputs(parts.slice(0, 6), httpClient, token, {
    allowFailures: true,
  });
  if (!resolved.length) return null;
  if (resolved.length === 1) return { data: resolved[0].data, mimeType: resolved[0].mimeType };

  const inputItems = resolved;
  const cell = 512;
  const gap = 24;
  const labelH = 46;
  const cols = Math.min(2, inputItems.length);
  const rows = Math.ceil(inputItems.length / cols);
  const labels = ["IMAGE A", "IMAGE B", "IMAGE C", "IMAGE D", "IMAGE E", "IMAGE F"];
  const composites: sharp.OverlayOptions[] = [];

  const renderedItems = await Promise.all(inputItems.map(async (item) => {
    const buf = await sharp(item.data)
      .resize(cell, cell, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "white" })
      .png()
      .toBuffer();
    const meta = await sharp(buf).metadata();
    return { buf, width: meta.width || cell, height: meta.height || cell };
  }));

  for (let i = 0; i < renderedItems.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const left = gap + col * (cell + gap);
    const top = gap + row * (cell + labelH + gap) + labelH;
    const { buf, width: imgW, height: imgH } = renderedItems[i];
    composites.push({ input: buf, left: left + Math.floor((cell - imgW) / 2), top: top + Math.floor((cell - imgH) / 2) });
    const svg = `<svg width="${cell}" height="${labelH}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="50%" y="31" text-anchor="middle" font-size="25" font-family="Arial" font-weight="700" fill="#111">${labels[i]}</text></svg>`;
    composites.push({ input: Buffer.from(svg), left, top: top - labelH });
  }

  const canvasW = cols * cell + (cols + 1) * gap;
  const canvasH = rows * (cell + labelH) + (rows + 1) * gap;
  const merged = await sharp({
    create: { width: canvasW, height: canvasH, channels: 3, background: "white" },
  }).composite(composites).png().toBuffer();
  return { data: merged, mimeType: "image/png" };
};


const collectImagePartsFromSingleMessage = async (
  msg: Api.Message,
  out: AIContentPart[],
): Promise<void> => {
  if (!msg.media || !msg.client) return;

  if (msg.media instanceof Api.MessageMediaPhoto) {
    const downloaded = await msg.client.downloadMedia(msg);
    const buffer = await normalizeDownloadedMedia(downloaded);
    if (!buffer) return;
    const dataUrl = `data:image/jpeg;base64,${buffer.toString("base64")}`;
    out.push({ type: "image_url", image_url: { url: dataUrl } });
    return;
  }

  if (
    msg.media instanceof Api.MessageMediaDocument &&
    msg.media.document instanceof Api.Document
  ) {
    const doc = msg.media.document;
    const docMime = doc.mimeType || "";
    const fileName = doc.attributes
      ?.find((attr) => attr instanceof Api.DocumentAttributeFilename)
      ?.fileName || "";
    const isImageFile =
      docMime.startsWith("image/") ||
      /\.(?:jpe?g|png|webp|gif|bmp|tiff?|avif|heic|heif)$/i.test(fileName);
    const isAnimated =
      docMime === "image/gif" ||
      docMime === "video/webm" ||
      docMime === "application/x-tgsticker" ||
      docMime === "application/x-tg-sticker" ||
      doc.attributes?.some(
        (attr) => attr instanceof Api.DocumentAttributeAnimated,
      );

    const thumb = getDocumentThumb(doc);

    if (!isAnimated && isImageFile) {
      const downloaded = await msg.client.downloadMedia(msg);
      const buffer = await normalizeDownloadedMedia(downloaded);
      if (!buffer) return;
      let imageMime = docMime.startsWith("image/") ? docMime : "image/png";
      if (!docMime.startsWith("image/")) {
        try {
          const metadata = await sharp(buffer).metadata();
          const formatMime: Record<string, string> = {
            jpeg: "image/jpeg",
            png: "image/png",
            webp: "image/webp",
            gif: "image/gif",
            avif: "image/avif",
            heif: "image/heif",
            tiff: "image/tiff",
          };
          imageMime = formatMime[metadata.format || ""] || imageMime;
        } catch {
          return;
        }
      }
      const dataUrl = `data:${imageMime};base64,${buffer.toString("base64")}`;
      out.push({ type: "image_url", image_url: { url: dataUrl } });
      return;
    }

    let frameBuffer: Buffer | null = null;

    if (thumb) {
      const downloaded = await msg.client.downloadMedia(msg, { thumb });
      const buffer = await normalizeDownloadedMedia(downloaded);
      if (buffer) {
        try {
          frameBuffer = await sharp(buffer).png().toBuffer();
        } catch {
          frameBuffer = buffer;
        }
      }
    }

    if (!frameBuffer) {
      const downloaded = await msg.client.downloadMedia(msg);
      const buffer = await normalizeDownloadedMedia(downloaded);
      if (buffer) {
        try {
          frameBuffer = await extractFirstFrame(buffer);
        } catch {
          frameBuffer = null;
        }
      }
    }

    if (!frameBuffer) return;

    const dataUrl = `data:image/png;base64,${frameBuffer.toString("base64")}`;
    out.push({ type: "image_url", image_url: { url: dataUrl } });
  }
};

const getMessageImageParts = async (
  msg?: Api.Message,
): Promise<AIContentPart[]> => {
  if (!msg?.client) return [];

  const parts: AIContentPart[] = [];

  const rawGroupedId = (msg as any).groupedId;
  const groupedId = rawGroupedId ? rawGroupedId.toString() : undefined;

  if (!groupedId) {
    await collectImagePartsFromSingleMessage(msg, parts);
    return parts;
  }

  const peer = msg.chatId || msg.peerId;
  const sameGroupMessages: Api.Message[] = [];

  for await (const m of msg.client.iterMessages(peer, { limit: 50, offsetDate: 0 })) {
    if (!(m instanceof Api.Message)) continue;

    const g = (m as any).groupedId;
    if (!g) continue;

    if (g.toString() !== groupedId) continue;

    sameGroupMessages.push(m);
  }

  sameGroupMessages.sort((a, b) => Number(a.id) - Number(b.id));

  const groupedParts = await Promise.all(
    sameGroupMessages.map(async (message) => {
      const messageParts: AIContentPart[] = [];
      await collectImagePartsFromSingleMessage(message, messageParts);
      return messageParts;
    }),
  );
  parts.push(...groupedParts.flat());

  return parts;
};

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T | null> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const downloadAvatarBufferCompat = async (msg?: Api.Message): Promise<Buffer | null> => {
  if (!msg?.client) return null;
  const client = msg.client;
  const candidates: any[] = [];
  const pushCandidate = (value: any) => {
    if (value === undefined || value === null) return;
    if (candidates.some((item) => String(item?.id ?? item) === String(value?.id ?? value))) return;
    candidates.push(value);
  };

  // senderId/fromId 让 teleproto 重新解析；sender 对象作为兜底，兼容不同消息来源。
  pushCandidate((msg as any).senderId);
  pushCandidate(msg.fromId);
  try {
    const sender = await msg.getSender?.();
    pushCandidate(sender?.id);
    pushCandidate(sender);
  } catch {}

  for (const candidate of candidates) {
    const photos = await Promise.all(
      [true, false].map(async (isBig) => {
        try {
          return await withTimeout(
            client.downloadProfilePhoto(candidate, { isBig }),
            12000,
          );
        } catch {
          return null;
        }
      }),
    );
    const photoBuf = photos.find(
      (photo): photo is Buffer =>
        Buffer.isBuffer(photo) && photo.length > 0,
    );
    if (photoBuf) return photoBuf;
  }
  return null;
};

const getAvatarImagePartFromMessageSender = async (
  msg?: Api.Message,
): Promise<AIContentPart | null> => {
  const photoBuf = await downloadAvatarBufferCompat(msg);
  if (!photoBuf) return null;
  return {
    type: "image_url",
    image_url: { url: `data:image/jpeg;base64,${photoBuf.toString("base64")}` },
  };
};

const getGroupedMessageIds = async (msg: Api.Message): Promise<number[]> => {
  if (!msg?.client) return [];
  const rawGroupedId = (msg as any).groupedId;
  const groupedId = rawGroupedId ? rawGroupedId.toString() : undefined;
  if (!groupedId) return [];

  const peer = msg.chatId || msg.peerId;
  const ids: number[] = [];

  for await (const m of msg.client.iterMessages(peer, { limit: 50, offsetDate: 0 })) {
    if (!(m instanceof Api.Message)) continue;
    const g = (m as any).groupedId;
    if (!g) continue;
    if (g.toString() !== groupedId) continue;
    ids.push(Number(m.id));
  }

  if (!ids.includes(Number(msg.id))) ids.push(Number(msg.id));

  return Array.from(new Set(ids)).sort((a, b) => a - b);
};

const deleteMessageOrGroup = async (msg: Api.Message): Promise<void> => {
  try {
    if (!msg?.client) return;
    const peer = msg.chatId || msg.peerId;
    const ids = await getGroupedMessageIds(msg);

    if (ids.length > 1) {
      await msg.client.deleteMessages(peer, ids, { revoke: true });
      return;
    }
    await msg.delete();
  } catch {}
};

const scheduleDeleteMessage = (msg: Api.Message | undefined, delayMs: number): void => {
  if (!msg || delayMs <= 0) return;
  setTimeout(() => {
    void msg.delete().catch(() => {});
  }, delayMs);
};

const replaceStatusMessage = async (
  current: Api.Message | undefined,
  msg: Api.Message,
  text: string,
): Promise<Api.Message> =>
  MessageSender.sendOrEdit(current ?? msg, text, { parseMode: "html" });

const getHeaderContentType = (headers: unknown): string | undefined => {
  if (!headers || typeof headers !== "object") return undefined;
  const contentType = (headers as Record<string, unknown>)["content-type"];
  if (typeof contentType === "string") {
    return contentType.split(";")[0];
  }
  if (Array.isArray(contentType)) {
    const first = contentType.find((value) => typeof value === "string");
    if (typeof first === "string") {
      return first.split(";")[0];
    }
  }
  return undefined;
};

const resolveAIImageData = async (
  image: AIImage,
  httpClient: HttpClient,
  token?: AbortToken,
): Promise<AIImage | null> => {
  if (image.data) return image;
  if (!image.url) return null;
  const response = await httpClient.request(
    {
      url: image.url,
      method: "GET",
      responseType: "arraybuffer",
    },
    token,
  );
  const contentType =
    getHeaderContentType(response.headers) ||
    image.mimeType ||
    "image/jpeg";
  return { data: Buffer.from(response.data), mimeType: contentType };
};

const getVideoExtensionForMime = (mimeType: string): string => {
  if (mimeType === "video/webm") return ".webm";
  if (mimeType === "video/quicktime") return ".mov";
  return ".mp4";
};

const resolveAIVideoData = async (
  video: AIVideo,
  httpClient: HttpClient,
  token?: AbortToken,
): Promise<AIVideo | null> => {
  if (video.data) return video;
  if (!video.url) return null;
  const response = await httpClient.request(
    {
      url: video.url,
      method: "GET",
      responseType: "arraybuffer",
    },
    token,
  );
  const contentType =
    getHeaderContentType(response.headers) ||
    video.mimeType ||
    "video/mp4";
  return { data: Buffer.from(response.data), mimeType: contentType };
};

const videoHasAudioTrack = async (filePath: string): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-select_streams",
      "a:0",
      "-of",
      "json",
      filePath,
    ]);

    const info = JSON.parse(stdout);
    const streams = info.streams || [];
    return streams.length > 0;
  } catch {
    return false;
  }
};

const ensureVideoHasAudio = async (
  inputPath: string,
  outputPath: string,
): Promise<string> => {
  try {
    const hasAudio = await videoHasAudioTrack(inputPath);
    if (hasAudio) {
      return inputPath;
    }

    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      inputPath,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-c:v",
      "copy",
      "-shortest",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      outputPath,
    ]);

    return outputPath;
  } catch {
    return inputPath;
  }
};

const createAbortToken = (): AbortToken => {
  const controller = new AbortController();
  return {
    get aborted() {
      return controller.signal.aborted;
    },
    get reason() {
      return controller.signal.reason?.toString();
    },
    get signal() {
      return controller.signal;
    },
    abort(reason?: string) {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    throwIfAborted() {
      if (controller.signal.aborted) {
        throw new UserError(
          controller.signal.reason?.toString() || "操作已取消",
        );
      }
    },
  };
};

const sleep = (ms: number, token?: AbortToken): Promise<void> => {
  return new Promise<void>((resolve, reject) => {
    token?.throwIfAborted();
    let settled = false;
    const cleanup = () => {
      if (!token?.signal) return;
      token.signal.removeEventListener("abort", abortHandler);
    };
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, ms);
    const abortHandler = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      cleanup();
      reject(new UserError(token?.reason?.toString() || "操作已取消"));
    };
    if (token?.signal)
      token.signal.addEventListener("abort", abortHandler, { once: true });
  });
};

const runOrderedJobs = async <T>(
  count: number,
  concurrency: number,
  token: AbortToken | undefined,
  job: (index: number) => Promise<T>,
): Promise<T[]> => {
  if (count <= 0) return [];
  const results = new Array<T>(count);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, count));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      token?.throwIfAborted();
      const index = nextIndex++;
      if (index >= count) return;
      results[index] = await job(index);
    }
  });
  await Promise.all(workers);
  return results;
};

const retryWithFixedDelay = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = 2,
  delayMs: number = 1000,
  token?: AbortToken,
): Promise<T> => {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    token?.throwIfAborted();
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      if (token?.aborted) throw error;
      if (!isRetryableError(error)) throw error;
      if (i === maxRetries - 1) break;
      await sleep(delayMs, token);
    }
  }
  throw lastError;
};

const isRetryableError = (error: any): boolean => {
  if (!error) return false;
  if (error.name === "AbortError") return false;
  if (
    typeof error.message === "string" &&
    error.message.toLowerCase().includes("aborted")
  )
    return false;

  const status = error.response?.status;
  if (typeof status === "number") {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    return false;
  }

  if (error.isAxiosError && !error.response) return true;
  if (typeof error.code === "string") return true;

  return false;
};

type TaskStatus = "pending" | "running" | "succeeded" | "failed";

interface TaskPollResult<T> {
  status: TaskStatus;
  result?: T;
  errorMessage?: string;
}

interface TaskPollOptions {
  maxAttempts?: number;
  intervalMs?: number;
}

type TaskFetchFn = (token?: AbortToken) => Promise<any>;
type TaskParseFn<T> = (data: any) => TaskPollResult<T>;

const pollTask = async <T>(
  fetchJob: TaskFetchFn,
  parseResult: TaskParseFn<T>,
  options: TaskPollOptions = {},
  token?: AbortToken,
): Promise<T> => {
  const maxAttempts = options.maxAttempts ?? 303;
  const intervalMs = options.intervalMs ?? 2000;

  for (let i = 0; i < maxAttempts; i++) {
    token?.throwIfAborted();

    const data = await retryWithFixedDelay(
      () => fetchJob(token),
      2,
      1000,
      token,
    );
    const result = parseResult(data);

    if (result.status === "failed") {
      throw new Error(result.errorMessage || "任务执行失败");
    }

    if (result.status === "succeeded") {
      if (result.result === undefined) {
        throw new Error("任务成功但未返回结果");
      }
      return result.result;
    }

    await sleep(intervalMs, token);
  }

  throw new Error("任务执行超时");
};

interface MessageOptions {
  parseMode?: string;
  linkPreview?: boolean;
}

const getEditErrorText = (error: any): string => {
  const parts = [
    typeof error?.errorMessage === "string" ? error.errorMessage : "",
    typeof error?.message === "string" ? error.message : "",
  ].filter(Boolean);
  return parts.join(" ");
};

const isMessageNotModifiedError = (error: any): boolean =>
  getEditErrorText(error).includes("MESSAGE_NOT_MODIFIED");

const shouldFallbackToReplyOnEditError = (error: any): boolean => {
  const text = getEditErrorText(error);
  return (
    text.includes("MESSAGE_ID_INVALID") ||
    text.includes("MESSAGE_AUTHOR_REQUIRED")
  );
};

const getTopicRootId = (msg: Api.Message): number | undefined => {
  const typedMsg = msg as Api.Message & {
    replyTo?: { replyToTopId?: number; replyToMsgId?: number };
    replyToMsgId?: number;
  };
  return typedMsg.replyTo?.replyToTopId ?? typedMsg.replyTo?.replyToMsgId ?? typedMsg.replyToMsgId;
};

class MessageSender {
  static async sendOrEdit(
    msg: Api.Message,
    text: string,
    options?: MessageOptions,
  ): Promise<Api.Message> {
    try {
      const edited = await msg.edit({ text, ...options });
      if (edited) return edited;
    } catch (error: any) {
      if (isMessageNotModifiedError(error)) {
        return msg;
      }
      if (shouldFallbackToReplyOnEditError(error)) {
        const replied = await msg.reply({ message: text, ...options });
        if (replied) return replied;
      }
      throw error;
    }

    const replied = await msg.reply({ message: text, ...options });
    if (replied) return replied;
    throw new Error("消息发送失败");
  }

  static async sendNew(
    msg: Api.Message,
    text: string,
    options?: MessageOptions,
    replyToId?: number,
  ): Promise<Api.Message> {
    if (!msg.client) {
      throw new Error("客户端未初始化");
    }

    const topicRootId = getTopicRootId(msg);
    const replyTo = replyToId ?? topicRootId;
    return await msg.client.sendMessage(msg.chatId || msg.peerId, {
      message: text,
      ...(options || {}),
      ...(replyTo ? { replyTo } : {}),
    });
  }
}

class MessageUtils {
  private telegraphTokenPromise: Promise<string> | null = null;

  constructor(
    private readonly configManagerPromise: Promise<ConfigManager>,
    private readonly httpClient: HttpClient,
  ) {}

  async createTelegraphPage(
    markdown: string,
    titleSource?: string,
    token?: AbortToken,
  ): Promise<TelegraphItem> {
    const configManager = await this.configManagerPromise;
    const config = configManager.getConfig();

    const tgToken = await this.ensureTGToken(config, token);
    const rawTitle = (titleSource || "").replace(/\s+/g, " ").trim();
    const shortTitle =
      rawTitle.length > 24 ? `${rawTitle.slice(0, 24)}…` : rawTitle;
    const title = shortTitle || `Telegraph - ${new Date().toLocaleString()}`;
    const nodes = TelegraphFormatter.toNodes(markdown);

    const response = await this.httpClient.request(
      {
        url: "https://api.telegra.ph/createPage",
        method: "POST",
        data: {
          access_token: tgToken,
          title,
          content: nodes,
          return_content: false,
        },
      },
      token,
    );

    const url = response.data?.result?.url;
    if (!url) throw new Error(response.data?.error || "Telegraph 页面创建失败");

    return { url, title, createdAt: new Date().toISOString() };
  }

  async sendLongMessage(
    msg: Api.Message,
    text: string,
    replyToId?: number,
    token?: AbortToken,
    options?: { poweredByTag?: string },
  ): Promise<Api.Message> {
    token?.throwIfAborted();

    const configManager = await this.configManagerPromise;
    const config = configManager.getConfig();

    const poweredByTag = (options?.poweredByTag ?? config.currentChatTag) || "";
    const poweredByText = poweredByTag
      ? `\n<i>🍀Powered by ${poweredByTag}</i>`
      : "";

    if (text.length <= 4050) {
      token?.throwIfAborted();

      const parts = text.split(/(?=A:\n)/);
      if (parts.length === 2) {
        const questionPart = parts[0];
        const answerPart = parts[1];
        const cleanAnswer = answerPart.replace(/^A:\n/, "");
        const cleanQuestion = questionPart
          .replace(/^Q:\n/, "")
          .replace(/\n\n$/, "");
        const questionBlock = `Q:\n${this.wrapHtmlWithCollapseIfNeeded(cleanQuestion, config.collapse)}\n`;
        const answerBlock = `A:\n${this.wrapHtmlWithCollapseIfNeeded(cleanAnswer, config.collapse)}`;
        const finalText = questionBlock + answerBlock + poweredByText;

        return await this.sendHtml(msg, finalText, replyToId, false);
      }
      const finalText =
        this.wrapHtmlWithCollapseIfNeeded(text, config.collapse) +
        poweredByText;
      return await this.sendHtml(msg, finalText, replyToId, false);
    }

    const qa = text.match(/Q:\n([\s\S]+?)\n\nA:\n([\s\S]+)/);
    if (!qa) {
      token?.throwIfAborted();
      const finalText =
        this.wrapHtmlWithCollapseIfNeeded(text, config.collapse) +
        poweredByText;
      return await this.sendHtml(msg, finalText, replyToId, false);
    }

    const [, question, answer] = qa;
    const answerText = answer.replace(/^A:\n/, "");
    const chunks: string[] = [];
    let current = "";

    for (const line of answerText.split("\n")) {
      token?.throwIfAborted();
      const testLength = (current + line + "\n").length;
      if (testLength > 4050 && current) {
        chunks.push(current);
        current = line;
      } else {
        current += (current ? "\n" : "") + line;
      }
    }
    if (current) chunks.push(current);

    token?.throwIfAborted();

    const firstMessageContent =
      `Q:\n${this.wrapHtmlWithCollapseIfNeeded(question, config.collapse)}\n` +
      `A:\n${this.wrapHtmlWithCollapseIfNeeded(chunks[0], config.collapse)}`;

    const firstMessage = await this.sendHtml(
      msg,
      firstMessageContent,
      replyToId,
    );

    for (let idx = 1; idx < chunks.length; idx++) {
      if (token?.aborted) break;
      await sleep(500, token);
      if (token?.aborted) break;

      const isLast = idx === chunks.length - 1;
      const wrapped = this.wrapHtmlWithCollapseIfNeeded(
        chunks[idx],
        config.collapse,
      );
      const prefix = `📋 <b>续 (${idx}/${chunks.length - 1}):</b>\n\n`;
      const finalMessage = prefix + wrapped + (isLast ? poweredByText : "");

      await this.sendHtml(msg, finalMessage, firstMessage.id, false);
    }

    return firstMessage;
  }

  async sendImages(
    msg: Api.Message,
    images: AIImage[],
    prompt: string | string[],
    replyToId?: number,
    token?: AbortToken,
    notice?: string,
  ): Promise<void> {
    const config = (await this.configManagerPromise).getConfig();
    await this.sendMedia(msg, images, prompt, replyToId, token, {
      previewEnabled: config.imagePreview,
      poweredByTag: config.currentImageTag,
      collapse: config.collapse,
      directory: "ai_images",
      filePrefix: "aix",
      saveToFavorites: config.imageSaveToFavorites,
      getExtension: getImageExtensionForMime,
      resolve: (image, mediaToken) =>
        resolveAIImageData(image, this.httpClient, mediaToken),
    }, notice);
  }

  async sendVideos(
    msg: Api.Message,
    videos: AIVideo[],
    prompt: string,
    replyToId?: number,
    token?: AbortToken,
  ): Promise<void> {
    const config = (await this.configManagerPromise).getConfig();
    await this.sendMedia(msg, videos, prompt, replyToId, token, {
      previewEnabled: config.videoPreview,
      poweredByTag: config.currentVideoTag,
      collapse: config.collapse,
      directory: "ai_videos",
      filePrefix: "aix_video",
      rawFilePrefix: "aix_video_raw",
      saveToFavorites: config.videoSaveToFavorites,
      getExtension: getVideoExtensionForMime,
      resolve: (video, mediaToken) =>
        resolveAIVideoData(video, this.httpClient, mediaToken),
      prepareForSend: (rawPath, finalPath) =>
        ensureVideoHasAudio(rawPath, finalPath),
    });
  }

  private async sendMedia<T extends AIImage | AIVideo>(
    msg: Api.Message,
    mediaItems: T[],
    prompt: string | string[],
    replyToId: number | undefined,
    token: AbortToken | undefined,
    options: {
      previewEnabled: boolean;
      poweredByTag: string;
      collapse: boolean;
      directory: string;
      filePrefix: string;
      rawFilePrefix?: string;
      saveToFavorites?: boolean;
      getExtension: (mimeType: string) => string;
      resolve: (
        item: T,
        mediaToken?: AbortToken,
      ) => Promise<{ data?: Buffer; mimeType: string } | null>;
      prepareForSend?: (rawPath: string, finalPath: string) => Promise<string>;
    },
    notice?: string,
  ): Promise<void> {
    if (!mediaItems.length) return;

    const peerId = msg.chatId || msg.peerId;
    const promptList = Array.isArray(prompt) ? prompt : [prompt];
    const poweredByText = `\n<i>🍀Powered by ${options.poweredByTag}</i>`;
    const renderCaption = (text: string): string => {
      const promptText = htmlEscape(text);
      const promptBlock = options.collapse
        ? `<blockquote expandable>${promptText}</blockquote>`
        : promptText;
      return promptBlock + poweredByText;
    };
    const combinedPrompt = Array.isArray(prompt)
      ? prompt.map((text, index) => `${index + 1}. ${text}`).join("\n\n")
      : prompt;
    const captionBody = notice ? `${notice}\n\n${combinedPrompt}` : combinedPrompt;
    const caption = renderCaption(captionBody);
    const itemCaptions = promptList.map((text) => renderCaption(notice ? `${notice}\n\n${text}` : text));
    const mediaDir = createDirectoryInAssets(options.directory);
    const timestamp = Date.now();

    if (mediaItems.length > 1) {
      const cleanupAll: string[] = [];
      try {
        const preparedPaths = await runOrderedJobs(
          mediaItems.length,
          2,
          token,
          async (i) => {
            const item = mediaItems[i];
            token?.throwIfAborted();
            const resolved = await options.resolve(item, token);
            if (!resolved?.data) return null;
            const extension = options.getExtension(resolved.mimeType);
            const rawPrefix = options.rawFilePrefix ?? options.filePrefix;
            const rawName = `${rawPrefix}_${timestamp}_${i}${extension}`;
            const finalName = `${options.filePrefix}_${timestamp}_${i}${extension}`;
            const rawPath = path.join(mediaDir, rawName);
            const finalPath = path.join(mediaDir, finalName);
            await fs.promises.writeFile(rawPath, resolved.data);
            cleanupAll.push(rawPath);
            const pathToSend = options.prepareForSend
              ? await options.prepareForSend(rawPath, finalPath)
              : rawPath;
            if (options.prepareForSend) cleanupAll.push(finalPath);
            return pathToSend;
          },
        );
        const pathsToSend = preparedPaths.filter(
          (item): item is string => item !== null,
        );
        if (pathsToSend.length > 1) {
          if (!msg.client) throw new Error("客户端未初始化");
          const topicRootId = getTopicRootId(msg);
          const replyTo = replyToId ?? topicRootId;
          await msg.client.sendFile(peerId, {
            file: pathsToSend,
            forceDocument: !options.previewEnabled,
            caption: options.previewEnabled
              ? caption
              : pathsToSend.map((_, index) => index === pathsToSend.length - 1 ? caption : ""),
            parseMode: "html",
            ...(replyTo ? { replyTo } : {}),
          });
          if (options.saveToFavorites) {
            try {
              await msg.client.sendFile("me", { file: pathsToSend, forceDocument: true });
            } catch (error) {
              console.warn("[aix] 原图发送到收藏失败:", error);
            }
          }
          return;
        }
        throw new Error("批量媒体解析不足，无法合并发送");
      } finally {
        for (const p of cleanupAll) fs.unlink(p, () => {});
      }
    }

    for (let i = 0; i < mediaItems.length; i++) {
      const item = mediaItems[i];
      token?.throwIfAborted();

      const resolved = await options.resolve(item, token);
      if (!resolved?.data) continue;

      const extension = options.getExtension(resolved.mimeType);
      const rawPrefix = options.rawFilePrefix ?? options.filePrefix;
      const rawName = `${rawPrefix}_${timestamp}_${i}${extension}`;
      const finalName = `${options.filePrefix}_${timestamp}_${i}${extension}`;
      const rawPath = path.join(mediaDir, rawName);
      const finalPath = path.join(mediaDir, finalName);

      try {
        await fs.promises.writeFile(rawPath, resolved.data);
        const pathToSend = options.prepareForSend
          ? await options.prepareForSend(rawPath, finalPath)
          : rawPath;

        if (!msg.client) {
          throw new Error("客户端未初始化");
        }

        const topicRootId = getTopicRootId(msg);
        const replyTo = replyToId ?? topicRootId;
        await msg.client.sendFile(peerId, {
          file: pathToSend,
          forceDocument: !options.previewEnabled,
          caption: itemCaptions[i] ?? caption,
          parseMode: "html",
          ...(replyTo ? { replyTo } : {}),
        });
        if (options.saveToFavorites) {
          try {
            await msg.client.sendFile("me", { file: pathToSend, forceDocument: true });
          } catch (error) {
            console.warn("[aix] 原图发送到收藏失败:", error);
          }
        }
      } finally {
        const cleanupTargets = options.prepareForSend
          ? [rawPath, finalPath]
          : [rawPath];
        for (const p of cleanupTargets) {
          fs.unlink(p, () => {});
        }
      }
    }
  }

  private async ensureTGToken(config: DB, token?: AbortToken): Promise<string> {
    if (config.telegraphToken) return config.telegraphToken;
    if (this.telegraphTokenPromise) return this.telegraphTokenPromise;

    this.telegraphTokenPromise = (async () => {
      const response = await this.httpClient.request(
        {
          url: "https://api.telegra.ph/createAccount",
          method: "POST",
          data: { short_name: "TeleBoxAI", author_name: "TeleBox" },
        },
        token,
      );

      const tgToken = response.data?.result?.access_token;
      if (!tgToken) throw new Error("Telegraph 账户创建失败");

      const configManager = await this.configManagerPromise;
      await configManager.updateConfig((cfg) => {
        cfg.telegraphToken = tgToken;
      });

      return tgToken;
    })();

    try {
      return await this.telegraphTokenPromise;
    } finally {
      this.telegraphTokenPromise = null;
    }
  }

  private wrapHtmlWithCollapseIfNeeded(
    html: string,
    collapse: boolean,
  ): string {
    return collapse ? `<blockquote expandable>${html}</blockquote>` : html;
  }

  private async sendHtml(
    msg: Api.Message,
    html: string,
    replyToId?: number,
    linkPreview?: boolean,
  ): Promise<Api.Message> {
    return await MessageSender.sendNew(
      msg,
      html,
      {
        parseMode: "html",
        ...(linkPreview === undefined ? {} : { linkPreview }),
      },
      replyToId,
    );
  }
}

class ConfigManager {
  private static instancePromise: Promise<ConfigManager> | null = null;
  private currentConfig: DB;
  private db: Low<DB> | null = null;
  private baseDir: string = "";
  private file: string = "";

  private writeQueue: Promise<void> = Promise.resolve();

  private constructor() {
    this.currentConfig = this.getDefaultConfig();
  }

  private getDefaultConfig(): DB {
    return {
      configs: {},
      currentChatTag: "",
      currentChatModel: "",
      currentSearchTag: "",
      currentSearchModel: "",
      currentImageTag: "",
      currentImageModel: "",
      currentVideoTag: "",
      currentVideoModel: "",
      imagePreview: true,
      imageSaveToFavorites: false,
      promptOptimize: true,
      videoPromptOptimize: true,
      videoPreview: true,
      videoSaveToFavorites: false,
      videoAudio: false,
      videoDuration: 5,
      prompt: "",
      collapse: true,
      timeout: 30,
      telegraphToken: "",
      telegraph: { enabled: false, limit: 5, list: [] },
    };
  }

  static getInstance(): Promise<ConfigManager> {
    if (ConfigManager.instancePromise) {
      return ConfigManager.instancePromise;
    }

    ConfigManager.instancePromise = (async () => {
      const instance = new ConfigManager();
      await instance.init();
      return instance;
    })();

    return ConfigManager.instancePromise;
  }

  private async init(): Promise<void> {
    if (this.db) return;

    this.baseDir = createDirectoryInAssets("aix");
    this.file = path.join(this.baseDir, "config.json");
    this.db = await JSONFilePreset<DB>(this.file, this.getDefaultConfig());

    await this.writeQueue;
    await this.db.read();
    this.currentConfig = { ...this.db.data };
    const before = JSON.stringify(this.currentConfig);
    this.ensureDefaults();
    const after = JSON.stringify(this.currentConfig);
    if (before !== after) {
      this.db.data = { ...this.currentConfig };
      await this.db.write();
    }
  }

  getConfig(): DB {
    return { ...this.currentConfig };
  }

  async updateConfig(updater: (config: DB) => void): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const oldSnapshot: DB = JSON.parse(JSON.stringify(this.currentConfig));
      updater(this.currentConfig);

      const hasChanged =
        JSON.stringify(oldSnapshot) !== JSON.stringify(this.currentConfig);

      if (!hasChanged) {
        return;
      }

      if (this.db) {
        this.db.data = { ...this.currentConfig };
        await this.db.write();
      }
    });
    return this.writeQueue;
  }

  async destroy(): Promise<void> {
    ConfigManager.instancePromise = null;
    this.db = null;
  }

  private ensureDefaults(): void {
    const cfg = this.currentConfig;

    if (!cfg.configs || typeof cfg.configs !== "object") {
      cfg.configs = {};
    } else {
      for (const provider of Object.values(cfg.configs)) {
        provider.type = normalizeProviderType(provider.type);
        if (typeof provider.stream !== "boolean") provider.stream = false;
        if (typeof provider.responses !== "boolean") provider.responses = false;
      }
    }

    if (!cfg.currentSearchTag && cfg.currentChatTag)
      cfg.currentSearchTag = cfg.currentChatTag;
    if (!cfg.currentSearchModel && cfg.currentChatModel)
      cfg.currentSearchModel = cfg.currentChatModel;
    if (!cfg.currentImageTag && cfg.currentChatTag)
      cfg.currentImageTag = cfg.currentChatTag;
    if (!cfg.currentImageModel && cfg.currentChatModel)
      cfg.currentImageModel = cfg.currentChatModel;
    if (!cfg.currentVideoTag && cfg.currentChatTag)
      cfg.currentVideoTag = cfg.currentChatTag;
    if (!cfg.currentVideoModel && cfg.currentChatModel)
      cfg.currentVideoModel = cfg.currentChatModel;

    if (typeof cfg.imagePreview !== "boolean") cfg.imagePreview = true;
    if (typeof cfg.imageSaveToFavorites !== "boolean") cfg.imageSaveToFavorites = false;
    if (typeof cfg.promptOptimize !== "boolean") cfg.promptOptimize = true;
    if (typeof cfg.videoPromptOptimize !== "boolean") cfg.videoPromptOptimize = true;
    if (!["short", "medium", "long"].includes(String(cfg.promptLength || ""))) cfg.promptLength = "short";
    if (!["short", "medium", "long"].includes(String(cfg.videoPromptLength || ""))) cfg.videoPromptLength = "short";
    if (typeof cfg.videoPreview !== "boolean") cfg.videoPreview = true;
    if (typeof cfg.videoSaveToFavorites !== "boolean") cfg.videoSaveToFavorites = false;
    if (typeof cfg.videoAudio !== "boolean") cfg.videoAudio = false;
    if (
      typeof cfg.videoDuration !== "number" ||
      !Number.isFinite(cfg.videoDuration)
    )
      cfg.videoDuration = 5;
    if (cfg.videoDuration < 5 || cfg.videoDuration > 20) cfg.videoDuration = 5;
    if (typeof cfg.collapse !== "boolean") cfg.collapse = true;
    if (
      typeof cfg.timeout !== "number" ||
      !Number.isFinite(cfg.timeout) ||
      cfg.timeout <= 0
    ) {
      cfg.timeout = 30;
    }

    if (!cfg.telegraph || typeof cfg.telegraph !== "object") {
      cfg.telegraph = { enabled: false, limit: 5, list: [] };
    } else {
      if (typeof cfg.telegraph.enabled !== "boolean")
        cfg.telegraph.enabled = false;
      if (typeof cfg.telegraph.limit !== "number" || cfg.telegraph.limit <= 0)
        cfg.telegraph.limit = 5;
      if (!Array.isArray(cfg.telegraph.list)) {
        cfg.telegraph.list = [];
      } else {
        cfg.telegraph.list = cfg.telegraph.list.filter(
          (item): item is TelegraphItem =>
            !!item &&
            typeof item.url === "string" &&
            typeof item.title === "string" &&
            typeof item.createdAt === "string",
        );
      }
    }
  }

}

const resolveAuthMode = (
  profile: ProviderProfile,
  modeConfig: ProviderModeConfig,
  config?: ProviderConfig,
): AuthMode => {
  if (modeConfig.authMode) return modeConfig.authMode;
  if (profile.authMode) return profile.authMode;
  if (config && resolveProviderType(config) === "gemini") return "query-key";
  return "bearer";
};

const applyAuthConfig = (
  authMode: AuthMode,
  config: ProviderConfig,
  url: string,
  headers: Record<string, string>,
): { url: string; headers: Record<string, string> } => {
  if (authMode === "query-key") {
    try {
      const u = new URL(url);
      if (!u.searchParams.has("key")) u.searchParams.set("key", config.key);
      return { url: u.toString(), headers };
    } catch {
      return { url, headers };
    }
  }
  return {
    url,
    headers: {
      ...headers,
      Authorization: `Bearer ${config.key}`,
    },
  };
};

const normalizeOpenAIBaseUrl = (url: string): string => {
  try {
    const u = new URL(url);

    if (u.hostname.includes("gateway.ai.cloudflare.com")) {
      const openAiIndex = u.pathname.indexOf("/openai");
      if (openAiIndex >= 0) {
        u.pathname = u.pathname.slice(0, openAiIndex + "/openai".length);
      }
      u.search = "";
      return u.toString();
    }

    const stripSuffixes = [
      "/chat/completions",
      "/completions",
      "/responses",
      "/messages",
      "/images/generations",
    ];
    for (const s of stripSuffixes) {
      if (u.pathname.endsWith(s)) {
        u.pathname = u.pathname.slice(0, -s.length);
        break;
      }
    }

    const apiV1Index = u.pathname.indexOf("/api/v1");
    if (apiV1Index >= 0) {
      u.pathname = u.pathname.slice(0, apiV1Index + "/api/v1".length);
      u.search = "";
      return u.toString();
    }

    const v1Index = u.pathname.indexOf("/v1");
    if (v1Index >= 0) {
      u.pathname = u.pathname.slice(0, v1Index + "/v1".length);
      u.search = "";
      return u.toString();
    }

    u.pathname = "/v1";
    u.search = "";
    return u.toString();
  } catch {
    return url;
  }
};

const normalizeGeminiBaseUrl = (url: string): string => {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/\/+$/, "");
    if (u.pathname === "" || u.pathname === "/") {
      u.pathname = "/v1beta";
    }
    if (!u.pathname.startsWith("/v1beta")) {
      u.pathname = "/v1beta";
    }
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
};

const parseOpenAIChatResponse = (
  data: any,
): { text: string; images: AIImage[] } => {
  const parseContent = (content: any): { text: string; images: AIImage[] } => {
    if (typeof content === "string") {
      return { text: content || "AI 回复为空", images: [] };
    }

    const parts = Array.isArray(content)
      ? content
      : content && typeof content === "object"
        ? [content]
        : [];

    if (parts.length === 0) return { text: "AI 回复为空", images: [] };

    const textSegments: string[] = [];
    const images: AIImage[] = [];
    for (const part of parts) {
      if (
        (part.type === "text" || part.type === "output_text") &&
        typeof part.text === "string"
      ) {
        textSegments.push(part.text);
      }
      if (part.type === "image_url" && part.image_url?.url) {
        const dataUrl = parseDataUrl(part.image_url.url);
        if (dataUrl)
          images.push({ data: dataUrl.data, mimeType: dataUrl.mimeType });
        else images.push({ url: part.image_url.url, mimeType: "image/jpeg" });
      }
    }

    return {
      text: textSegments.join("\n").trim() || "AI 回复为空",
      images,
    };
  };

  const message = data?.choices?.[0]?.message;
  if (!message) return { text: "AI 回复为空", images: [] };
  return parseContent(message.content);
};

const parseOpenAIStyleImageResponse = (data: any): AIImage[] => {
  const images: AIImage[] = [];
  const list = data?.data || [];
  for (const item of list) {
    if (item?.b64_json) {
      images.push({
        data: Buffer.from(item.b64_json, "base64"),
        mimeType: "image/png",
      });
    } else if (item?.url) {
      images.push({ url: item.url, mimeType: "image/png" });
    }
  }
  return images;
};

const isAsyncIterable = (value: any): value is AsyncIterable<any> =>
  !!value && typeof value[Symbol.asyncIterator] === "function";

const readResponseBodyAsText = async (data: any): Promise<string> => {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf8");
  if (!isAsyncIterable(data)) return "";

  let body = "";
  for await (const chunk of data) {
    if (typeof chunk === "string") {
      body += chunk;
    } else if (Buffer.isBuffer(chunk)) {
      body += chunk.toString("utf8");
    } else if (chunk instanceof Uint8Array) {
      body += Buffer.from(chunk).toString("utf8");
    } else if (chunk !== undefined && chunk !== null) {
      body += String(chunk);
    }
  }

  return body;
};

const collectOpenAISources = (
  data: any,
): Array<{ url: string; title?: string }> => {
  const sources: Array<{ url: string; title?: string }> = [];
  const seen = new Set<string>();

  const appendEntries = (entries: any[] | undefined, isAnnotation = false) => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const url = isAnnotation
        ? entry?.url_citation?.url || entry?.url
        : entry?.url;
      const title = isAnnotation
        ? entry?.url_citation?.title || entry?.title
        : entry?.title;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sources.push({ url, title });
    }
  };

  const choice = data?.choices?.[0];

  appendEntries(data?.citations);
  appendEntries(choice?.citations);
  appendEntries(choice?.message?.citations);
  appendEntries(choice?.delta?.citations);

  appendEntries(
    (data?.annotations || []).filter(
      (entry: any) => entry?.type === "url_citation" || entry?.url_citation,
    ),
    true,
  );
  appendEntries(
    (choice?.message?.annotations || []).filter(
      (entry: any) => entry?.type === "url_citation" || entry?.url_citation,
    ),
    true,
  );
  appendEntries(
    (choice?.delta?.annotations || []).filter(
      (entry: any) => entry?.type === "url_citation" || entry?.url_citation,
    ),
    true,
  );

  return sources;
};

const aggregateOpenAIResponses = (
  payloads: any[],
): {
  text: string;
  images: AIImage[];
  sources: Array<{ url: string; title?: string }>;
} => {
  const deltaTexts: string[] = [];
  const deltaImages: AIImage[] = [];
  let fallbackText = "";
  let fallbackImages: AIImage[] = [];
  const sources: Array<{ url: string; title?: string }> = [];
  const seenSources = new Set<string>();

  const appendSources = (entries: Array<{ url: string; title?: string }>) => {
    for (const entry of entries) {
      if (seenSources.has(entry.url)) continue;
      seenSources.add(entry.url);
      sources.push(entry);
    }
  };

  for (const payload of payloads) {
    const choice = payload?.choices?.[0];

    if (choice?.delta?.content !== undefined) {
      const parsedDelta = parseOpenAIChatResponse({
        choices: [{ message: { content: choice.delta.content } }],
      });
      if (parsedDelta.text && parsedDelta.text !== "AI 回复为空") {
        deltaTexts.push(parsedDelta.text);
      }
      if (parsedDelta.images.length > 0) {
        deltaImages.push(...parsedDelta.images);
      }
    }

    const fallbackContent =
      choice?.message?.content ?? choice?.content ?? payload?.content;
    if (fallbackContent !== undefined) {
      const parsedFallback = parseOpenAIChatResponse({
        choices: [{ message: { content: fallbackContent } }],
      });
      if (parsedFallback.text && parsedFallback.text !== "AI 回复为空") {
        fallbackText = parsedFallback.text;
      }
      if (parsedFallback.images.length > 0) {
        fallbackImages = parsedFallback.images;
      }
    } else if (typeof choice?.text === "string" && choice.text.trim()) {
      fallbackText = choice.text.trim();
      fallbackImages = [];
    } else if (typeof payload?.text === "string" && payload.text.trim()) {
      fallbackText = payload.text.trim();
      fallbackImages = [];
    }

    appendSources(collectOpenAISources(payload));
  }

  const text =
    (deltaTexts.length > 0
      ? deltaTexts.join("").trim()
      : fallbackText.trim()) || "AI 回复为空";
  const images = deltaImages.length > 0 ? deltaImages : fallbackImages;

  return { text, images, sources };
};

const collectResponsesSources = (
  item: any,
): Array<{ url: string; title?: string }> => {
  const sources: Array<{ url: string; title?: string }> = [];
  const seen = new Set<string>();

  const appendSource = (url?: string, title?: string) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    sources.push({ url, title });
  };

  const appendAnnotations = (annotations: any[] | undefined) => {
    if (!Array.isArray(annotations)) return;
    for (const entry of annotations) {
      if (entry?.type !== "url_citation") continue;
      appendSource(entry?.url, entry?.title);
    }
  };

  const appendActionSources = (action: any) => {
    const sourceList = Array.isArray(action?.sources)
      ? action.sources
      : Array.isArray(action)
        ? action
        : [];
    for (const entry of sourceList) {
      if (typeof entry?.url !== "string") continue;
      appendSource(entry.url, entry.title);
    }
  };

  if (item?.type === "message") {
    for (const part of item.content || []) {
      appendAnnotations(part?.annotations);
    }
  }

  if (item?.type === "web_search_call") {
    if (Array.isArray(item?.action)) {
      for (const action of item.action) appendActionSources(action);
    } else {
      appendActionSources(item?.action);
    }
  }

  return sources;
};

const parseResponsesOutputContent = (
  item: any,
): {
  text: string;
  images: AIImage[];
  sources: Array<{ url: string; title?: string }>;
} => {
  const textSegments: string[] = [];
  const images: AIImage[] = [];
  const sources = collectResponsesSources(item);

  if (item?.type !== "message") {
    return { text: "", images, sources };
  }

  for (const part of item.content || []) {
    if (part?.type === "output_text" && typeof part.text === "string") {
      textSegments.push(part.text);
      continue;
    }
    if (part?.type === "image_url" && part.image_url?.url) {
      const dataUrl = parseDataUrl(part.image_url.url);
      if (dataUrl) {
        images.push({ data: dataUrl.data, mimeType: dataUrl.mimeType });
      } else {
        images.push({ url: part.image_url.url, mimeType: "image/jpeg" });
      }
    }
  }

  return {
    text: textSegments.join("\n").trim(),
    images,
    sources,
  };
};

const aggregateResponsesApiPayloads = (
  payloads: any[],
): {
  text: string;
  images: AIImage[];
  sources: Array<{ url: string; title?: string }>;
} => {
  const deltaTexts: string[] = [];
  let fallbackText = "";
  let fallbackImages: AIImage[] = [];
  const sources: Array<{ url: string; title?: string }> = [];
  const seenSources = new Set<string>();

  const appendSources = (entries: Array<{ url: string; title?: string }>) => {
    for (const entry of entries) {
      if (seenSources.has(entry.url)) continue;
      seenSources.add(entry.url);
      sources.push(entry);
    }
  };

  const appendItem = (item: any) => {
    const parsed = parseResponsesOutputContent(item);
    if (parsed.text) fallbackText = parsed.text;
    if (parsed.images.length > 0) fallbackImages = parsed.images;
    appendSources(parsed.sources);
  };

  for (const payload of payloads) {
    if (
      payload?.type === "response.output_text.delta" &&
      typeof payload.delta === "string"
    ) {
      deltaTexts.push(payload.delta);
    }

    if (
      payload?.type === "response.output_text.done" &&
      typeof payload.text === "string" &&
      deltaTexts.length === 0
    ) {
      fallbackText = payload.text.trim();
    }

    if (payload?.type === "response.content_part.done") {
      appendSources(
        collectResponsesSources({
          type: "message",
          content: [payload.part],
        }),
      );
    }

    if (payload?.item) appendItem(payload.item);

    const response =
      payload?.response?.object === "response"
        ? payload.response
        : payload?.object === "response"
          ? payload
          : null;
    if (!response?.output || !Array.isArray(response.output)) continue;

    for (const item of response.output) {
      appendItem(item);
    }
  }

  return {
    text:
      (deltaTexts.length > 0
        ? deltaTexts.join("").trim()
        : fallbackText.trim()) || "AI 回复为空",
    images: fallbackImages,
    sources,
  };
};

const parseOpenAIResponsePayloads = (raw: string): any[] => {
  const payloads: any[] = [];
  let sawDataLine = false;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    sawDataLine = true;

    const body = trimmed.slice(5).trim();
    if (!body || body === "[DONE]") continue;

    try {
      payloads.push(JSON.parse(body));
    } catch {}
  }

  if (payloads.length > 0 || sawDataLine) return payloads;

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
};

const parseOpenAIResponseData = async (
  data: any,
): Promise<{
  text: string;
  images: AIImage[];
  sources: Array<{ url: string; title?: string }>;
}> => {
  if (
    data &&
    typeof data === "object" &&
    !Buffer.isBuffer(data) &&
    !(data instanceof Uint8Array) &&
    !isAsyncIterable(data)
  ) {
    if (data?.object === "response") {
      return aggregateResponsesApiPayloads([data]);
    }
    return aggregateOpenAIResponses([data]);
  }

  const raw = await readResponseBodyAsText(data);
  const payloads = parseOpenAIResponsePayloads(raw);
  if (payloads.length > 0) {
    const hasResponsesPayload = payloads.some(
      (payload) =>
        payload?.object === "response" ||
        payload?.response?.object === "response" ||
        (typeof payload?.type === "string" &&
          payload.type.startsWith("response.")),
    );
    return hasResponsesPayload
      ? aggregateResponsesApiPayloads(payloads)
      : aggregateOpenAIResponses(payloads);
  }

  return { text: raw.trim() || "AI 回复为空", images: [], sources: [] };
};

const buildDoubaoVideoUrl = (data: any): string | null => {
  return (
    data?.data?.result?.video_url ||
    data?.data?.output?.video_url ||
    data?.data?.video_url ||
    data?.video_url ||
    data?.content?.video_url ||
    data?.data?.content?.video_url ||
    null
  );
};

const buildGeminiVideoApiUrl = (
  baseUrl: string,
  model: string,
  key: string,
  endpoint?: string,
): string => {
  const urlObj = new URL(baseUrl);
  const finalModel = model || "veo-2.0-generate-001";
  const endpointTemplate = endpoint || "v1beta/models/{model}:generateVideos";
  urlObj.pathname = endpointTemplate
    .replace("{model}", finalModel)
    .replace(/^\/+/, "/");
  urlObj.searchParams.set("key", key);
  return urlObj.toString();
};

const buildGeminiOperationUrl = (
  baseOrigin: string,
  name: string,
  key: string,
): string => {
  const urlObj = new URL(baseOrigin);
  const cleanName = name.replace(/^\/+/, "");
  const path = cleanName.startsWith("v1beta/")
    ? cleanName
    : `v1beta/${cleanName}`;
  urlObj.pathname = `/${path}`;
  urlObj.searchParams.set("key", key);
  return urlObj.toString();
};

const extractGeminiOperationError = (data: any): string => {
  const err = data?.error || data?.data?.error;
  if (!err) return "";
  if (typeof err === "string") return err;
  if (typeof err.message === "string") return err.message;
  if (typeof err.status === "string") return err.status;
  if (Array.isArray(err.details) && err.details.length > 0) {
    const detail = err.details[0];
    if (typeof detail?.message === "string") return detail.message;
  }
  return "视频生成失败";
};

const extractGeminiVideoResult = (
  data: any,
): { uri?: string; bytes?: string } | null => {
  const response = data?.response ?? data?.data?.response ?? data;
  const sampleUri =
    response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
    response?.generate_video_response?.generated_samples?.[0]?.video?.uri;
  if (sampleUri) return { uri: sampleUri };

  const videoBytes =
    response?.generatedVideos?.[0]?.video?.videoBytes ||
    response?.generated_videos?.[0]?.video?.video_bytes ||
    response?.generatedVideos?.[0]?.video?.video_bytes ||
    response?.generated_videos?.[0]?.video?.videoBytes;
  if (videoBytes) return { bytes: videoBytes };

  return null;
};

const buildGeminiParts = async (
  prompt: string,
  images: AIContentPart[],
  httpClient: HttpClient,
  token?: AbortToken,
): Promise<Array<Record<string, any>>> => {
  const parts: Array<Record<string, any>> = [];
  if (prompt.trim()) parts.push({ text: prompt });

  const resolvedImages = await resolveImageInputs(images, httpClient, token, {
    allowFailures: true,
  });
  for (const image of resolvedImages) {
    parts.push({
      inlineData: {
        data: image.data.toString("base64"),
        mimeType: image.mimeType,
      },
    });
  }

  return parts;
};

class FeatureRegistry {
  private features = new Map<string, FeatureHandler>();

  register(handler: FeatureHandler): void {
    this.features.set(handler.command.toLowerCase(), handler);
  }

  getHandler(command: string): FeatureHandler | undefined {
    return this.features.get(command.toLowerCase());
  }
}

class HttpClient {
  private axiosInstance: AxiosInstance;
  private httpAgent: http.Agent;
  private httpsAgent: https.Agent;

  constructor(
    private readonly configManagerPromise: Promise<ConfigManager>,
  ) {
    this.httpAgent = new http.Agent({ keepAlive: true });
    this.httpsAgent = new https.Agent({ keepAlive: true });
    this.axiosInstance = axios.create({
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
    });
  }

  destroy(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  async request<T = any>(
    requestConfig: AxiosRequestConfig,
    token?: AbortToken,
  ): Promise<AxiosResponse<T>> {
    const timeoutMs =
      (await this.configManagerPromise).getConfig().timeout * 1000;
    const requestToken = createAbortToken();
    const abortFromExternal = () =>
      requestToken.abort(token?.reason || "操作已取消");

    if (token?.aborted) abortFromExternal();
    else
      token?.signal.addEventListener("abort", abortFromExternal, {
        once: true,
      });

    const timeoutId = setTimeout(
      () => requestToken.abort(`请求超时: ${timeoutMs}ms`),
      timeoutMs,
    );
    try {
      return await this.axiosInstance({
        ...requestConfig,
        signal: requestToken.signal,
      });
    } finally {
      clearTimeout(timeoutId);
      token?.signal.removeEventListener("abort", abortFromExternal);
    }
  }
}

class AIService {
  private activeTokens: Set<AbortToken> = new Set();
  private strategyHandlers: Record<ProviderStrategy, StrategyHandler>;

  constructor(
    private readonly configManagerPromise: Promise<ConfigManager>,
    private readonly httpClient: HttpClient,
  ) {
    this.strategyHandlers = this.createStrategyHandlers();
  }

  private async getCurrentProviderConfig(
    type: ProviderMode,
  ): Promise<{ providerConfig: ProviderConfig; model: string; config: DB }> {
    const configManager = await this.configManagerPromise;
    const config = configManager.getConfig();
    const { tagKey, modelKey } = MODE_META[type];
    const tag = config[tagKey];
    const model = config[modelKey];

    if (!tag || !model || !config.configs[tag]) {
      throw new UserError("请先配置 API 并设置模型");
    }

    return { providerConfig: config.configs[tag], model, config };
  }

  private resolveMode(
    providerConfig: ProviderConfig,
    mode: ProviderMode,
    model: string,
  ): { profile: ProviderProfile; modeConfig: ProviderModeConfig } {
    const profile = getProviderProfile(providerConfig);
    const modeConfig = resolveModeConfig(profile, mode, model);
    if (!modeConfig) {
      throw new UserError(`当前 ${profile.id} 提供商不支持 ${mode} 模式`);
    }
    return { profile, modeConfig };
  }

  private applyImageDefaults(
    request: Record<string, any>,
    providerConfig: ProviderConfig,
    model: string,
    modeConfig: ProviderModeConfig,
  ): void {
    if (modeConfig.imageDefaults?.size)
      request.size = modeConfig.imageDefaults.size;
    if (modeConfig.imageDefaults?.quality)
      request.quality = modeConfig.imageDefaults.quality;
    if (modeConfig.imageDefaults?.responseFormat) {
      request.responseFormat = modeConfig.imageDefaults.responseFormat;
      request.response_format = modeConfig.imageDefaults.responseFormat;
    }
    if (modeConfig.imageDefaults?.extraParams)
      Object.assign(request, modeConfig.imageDefaults.extraParams);

    if (isOpenAIProviderType(resolveProviderType(providerConfig))) {
      if (!model.startsWith("gpt-") && !model.includes("chatgpt-image")) {
        request.responseFormat = "b64_json";
        request.response_format = "b64_json";
      }
      if (!request.size) request.size = "auto";
      if (model.startsWith("dall-e-3")) {
        request.quality = "hd";
      } else if (model.startsWith("gpt-image")) {
        request.quality = "high";
      }
    }
  }

  private applyVideoDefaults(
    request: Record<string, any>,
    modeConfig: ProviderModeConfig,
  ): void {
    if (modeConfig.videoDefaults?.responseFormat) {
      request.responseFormat = modeConfig.videoDefaults.responseFormat;
      request.response_format = modeConfig.videoDefaults.responseFormat;
    }
    if (modeConfig.videoDefaults?.extraParams)
      Object.assign(request, modeConfig.videoDefaults.extraParams);
  }

  private createStrategyHandlers(): Record<ProviderStrategy, StrategyHandler> {
    return {
      "openai-rest": {
        chat: async (ctx) =>
          this.callOpenAIChatOrSearch(
            ctx.providerConfig,
            ctx.model,
            ctx.question,
            ctx.images,
            ctx.modeConfig,
            ctx.config.prompt || "",
            ctx.token,
          ),
        search: async (ctx) =>
          this.callOpenAIChatOrSearch(
            ctx.providerConfig,
            ctx.model,
            ctx.question,
            ctx.images,
            ctx.modeConfig,
            ctx.config.prompt || "",
            ctx.token,
            true,
          ),
        image: async (ctx) =>
          this.generateImageWithOpenAIRest(
            ctx.providerConfig,
            ctx.model,
            ctx.prompt,
            ctx.image,
            ctx.modeConfig,
            ctx.token,
          ),
        video: async (ctx) =>
          this.generateVideoWithOpenAIRest(
            ctx.providerConfig,
            ctx.model,
            ctx.prompt,
            ctx.images,
            ctx.modeConfig,
            ctx.token,
          ),
      },
      "gemini-rest": {
        chat: async (ctx) =>
          this.callGeminiChatOrSearch(
            ctx.providerConfig,
            ctx.model,
            ctx.question,
            ctx.images,
            ctx.modeConfig,
            ctx.config.prompt || "",
            ctx.token,
          ),
        search: async (ctx) =>
          this.callGeminiChatOrSearch(
            ctx.providerConfig,
            ctx.model,
            ctx.question,
            ctx.images,
            ctx.modeConfig,
            ctx.config.prompt || "",
            ctx.token,
            true,
          ),
        image: async (ctx) =>
          this.generateGeminiImageRest(
            ctx.providerConfig,
            ctx.model,
            ctx.prompt,
            ctx.modeConfig,
            ctx.image,
            ctx.token,
          ),
      },
      "doubao-rest": {
        image: async (ctx) =>
          this.generateImageWithDoubao(
            ctx.providerConfig,
            ctx.model,
            ctx.prompt,
            ctx.image,
            ctx.modeConfig,
            ctx.token,
          ),
        video: async (ctx) =>
          this.generateVideoWithDoubao(
            ctx.providerConfig,
            ctx.model,
            ctx.prompt,
            ctx.images,
            ctx.imageMode,
            ctx.config.videoAudio,
            ctx.config.videoDuration,
            ctx.modeConfig,
            ctx.token,
          ),
      },
      "gemini-image-rest": {
        image: async (ctx) =>
          this.generateGeminiImageRest(
            ctx.providerConfig,
            ctx.model,
            ctx.prompt,
            ctx.modeConfig,
            ctx.image,
            ctx.token,
          ),
      },
      "gemini-video-rest": {
        video: async (ctx) =>
          this.generateGeminiVideo(
            ctx.providerConfig,
            ctx.model,
            ctx.prompt,
            ctx.images,
            ctx.config.videoAudio,
            ctx.config.videoDuration,
            ctx.modeConfig,
            ctx.token,
          ),
      },
    };
  }

  private async callOpenAIChatOrSearch(
    providerConfig: ProviderConfig,
    model: string,
    question: string,
    images: AIContentPart[],
    modeConfig: ProviderModeConfig,
    systemPrompt: string,
    token?: AbortToken,
    isSearch = false,
  ): Promise<{
    text: string;
    sources: Array<{ url: string; title?: string }>;
    images: AIImage[];
  }> {
    const url = providerConfig.responses
      ? resolveResponsesEndpointUrl(providerConfig, modeConfig)
      : resolveEndpointUrl(
          resolveBaseUrl(providerConfig, modeConfig),
          modeConfig.endpoint || "chat/completions",
        );
    const authMode = resolveAuthMode(
      getProviderProfile(providerConfig),
      modeConfig,
      providerConfig,
    );

    const imageUrlPolicy = modeConfig.imageUrlPolicy ?? "any";
    const safeImages =
      imageUrlPolicy === "data-only"
        ? images.filter(
            (part) =>
              part.type === "image_url" && !!parseDataUrl(part.image_url.url),
          )
        : images;

    const authConfig = applyAuthConfig(authMode, providerConfig, url, {
      "Content-Type": "application/json",
    });

    const sys = (systemPrompt || "").trim();
    let data: any;

    if (providerConfig.responses) {
      const inputContent = buildResponsesInputContent(question, safeImages);
      data = {
        model,
        input:
          inputContent.length > 0
            ? [{ role: "user", content: inputContent }]
            : question,
        stream: providerConfig.stream,
      };
      if (sys) data.instructions = sys;
      if (isSearch) {
        data.tools = [{ type: "web_search" }];
        data.include = ["web_search_call.action.sources"];
      }
    } else {
      const messages: any[] = [];
      if (sys) messages.push({ role: "system", content: sys });

      let userContent: any = [];
      if (question.trim())
        userContent.push({ type: "text", text: question.trim() });

      for (const img of safeImages) {
        if (img.type === "image_url") {
          userContent.push(img);
        }
      }

      if (userContent.length === 0) userContent = question;
      else if (userContent.length === 1 && userContent[0].type === "text")
        userContent = userContent[0].text;

      messages.push({
        role: "user",
        content: userContent,
      });

      data = {
        model,
        messages,
        stream: providerConfig.stream,
      };

      if (isSearch) {
        data.tools = [
          {
            type: "web_search",
            web_search: {
              searchContextSize: "high",
            },
          },
        ];
        data.web_search_options = { search_context_size: "high" };
      }
    }

    const response = await this.httpClient.request(
      {
        url: authConfig.url,
        method: "POST",
        headers: authConfig.headers,
        data,
        ...(providerConfig.stream ? { responseType: "stream" } : {}),
      },
      token,
    );

    const parsed = await parseOpenAIResponseData(response.data);
    return {
      text: parsed.text,
      images: parsed.images,
      sources: isSearch ? parsed.sources : [],
    };
  }

  private async callGeminiChatOrSearch(
    providerConfig: ProviderConfig,
    model: string,
    question: string,
    images: AIContentPart[],
    modeConfig: ProviderModeConfig,
    systemPrompt: string,
    token?: AbortToken,
    isSearch = false,
  ): Promise<{
    text: string;
    sources: Array<{ url: string; title?: string }>;
    images: AIImage[];
  }> {
    const baseUrl = resolveBaseUrl(providerConfig, modeConfig);
    const endpoint = (
      modeConfig.endpoint || "models/{model}:generateContent"
    ).replace("{model}", model);
    const url = resolveEndpointUrl(baseUrl, endpoint);

    const authMode = resolveAuthMode(
      getProviderProfile(providerConfig),
      modeConfig,
      providerConfig,
    );
    const authConfig = applyAuthConfig(authMode, providerConfig, url, {
      "Content-Type": "application/json",
    });

    const parts = await buildGeminiParts(
      question,
      images,
      this.httpClient,
      token,
    );

    const data: any = {
      contents: [{ role: "user", parts }],
    };

    if (systemPrompt?.trim()) {
      data.systemInstruction = {
        role: "system",
        parts: [{ text: systemPrompt.trim() }],
      };
    }

    if (isSearch) {
      data.tools = [{ googleSearch: {} }];
    }

    const response = await this.httpClient.request(
      {
        url: authConfig.url,
        method: "POST",
        headers: authConfig.headers,
        data,
      },
      token,
    );

    const root =
      response.data?.response ?? response.data?.data ?? response.data;
    const candidate = root?.candidates?.[0];
    const cparts = candidate?.content?.parts ?? [];

    let text = "";
    let extractedImages: AIImage[] = [];

    for (const p of cparts) {
      if (p.text) text += p.text;
      const inline = p.inlineData || p.inline_data;
      if (inline?.data) {
        extractedImages.push({
          data: Buffer.from(inline.data, "base64"),
          mimeType: inline.mimeType || inline.mime_type || "image/png",
        });
      }
    }

    let sources: Array<{ url: string; title?: string }> = [];
    if (isSearch) {
      const groundingMetadata =
        candidate?.groundingMetadata || candidate?.grounding_metadata;
      const groundingChunks =
        groundingMetadata?.groundingChunks ||
        groundingMetadata?.grounding_chunks ||
        [];
      for (const chunk of groundingChunks) {
        const web = chunk.web || chunk.web_chunk;
        if (web?.uri) {
          sources.push({ url: web.uri, title: web.title });
        }
      }
    }

    return {
      text: text.trim() || "AI 回复为空",
      images: extractedImages,
      sources,
    };
  }

  private async generateImageWithDoubao(
    providerConfig: ProviderConfig,
    model: string,
    prompt: string,
    image: AIImage | undefined,
    modeConfig: ProviderModeConfig,
    token?: AbortToken,
  ): Promise<AIImage[]> {
    const baseUrl = resolveBaseUrl(providerConfig, modeConfig);

    const data: Record<string, any> = {
      prompt,
      model,
    };
    if (image) {
      if (!image.data) throw new Error("无法解析图片数据");
      data.image = `data:${image.mimeType};base64,${image.data.toString("base64")}`;
    }
    if (modeConfig.imageDefaults?.size)
      data.size = modeConfig.imageDefaults.size;
    if (modeConfig.imageDefaults?.responseFormat)
      data.response_format = modeConfig.imageDefaults.responseFormat;
    if (modeConfig.imageDefaults?.extraParams)
      Object.assign(data, modeConfig.imageDefaults.extraParams);

    const endpoint = modeConfig.endpoint || "api/v3/images/generations";
    const authMode = resolveAuthMode(
      getProviderProfile(providerConfig),
      modeConfig,
      providerConfig,
    );
    const authConfig = applyAuthConfig(
      authMode,
      providerConfig,
      resolveEndpointUrl(baseUrl, endpoint),
      {
        "Content-Type": "application/json",
      },
    );
    let response: any;
    try {
      response = await this.httpClient.request(
        {
          url: authConfig.url,
          method: "POST",
          headers: authConfig.headers,
          data,
        },
        token,
      );
    } catch (error: any) {
      const body = error?.response?.data;
      let bodyText = "";
      try {
        bodyText = typeof body === "string" ? body : JSON.stringify(body);
      } catch {
        bodyText = String(body || "");
      }
      console.log("[aix:image:http:error]", JSON.stringify({
        providerTag: providerConfig.tag,
        model,
        endpoint,
        status: error?.response?.status,
        statusText: error?.response?.statusText,
        headers: error?.response?.headers,
        body: bodyText?.slice(0, 4000),
      }));
      throw error;
    }

    try {
      console.log("[aix:image:http:ok]", JSON.stringify({
        providerTag: providerConfig.tag,
        model,
        endpoint,
        status: response?.status,
        body: (typeof response?.data === "string" ? response.data : JSON.stringify(response?.data))?.slice(0, 4000),
      }));
    } catch {}

    return parseOpenAIStyleImageResponse(response.data);
  }

  private async generateImageWithOpenAIRest(
    providerConfig: ProviderConfig,
    model: string,
    prompt: string,
    image: AIImage | undefined,
    modeConfig: ProviderModeConfig,
    token?: AbortToken,
  ): Promise<AIImage[]> {
    const baseUrl = resolveBaseUrl(providerConfig, modeConfig);
    let endpoint = modeConfig.endpoint || "images/generations";
    const authMode = resolveAuthMode(
      getProviderProfile(providerConfig),
      modeConfig,
      providerConfig,
    );

    const requestModel = model;

    let data: any;
    let headers: Record<string, string> = {};

    if (image && image.data) {
      endpoint = modeConfig.endpoint || "images/edits";
      const fields: Record<string, any> = {
        model: requestModel,
        prompt,
      };
      this.applyImageDefaults(
        fields,
        providerConfig,
        requestModel,
        modeConfig,
      );

      const boundary =
        "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
      const chunks: Buffer[] = [];

      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined && value !== null) {
          chunks.push(Buffer.from(`--${boundary}\r\n`));
          chunks.push(
            Buffer.from(
              `Content-Disposition: form-data; name="${key}"\r\n\r\n`,
            ),
          );
          chunks.push(Buffer.from(`${value}\r\n`));
        }
      }

      chunks.push(Buffer.from(`--${boundary}\r\n`));
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="image"; filename="image.png"\r\n`,
        ),
      );
      chunks.push(
        Buffer.from(`Content-Type: ${image.mimeType || "image/png"}\r\n\r\n`),
      );
      chunks.push(image.data);
      chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

      data = Buffer.concat(chunks);
      headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
    } else {
      endpoint = modeConfig.endpoint || "images/generations";
      data = {
        model: requestModel,
        prompt,
      };
      this.applyImageDefaults(data, providerConfig, requestModel, modeConfig);
      headers["Content-Type"] = "application/json";
    }

    const authConfig = applyAuthConfig(
      authMode,
      providerConfig,
      resolveEndpointUrl(baseUrl, endpoint),
      headers,
    );

    const response = await this.httpClient.request(
      {
        url: authConfig.url,
        method: "POST",
        headers: authConfig.headers,
        data,
      },
      token,
    );

    return parseOpenAIStyleImageResponse(response.data);
  }

  private async generateVideoWithOpenAIRest(
    providerConfig: ProviderConfig,
    model: string,
    prompt: string,
    images: AIContentPart[],
    modeConfig: ProviderModeConfig,
    token?: AbortToken,
  ): Promise<AIVideo[]> {
    const baseUrl = resolveBaseUrl(providerConfig, modeConfig);
    const url = resolveEndpointUrl(
      baseUrl,
      modeConfig.endpoint || "chat/completions",
    );
    const authMode = resolveAuthMode(
      getProviderProfile(providerConfig),
      modeConfig,
      providerConfig,
    );

    const authConfig = applyAuthConfig(authMode, providerConfig, url, {
      "Content-Type": "application/json",
    });

    const content: any[] = [];
    if (prompt.trim()) {
      content.push({ type: "text", text: prompt.trim() });
    }

    const safeImages = images.filter(
      (part) => part.type === "image_url" && !!parseDataUrl(part.image_url.url),
    );
    for (const img of safeImages) {
      content.push(img);
    }

    let userContent: any = content;
    if (content.length === 1 && content[0].type === "text") {
      userContent = content[0].text;
    } else if (content.length === 0) {
      userContent = prompt || "Generate a video";
    }

    const data: any = {
      model,
      messages: [{ role: "user", content: userContent }],
      stream: providerConfig.stream,
    };

    const response = await this.httpClient.request(
      {
        url: authConfig.url,
        method: "POST",
        headers: authConfig.headers,
        data,
        ...(providerConfig.stream ? { responseType: "stream" } : {}),
      },
      token,
    );

    const parsed = await parseOpenAIResponseData(response.data);
    const replyText = parsed.text;

    if (!replyText) {
      throw new Error("视频生成失败，AI 返回为空");
    }

    const match = replyText.match(/(https?:\/\/[^\s"'>]+\.(?:mp4|webm))/i);
    if (match && match[1]) {
      const isWebm = match[1].toLowerCase().endsWith(".webm");
      return [{ url: match[1], mimeType: isWebm ? "video/webm" : "video/mp4" }];
    }

    throw new Error(`未能从返回结果中提取到视频链接。\nAI 返回: ${replyText}`);
  }

  private buildDoubaoVideoContent(
    prompt: string,
    images: AIContentPart[],
    imageMode: VideoImageMode,
  ): Array<Record<string, any>> {
    const content: Array<Record<string, any>> = [];
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt) {
      content.push({ type: "text", text: trimmedPrompt });
    }

    const imageParts = images.filter(
      (part) => part.type === "image_url" && !!parseDataUrl(part.image_url.url),
    );
    const imageCount = imageParts.length;

    for (const [index, part] of imageParts.entries()) {
      if (part.type !== "image_url") continue;
      const item: Record<string, any> = {
        type: "image_url",
        image_url: { url: part.image_url.url },
      };
      if (imageMode === "first") {
        item.role = "first_frame";
      } else if (imageMode === "firstlast") {
        item.role = index === 0 ? "first_frame" : "last_frame";
      } else if (imageMode === "reference") {
        item.role = "reference_image";
      } else if (imageCount === 2) {
        item.role = index === 0 ? "first_frame" : "last_frame";
      } else if (imageCount > 2) {
        item.role = "reference_image";
      }
      content.push(item);
    }

    return content;
  }

  private async generateGeminiImageRest(
    providerConfig: ProviderConfig,
    model: string,
    prompt: string,
    modeConfig: ProviderModeConfig,
    image?: AIImage,
    token?: AbortToken,
  ): Promise<AIImage[]> {
    const baseUrl = resolveBaseUrl(providerConfig, modeConfig);

    if (model.includes("imagen")) {
      const endpoint = `v1beta/models/${model}:predict`;
      const url = resolveEndpointUrl(baseUrl, endpoint);
      const authMode = resolveAuthMode(
        getProviderProfile(providerConfig),
        modeConfig,
        providerConfig,
      );
      const authConfig = applyAuthConfig(authMode, providerConfig, url, {
        "Content-Type": "application/json",
      });

      const data: any = {
        instances: [{ prompt: prompt || "" }],
        parameters: {
          sampleCount: 1,
          outputOptions: { mimeType: "image/png" },
        },
      };

      const response = await this.httpClient.request(
        {
          url: authConfig.url,
          method: "POST",
          headers: authConfig.headers,
          data,
        },
        token,
      );

      const predictions = response.data?.predictions || [];
      const images: AIImage[] = [];
      for (const p of predictions) {
        if (p.bytesBase64Encoded) {
          images.push({
            data: Buffer.from(p.bytesBase64Encoded, "base64"),
            mimeType: p.mimeType || "image/png",
          });
        }
      }
      if (images.length === 0) throw new Error("图片生成失败");
      return images;
    }

    const endpoint = (
      modeConfig.endpoint || "models/{model}:generateContent"
    ).replace("{model}", model);
    const url = resolveEndpointUrl(baseUrl, endpoint);

    const authMode = resolveAuthMode(
      getProviderProfile(providerConfig),
      modeConfig,
      providerConfig,
    );
    const authConfig = applyAuthConfig(authMode, providerConfig, url, {
      "Content-Type": "application/json",
    });

    const parts: any[] = [];
    if (prompt?.trim()) parts.push({ text: prompt.trim() });

    if (image?.data) {
      parts.push({
        inlineData: {
          data: image.data.toString("base64"),
          mimeType: image.mimeType || "image/png",
        },
      });
    }

    const response = await this.httpClient.request(
      {
        url: authConfig.url,
        method: "POST",
        headers: authConfig.headers,
        data: {
          contents: [{ parts }],
        },
      },
      token,
    );

    const root =
      response.data?.response ?? response.data?.data ?? response.data;
    const candidates = root?.candidates ?? [];
    const images: AIImage[] = [];

    for (const c of candidates) {
      const cparts = c?.content?.parts ?? [];
      for (const p of cparts) {
        const inline = p?.inlineData || p?.inline_data;
        if (inline?.data) {
          images.push({
            data: Buffer.from(inline.data, "base64"),
            mimeType: inline.mimeType || inline.mime_type || "image/png",
          });
        }
      }
    }

    if (images.length === 0) {
      throw new Error(
        "未在 candidates[].content.parts[].inlineData 中找到图片数据",
      );
    }

    return images;
  }

  private async generateGeminiVideo(
    providerConfig: ProviderConfig,
    model: string,
    prompt: string,
    images: AIContentPart[],
    videoAudio: boolean,
    videoDuration: number,
    modeConfig: ProviderModeConfig,
    token?: AbortToken,
  ): Promise<AIVideo[]> {
    const baseUrl = resolveBaseUrl(providerConfig, modeConfig);
    const apiUrl = buildGeminiVideoApiUrl(
      baseUrl,
      model,
      providerConfig.key,
      modeConfig.endpoint,
    );
    const parts = await buildGeminiParts(
      prompt,
      images,
      this.httpClient,
      token,
    );

    const response = await this.httpClient.request(
      {
        url: apiUrl,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        data: {
          contents: [
            {
              parts,
            },
          ],
          videoGenerationConfig: {
            numberOfVideos: 1,
            durationSeconds: videoDuration,
            enableAudio: videoAudio,
          },
        },
      },
      token,
    );

    const directResult = extractGeminiVideoResult(response.data);
    if (directResult?.bytes) {
      return [
        {
          data: Buffer.from(directResult.bytes, "base64"),
          mimeType: "video/mp4",
        },
      ];
    }

    if (directResult?.uri) {
      const download = await this.httpClient.request(
        {
          url: directResult.uri,
          method: "GET",
          responseType: "arraybuffer",
        },
        token,
      );
      const contentType = getHeaderContentType(download.headers) || "video/mp4";
      return [{ data: Buffer.from(download.data), mimeType: contentType }];
    }

    const operationName = response.data?.name;
    if (!operationName || typeof operationName !== "string") {
      throw new Error("视频生成失败");
    }

    const baseOrigin = normalizeGeminiBaseUrl(providerConfig.url);
    const operation = await pollTask<any>(
      async (abortToken) => {
        const url = buildGeminiOperationUrl(
          baseOrigin,
          operationName,
          providerConfig.key,
        );
        const opResponse = await this.httpClient.request(
          {
            url,
            method: "GET",
            headers: { "Content-Type": "application/json" },
          },
          abortToken,
        );
        return opResponse.data;
      },
      (data): TaskPollResult<any> => {
        if (!data || data.done !== true) {
          return { status: "pending" };
        }
        if (data.error) {
          return {
            status: "failed",
            errorMessage: extractGeminiOperationError(data),
          };
        }
        return { status: "succeeded", result: data };
      },
      {
        maxAttempts: 303,
        intervalMs: 2000,
      },
      token,
    );

    const finalResult = extractGeminiVideoResult(operation);
    if (finalResult?.bytes) {
      return [
        {
          data: Buffer.from(finalResult.bytes, "base64"),
          mimeType: "video/mp4",
        },
      ];
    }
    if (finalResult?.uri) {
      const download = await this.httpClient.request(
        {
          url: finalResult.uri,
          method: "GET",
          responseType: "arraybuffer",
        },
        token,
      );
      const contentType = getHeaderContentType(download.headers) || "video/mp4";
      return [{ data: Buffer.from(download.data), mimeType: contentType }];
    }

    throw new Error("视频生成失败");
  }

  private async generateVideoWithDoubao(
    providerConfig: ProviderConfig,
    model: string,
    prompt: string,
    images: AIContentPart[],
    imageMode: VideoImageMode,
    videoAudio: boolean,
    videoDuration: number,
    modeConfig: ProviderModeConfig,
    token?: AbortToken,
  ): Promise<AIVideo[]> {
    const baseUrl = resolveBaseUrl(providerConfig, modeConfig);

    const content = this.buildDoubaoVideoContent(prompt, images, imageMode);
    const data: Record<string, any> = {
      model,
      content,
      generateAudio: videoAudio,
      duration: videoDuration,
    };
    this.applyVideoDefaults(data, modeConfig);

    const endpoint = modeConfig.endpoint || "api/v3/contents/generations/tasks";
    const authMode = resolveAuthMode(
      getProviderProfile(providerConfig),
      modeConfig,
      providerConfig,
    );
    const authConfig = applyAuthConfig(
      authMode,
      providerConfig,
      resolveEndpointUrl(baseUrl, endpoint),
      {
        "Content-Type": "application/json",
      },
    );
    const response = await this.httpClient.request(
      {
        url: authConfig.url,
        method: "POST",
        headers: authConfig.headers,
        data,
      },
      token,
    );

    const taskId =
      response.data?.task_id ||
      response.data?.data?.task_id ||
      response.data?.data?.id ||
      response.data?.id;
    if (!taskId) throw new Error("视频生成任务创建失败");

    const videoUrl = await pollTask<string>(
      async (abortToken) => {
        const pollUrl = resolveEndpointUrl(baseUrl, `${endpoint}/${taskId}`);
        const authConfig = applyAuthConfig(
          authMode,
          providerConfig,
          pollUrl,
          {},
        );
        const pollResponse = await this.httpClient.request(
          {
            url: authConfig.url,
            method: "GET",
            headers: authConfig.headers,
          },
          abortToken,
        );
        return pollResponse.data;
      },
      (data): TaskPollResult<string> => {
        const statusRaw = data?.status || data?.data?.status;
        if (statusRaw === "failed") {
          return { status: "failed", errorMessage: "视频生成失败" };
        }

        const url = buildDoubaoVideoUrl(data);
        if (url) {
          return { status: "succeeded", result: url };
        }

        return { status: "pending" };
      },
      {
        maxAttempts: 303,
        intervalMs: 2000,
      },
      token,
    );

    return [{ url: videoUrl, mimeType: "video/mp4" }];
  }

  createAbortToken(): AbortToken {
    const token = createAbortToken();
    this.activeTokens.add(token);
    token.signal.addEventListener(
      "abort",
      () => this.activeTokens.delete(token),
      { once: true },
    );
    return token;
  }

  releaseToken(token: AbortToken): void {
    this.activeTokens.delete(token);
  }

  cancelAllOperations(reason?: string): number {
    const tokens = Array.from(this.activeTokens);
    const activeCount = tokens.filter((token) => !token.aborted).length;
    this.activeTokens.clear();
    for (const token of tokens) {
      if (!token.aborted) token.abort(reason || "操作已取消");
    }
    return activeCount;
  }

  async destroy(): Promise<void> {
    this.cancelAllOperations("操作已取消");
  }

  async callAI(
    question: string,
    images: AIContentPart[] = [],
    token?: AbortToken,
  ): Promise<{ text: string; images: AIImage[] }> {
    const { providerConfig, model, config } =
      await this.getCurrentProviderConfig("chat");
    const { modeConfig } = this.resolveMode(providerConfig, "chat", model);
    const handler = this.strategyHandlers[modeConfig.strategy]?.chat;
    if (!handler) throw new UserError("当前提供商不支持聊天");
    return await handler({
      providerConfig,
      model,
      config,
      modeConfig,
      question,
      images,
      token,
    });
  }

  async callSearch(
    question: string,
    images: AIContentPart[] = [],
    token?: AbortToken,
  ): Promise<{
    text: string;
    sources: Array<{ url: string; title?: string }>;
  }> {
    const { providerConfig, model, config } =
      await this.getCurrentProviderConfig("search");
    const { modeConfig } = this.resolveMode(providerConfig, "search", model);
    const handler = this.strategyHandlers[modeConfig.strategy]?.search;
    if (!handler) throw new UserError("当前提供商不支持搜索模式");
    return await handler({
      providerConfig,
      model,
      config,
      modeConfig,
      question,
      images,
      token,
    });
  }

  async generateImage(prompt: string, token?: AbortToken): Promise<AIImage[]> {
    const { providerConfig, model, config } =
      await this.getCurrentProviderConfig("image");
    const { modeConfig } = this.resolveMode(providerConfig, "image", model);
    const handler = this.strategyHandlers[modeConfig.strategy]?.image;
    if (!handler) throw new UserError("当前提供商不支持图片生成");
    return await handler({
      providerConfig,
      model,
      config,
      modeConfig,
      prompt,
      token,
    });
  }

  async editImage(
    prompt: string,
    image: AIImage,
    token?: AbortToken,
  ): Promise<AIImage[]> {
    const { providerConfig, model, config } =
      await this.getCurrentProviderConfig("image");
    const { modeConfig } = this.resolveMode(providerConfig, "image", model);

    if (!modeConfig.supportsEdit) {
      throw new UserError("当前提供商未启用图片编辑支持");
    }

    if (!image.data) {
      throw new Error("无法解析图片数据");
    }

    const handler = this.strategyHandlers[modeConfig.strategy]?.image;
    if (!handler) throw new UserError("当前提供商不支持图片编辑");
    return await handler({
      providerConfig,
      model,
      config,
      modeConfig,
      prompt,
      image,
      token,
    });
  }

  async generateVideo(
    prompt: string,
    images: AIContentPart[],
    imageMode: VideoImageMode = "auto",
    token?: AbortToken,
  ): Promise<AIVideo[]> {
    const { providerConfig, model, config } =
      await this.getCurrentProviderConfig("video");
    const { modeConfig } = this.resolveMode(providerConfig, "video", model);
    const handler = this.strategyHandlers[modeConfig.strategy]?.video;
    if (!handler) throw new UserError("当前提供商不支持视频生成");
    return await handler({
      providerConfig,
      model,
      config,
      modeConfig,
      prompt,
      images,
      imageMode,
      token,
    });
  }
}

abstract class BaseFeatureHandler implements FeatureHandler {
  abstract readonly command: string;
  abstract execute(msg: Api.Message, args: string[]): Promise<void>;

  constructor(
    protected readonly configManagerPromise: Promise<ConfigManager>,
  ) {}

  protected getConfigManager(): Promise<ConfigManager> {
    return this.configManagerPromise;
  }

  protected async getConfig(): Promise<DB> {
    return (await this.configManagerPromise).getConfig();
  }

  protected async editMessage(msg: Api.Message, text: string): Promise<void> {
    await MessageSender.sendOrEdit(msg, text, { parseMode: "html" });
  }
}

type BooleanSetting = {
  command: string;
  key:
    | "imageSaveToFavorites"
    | "imagePreview"
    | "videoSaveToFavorites"
    | "videoPreview"
    | "videoAudio";
  statusTitle: string;
  successText: string;
};

const handleBooleanSetting = async (
  msg: Api.Message,
  args: string[],
  feature: "image" | "video",
  configManager: ConfigManager,
  config: DB,
  settings: BooleanSetting[],
): Promise<boolean> => {
  const setting = settings.find(
    ({ command }) => command === args[1]?.toLowerCase(),
  );
  if (!setting) return false;

  const usage = buildCommandUsage(
    `aix ${feature} ${setting.command} [on|off]`,
  );
  const state = args[2]?.toLowerCase();
  if (!state) {
    requireUser(args.length === 2, usage);
    await MessageSender.sendOrEdit(
      msg,
      `${setting.statusTitle}\n\n📄 当前状态: ${config[setting.key] ? "开启" : "关闭"}`,
      { parseMode: "html" },
    );
    return true;
  }

  requireUser(args.length === 3, usage);
  requireUser(state === "on" || state === "off", "参数必须是 on 或 off");
  const enabled = state === "on";
  await configManager.updateConfig((cfg) => {
    cfg[setting.key] = enabled;
  });
  await MessageSender.sendOrEdit(
    msg,
    `✅ ${setting.successText}已${enabled ? "开启" : "关闭"}`,
    { parseMode: "html" },
  );
  return true;
};

const handlePromptOptimizationSetting = async (
  msg: Api.Message,
  args: string[],
  feature: "image" | "video",
  configManager: ConfigManager,
  config: DB,
): Promise<boolean> => {
  if (args[1]?.toLowerCase() !== "optimize") return false;

  const isImage = feature === "image";
  const label = isImage ? "图片" : "视频";
  const labels = isImage
    ? IMAGE_PROMPT_LENGTH_LABELS
    : VIDEO_PROMPT_LENGTH_LABELS;
  const enabled = isImage
    ? config.promptOptimize !== false
    : config.videoPromptOptimize !== false;
  const mode = normalizePromptLengthMode(
    isImage ? config.promptLength : config.videoPromptLength,
  );
  const command = parsePromptOptimizationCommand(args, feature);

  if (command.type === "status") {
    await MessageSender.sendOrEdit(
      msg,
      `🧠 <b>${label}提示词优化:</b>\n\n` +
        `状态: ${enabled ? "开启" : "关闭"}\n` +
        `长度: <code>${mode}</code>（${labels[mode]}）`,
      { parseMode: "html" },
    );
  } else if (command.type === "toggle") {
    await configManager.updateConfig((cfg) => {
      if (isImage) cfg.promptOptimize = command.enabled;
      else cfg.videoPromptOptimize = command.enabled;
    });
    await MessageSender.sendOrEdit(
      msg,
      `✅ ${label}提示词优化已${command.enabled ? "开启" : "关闭"}`,
      { parseMode: "html" },
    );
  } else if (command.type === "length-status") {
    await MessageSender.sendOrEdit(
      msg,
      `📏 ${label}优化提示词长度: <code>${mode}</code>（${labels[mode]}）`,
      { parseMode: "html" },
    );
  } else {
    await configManager.updateConfig((cfg) => {
      if (isImage) cfg.promptLength = command.mode;
      else cfg.videoPromptLength = command.mode;
    });
    await MessageSender.sendOrEdit(
      msg,
      `✅ ${label}优化提示词长度已设为 ${command.mode}（${labels[command.mode]}）`,
      { parseMode: "html" },
    );
  }
  return true;
};

class ConfigFeature extends BaseFeatureHandler {
  readonly command = "config";

  async execute(msg: Api.Message, args: string[]): Promise<void> {
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();

    if (
      args.length < 2 ||
      (args.length === 2 && args[1].toLowerCase() === "list")
    ) {
      const list =
        Object.values(config.configs)
          .map(
            (c) =>
              `🏷️ <code>${c.tag}</code> - ${c.url}\n🧩 Type: <code>${formatProviderTypeLabel(c)}</code>\n🌊 Stream: <code>${c.stream ? "on" : "off"}</code>\n🧠 Responses(chat/search): <code>${c.responses ? "on" : "off"}</code>`,
          )
          .join("\n") || "暂无配置";
      await this.editMessage(
        msg,
        `📋 <b>API 配置列表:</b>\n\n⚙️ 配置:\n${list}`,
      );
      return;
    }

    const action = args[1].toLowerCase();
    if (action === "add") {
      requireUser(args.length >= 5, "参数格式错误");
      await this.addConfig(msg, args, configManager);
      return;
    }
    if (action === "del") {
      requireUser(args.length >= 3, "参数格式错误");
      await this.deleteConfig(msg, args, configManager);
      return;
    }
    if (action === "stream" || action === "responses") {
      requireUser(args.length >= 4, "参数不足");
      await this.setProviderBooleanOption(
        msg,
        args,
        configManager,
        action,
      );
      return;
    }
    if (action === "type") {
      requireUser(args.length >= 4, "参数不足");
      await this.setProviderType(msg, args, configManager);
      return;
    }
    throw new UserError("参数格式错误");
  }

  private parseProviderType(value: string): ProviderType {
    const providerType = normalizeProviderType(value);
    requireUser(!!providerType, `type 必须是 ${PROVIDER_TYPE_OPTIONS}`);
    if (!providerType) throw new UserError("无效的 provider type");
    return providerType;
  }

  private parseAddConfigArgs(args: string[]): {
    tag: string;
    url: string;
    key: string;
    type?: ProviderType;
  } {
    const rawArgs = args.slice(2);
    let urlIndex = -1;
    for (let i = rawArgs.length - 2; i >= 1; i--) {
      const trailingCount = rawArgs.length - i - 1;
      if (trailingCount > 2) continue;
      if (!isHttpUrl(rawArgs[i])) continue;
      urlIndex = i;
      break;
    }

    requireUser(urlIndex > 0, "参数格式错误");

    const tag = rawArgs.slice(0, urlIndex).join(" ").trim();
    const url = rawArgs[urlIndex];
    const tail = rawArgs.slice(urlIndex + 1);
    requireUser(
      !!tag && (tail.length === 1 || tail.length === 2),
      "参数格式错误",
    );

    return {
      tag,
      url,
      key: tail[0],
      type: tail[1] ? this.parseProviderType(tail[1]) : undefined,
    };
  }

  private async addConfig(
    msg: Api.Message,
    args: string[],
    configManager: ConfigManager,
  ): Promise<void> {
    requireUser(
      !!(msg as any).savedPeerId,
      "出于安全考虑，禁止在公开场景添加/修改 API 密钥",
    );
    const { tag, url, key, type } = this.parseAddConfigArgs(args);

    requireUser(!!key.trim(), "API 密钥不能为空");
    requireUser(key.length >= 10, "API 密钥长度过短");

    await configManager.updateConfig((cfg) => {
      cfg.configs[tag] = {
        tag,
        url,
        key,
        type,
        stream: false,
        responses: false,
      };
    });

    await this.editMessage(
      msg,
      "✅ API 配置已添加:\n\n" +
        `🏷️ 标签: <code>${tag}</code>\n` +
        `🔗 地址: <code>${url}</code>\n` +
        `🧩 Type: <code>${formatProviderTypeLabel({ url, type })}</code>\n` +
        `🔑 密钥: <code>${key}</code>\n` +
        `🌊 Stream: <code>off</code>\n` +
        `🧠 Responses(chat/search): <code>off</code>`,
    );
  }

  private async setProviderBooleanOption(
    msg: Api.Message,
    args: string[],
    configManager: ConfigManager,
    option: "stream" | "responses",
  ): Promise<void> {
    const state = args[args.length - 1]?.toLowerCase();
    const tag = args.slice(2, -1).join(" ").trim();
    const config = configManager.getConfig();

    requireUser(!!tag, "参数格式错误");
    requireUser(state === "on" || state === "off", "参数必须是 on 或 off");
    requireUser(!!config.configs[tag], "配置不存在");

    const enabled = state === "on";
    await configManager.updateConfig((cfg) => {
      cfg.configs[tag][option] = enabled;
    });

    const settingText =
      option === "stream"
        ? "Stream 设置为"
        : "Responses(chat/search) 模式设置为";
    await this.editMessage(
      msg,
      `✅ 已将配置 <code>${tag}</code> 的 ${settingText} <code>${enabled ? "on" : "off"}</code>`,
    );
  }

  private async setProviderType(
    msg: Api.Message,
    args: string[],
    configManager: ConfigManager,
  ): Promise<void> {
    const type = this.parseProviderType(args[args.length - 1] || "");
    const tag = args.slice(2, -1).join(" ").trim();
    const config = configManager.getConfig();

    requireUser(!!tag, "参数格式错误");
    requireUser(!!config.configs[tag], "配置不存在");

    await configManager.updateConfig((cfg) => {
      cfg.configs[tag].type = type;
    });

    await this.editMessage(
      msg,
      `✅ 已将配置 <code>${tag}</code> 的 Type 设置为 <code>${type}</code>`,
    );
  }

  private async deleteConfig(
    msg: Api.Message,
    args: string[],
    configManager: ConfigManager,
  ): Promise<void> {
    const delTag = args.slice(2).join(" ").trim();
    const config = configManager.getConfig();

    requireUser(!!delTag, "参数格式错误");
    requireUser(!!config.configs[delTag], "配置不存在");

    await configManager.updateConfig((cfg) => {
      delete cfg.configs[delTag];
      for (const { tagKey, modelKey } of Object.values(MODE_META)) {
        if (cfg[tagKey] === delTag) {
          cfg[tagKey] = "";
          cfg[modelKey] = "";
        }
      }
    });

    await this.editMessage(msg, `✅ 已删除配置: ${delTag}`);
  }
}

class ModelFeature extends BaseFeatureHandler {
  readonly command = "model";

  async execute(msg: Api.Message, args: string[]): Promise<void> {
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();

    if (args.length < 2) {
      const details = PROVIDER_MODES.map((mode) => {
        const { tagKey, modelKey, tagIcon, modelIcon } = MODE_META[mode];
        return (
          `${tagIcon} ${mode} 配置: <code>${config[tagKey] || "未设置"}</code>\n` +
          `${modelIcon} ${mode} 模型: <code>${config[modelKey] || "未设置"}</code>`
        );
      }).join("\n");
      await this.editMessage(
        msg,
        `🤖 <b>当前 AI 配置:</b>\n\n${details}`,
      );
      return;
    }

    const mode = args[1]?.toLowerCase() as ProviderMode;
    requireUser(PROVIDER_MODES.includes(mode), "参数格式错误");
    requireUser(args.length >= 4, "参数不足");

    const model = args[args.length - 1];
    const tag = args.slice(2, -1).join(" ").trim();
    requireUser(!!config.configs[tag], `配置标签 "${tag}" 不存在`);

    await configManager.updateConfig((cfg) => {
      const { tagKey, modelKey } = MODE_META[mode];
      cfg[tagKey] = tag;
      cfg[modelKey] = model;
    });

    await this.editMessage(
      msg,
      `✅ ${mode} 模型 已切换到:\n\n🏷️ 配置: <code>${tag}</code>\n🧠 模型: <code>${model}</code>`,
    );
  }
}

class PromptFeature extends BaseFeatureHandler {
  readonly command = "prompt";

  async execute(msg: Api.Message, args: string[]): Promise<void> {
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();

    if (args.length < 2) {
      await this.editMessage(
        msg,
        `💭 <b>当前提示词:</b>\n\n📝 内容: <code>${config.prompt || "未设置"}</code>`,
      );
      return;
    }

    const action = args[1].toLowerCase();
    let nextPrompt: string;
    let confirmation: string;
    if (action === "set") {
      requireUser(args.length >= 3, "参数格式错误");
      nextPrompt = args.slice(2).join(" ");
      confirmation = `✅ 提示词已设置:\n\n<code>${nextPrompt}</code>`;
    } else if (action === "del") {
      requireUser(args.length === 2, buildCommandUsage("aix prompt del"));
      nextPrompt = "";
      confirmation = "✅ 提示词已删除";
    } else {
      throw new UserError("参数格式错误");
    }

    await configManager.updateConfig((cfg) => {
      cfg.prompt = nextPrompt;
    });
    await this.editMessage(msg, confirmation);
  }
}

class CollapseFeature extends BaseFeatureHandler {
  readonly command = "collapse";

  async execute(msg: Api.Message, args: string[]): Promise<void> {
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();

    if (args.length < 2) {
      await this.editMessage(
        msg,
        `📖 <b>消息折叠状态:</b>\n\n📄 当前状态: ${config.collapse ? "开启" : "关闭"}`,
      );
      return;
    }

    const state = args[1].toLowerCase();
    requireUser(
      args.length === 2,
      buildCommandUsage("aix collapse on|off"),
    );
    requireUser(state === "on" || state === "off", "参数必须是 on 或 off");

    await configManager.updateConfig((cfg) => {
      cfg.collapse = state === "on";
    });

    await this.editMessage(
      msg,
      `✅ 引用折叠已${state === "on" ? "开启" : "关闭"}`,
    );
  }
}

class TelegraphFeature extends BaseFeatureHandler {
  readonly command = "telegraph";

  async execute(msg: Api.Message, args: string[]): Promise<void> {
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();

    if (args.length < 2) {
      await this.showTelegraphStatus(msg, config);
      return;
    }

    const action = args[1].toLowerCase();
    if (action === "on" || action === "off") {
      requireUser(
        args.length === 2,
        buildCommandUsage(`aix telegraph ${action}`),
      );
      const enabled = action === "on";
      await configManager.updateConfig((cfg) => {
        cfg.telegraph.enabled = enabled;
      });
      await this.editMessage(
        msg,
        `✅ Telegraph 已${enabled ? "开启" : "关闭"}`,
      );
      return;
    }
    if (action === "limit") {
      requireUser(
        args.length === 3,
        buildCommandUsage("aix telegraph limit <正整数>"),
      );
      await this.setTelegraphLimit(msg, args, configManager);
      return;
    }
    if (action === "del") {
      requireUser(
        args.length === 3,
        buildCommandUsage("aix telegraph del <序号|all>"),
      );
      await this.deleteTelegraphItem(msg, args, configManager);
      return;
    }
    throw new UserError(
      buildCommandUsage(
        "aix telegraph [on|off|limit <正整数>|del <序号|all>]",
      ),
    );
  }

  private async showTelegraphStatus(
    msg: Api.Message,
    config: DB,
  ): Promise<void> {
    const entries = config.telegraph.list
      .map(
        (item, index) =>
          `${index + 1}. <a href="${item.url}">🔗 ${item.title}</a>\n`,
      )
      .join("");
    const status =
      `📰 <b>Telegraph 状态:</b>\n\n` +
      `🌐 当前状态: ${config.telegraph.enabled ? "开启" : "关闭"}\n` +
      `📊 限制数量: <code>${config.telegraph.limit}</code>\n` +
      `📈 记录数量: <code>${config.telegraph.list.length}/${config.telegraph.limit}</code>` +
      (entries ? `\n\n${entries}` : "");

    await this.editMessage(msg, status);
  }

  private async setTelegraphLimit(
    msg: Api.Message,
    args: string[],
    configManager: ConfigManager,
  ): Promise<void> {
    const limit = parseStrictInteger(args[2]);
    requireUser(limit !== null && limit > 0, "限制数量必须是大于 0 的整数");

    await configManager.updateConfig((cfg) => {
      cfg.telegraph.limit = limit!;
    });

    await this.editMessage(msg, `✅ Telegraph 限制已设置为 ${limit!}`);
  }

  private async deleteTelegraphItem(
    msg: Api.Message,
    args: string[],
    configManager: ConfigManager,
  ): Promise<void> {
    const del = args[2];
    const config = configManager.getConfig();

    if (del.toLowerCase() === "all") {
      await configManager.updateConfig((cfg) => {
        cfg.telegraph.list = [];
      });
      await this.editMessage(msg, "✅ 已删除所有记录");
      return;
    }

    const parsedIndex = parseStrictInteger(del);
    const idx = parsedIndex === null ? -1 : parsedIndex - 1;
    requireUser(
      !isNaN(idx) && idx >= 0 && idx < config.telegraph.list.length,
      `序号超出范围 (1-${config.telegraph.list.length})`,
    );

    await configManager.updateConfig((cfg) => {
      cfg.telegraph.list.splice(idx, 1);
    });

    await this.editMessage(msg, `✅ 已删除第 ${idx + 1} 项`);
  }
}

class TimeoutFeature extends BaseFeatureHandler {
  readonly command = "timeout";

  async execute(msg: Api.Message, args: string[]): Promise<void> {
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();

    if (args.length < 2) {
      await this.editMessage(
        msg,
        `⏱️ <b>当前超时设置:</b>\n\n⏰ 超时时间: <code>${config.timeout} 秒</code>`,
      );
      return;
    }

    requireUser(
      args.length === 2,
      buildCommandUsage("aix timeout <整数秒数 1-1800>"),
    );
    const timeout = parseStrictInteger(args[1]);
    requireUser(
      timeout !== null && timeout >= 1 && timeout <= 1800,
      "超时时间必须是 1 到 1800 之间的整数",
    );

    await configManager.updateConfig((cfg) => {
      cfg.timeout = timeout!;
    });

    await this.editMessage(msg, `✅ 超时时间已设置为 ${timeout!} 秒`);
  }
}

class QuestionFeature extends BaseFeatureHandler {
  readonly command = "";

  private activeTokens = new Map<string, AbortToken>();

  constructor(
    private readonly aiService: AIService,
    configManagerPromise: Promise<ConfigManager>,
    private readonly messageUtils: MessageUtils,
  ) {
    super(configManagerPromise);
  }

  private getOperationScope(msg: Api.Message): string {
    const peer = msg.chatId || msg.peerId;
    return peer?.toString?.() || String(peer || "global");
  }

  cancelCurrentOperation(
    reason: string = "操作已取消",
    msg?: Api.Message,
  ): boolean {
    if (msg) {
      const scope = this.getOperationScope(msg);
      const activeToken = this.activeTokens.get(scope);
      const cancelled = !!activeToken && !activeToken.aborted;
      if (cancelled) activeToken.abort(reason);
      this.activeTokens.delete(scope);
      return cancelled;
    }

    let cancelled = false;
    for (const token of this.activeTokens.values()) {
      if (token.aborted) continue;
      token.abort(reason);
      cancelled = true;
    }
    this.activeTokens.clear();
    return cancelled;
  }

  private async runQuestion(
    msg: Api.Message,
    question: string,
  ): Promise<void> {
    this.cancelCurrentOperation("操作已取消", msg);

    const token = this.aiService.createAbortToken();
    const scope = this.getOperationScope(msg);
    this.activeTokens.set(scope, token);

    try {
      await this.handleQuestion(msg, question, token);
    } finally {
      if (this.activeTokens.get(scope) === token) {
        this.activeTokens.delete(scope);
      }
      this.aiService.releaseToken(token);
    }
  }

  async execute(msg: Api.Message, args: string[]): Promise<void> {
    const question = args.join(" ").trim();
    await this.runQuestion(msg, question);
  }

  async askFromReply(msg: Api.Message): Promise<void> {
    const replyMsg = await safeGetReplyMessage(msg);
    requireUser(!!replyMsg, "至少需要一条提示");
    const question = getMessageText(replyMsg).trim();
    await this.runQuestion(msg, question);
  }

  async handleQuestion(
    msg: Api.Message,
    question: string,
    token?: AbortToken,
  ): Promise<void> {
    const config = await this.getConfig();

    requireConfiguredMode(config, "chat");

    token?.throwIfAborted();

    await sendProcessing(msg, "chat");

    const replyMsg = await safeGetReplyMessage(msg);
    const questionText = question.trim();
    let context = getMessageText(replyMsg);
    const replyToId = replyMsg?.id;
    const avatarQuestion = /^(?:a|avatar|头像|頭像)(?:\s+|$)/i.test(questionText);
    const cleanedQuestion = avatarQuestion
      ? questionText.replace(/^(?:a|avatar|头像|頭像)\s*/i, "").trim()
      : questionText;
    const [replyImageParts, messageImageParts] = await Promise.all([
      getMessageImageParts(replyMsg),
      getMessageImageParts(msg),
    ]);
    let imageParts = [...replyImageParts, ...messageImageParts];
    if (avatarQuestion) {
      const avatarPart = await getAvatarImagePartFromMessageSender(replyMsg);
      requireUser(!!replyMsg, "a/头像 需要回复某个人的消息");
      requireUser(!!avatarPart, "无法获取被回复用户头像");
      imageParts = avatarPart ? [avatarPart] : [];
      context = "";
    }

    const normalizedQuestion = cleanedQuestion.trim();
    const normalizedContext = context.trim();
    if (
      normalizedQuestion &&
      normalizedContext &&
      normalizedQuestion === normalizedContext
    ) {
      context = "";
    }

    const finalQuestion = cleanedQuestion || (avatarQuestion ? "请识别这个头像" : questionText);
    const userText = context
      ? `上下文:\n${context}\n\n问题:\n${finalQuestion}`
      : finalQuestion;

    const response = await this.aiService.callAI(userText, imageParts, token);
    const answer = response.text || "AI 回复为空";

    const collapseSafe = config.collapse;
    const htmlAnswer = TelegramFormatter.markdownToHtml(answer, {
      collapseSafe,
    });
    const safeQuestion = htmlEscape(finalQuestion);
    const formattedAnswer = `Q:\n${safeQuestion}\n\nA:\n${htmlAnswer}`;

    token?.throwIfAborted();

    if (config.telegraph.enabled && formattedAnswer.length > 4050) {
      await this.handleLongContentWithTelegraph(
        msg,
        finalQuestion,
        answer,
        replyToId,
        token,
      );
    } else {
      await this.messageUtils.sendLongMessage(
        msg,
        formattedAnswer,
        replyToId,
        token,
        {
          poweredByTag: config.currentChatTag,
        },
      );
    }
    await deleteMessageOrGroup(msg);
  }

  private async handleLongContentWithTelegraph(
    msg: Api.Message,
    question: string,
    rawAnswer: string,
    replyToId?: number,
    token?: AbortToken,
  ): Promise<void> {
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();

    const telegraphMarkdown = `**Q:**\n${question}\n\n**A:**\n${rawAnswer}\n`;
    const telegraphResult = await this.messageUtils.createTelegraphPage(
      telegraphMarkdown,
      question,
      token,
    );

    const poweredByText = `\n<i>🍀Powered by ${config.currentChatTag}</i>`;
    const safeQuestion = htmlEscape(question);
    const questionBlock = config.collapse
      ? `Q:\n<blockquote expandable>${safeQuestion}</blockquote>\n`
      : `Q:\n${safeQuestion}\n`;
    const answerBlock = config.collapse
      ? `A:\n<blockquote expandable>📰内容比较长，Telegraph 观感更好喔:\n🔗 <a href="${telegraphResult.url}">点我阅读内容</a></blockquote>${poweredByText}`
      : `A:\n📰内容比较长，Telegraph 观感更好喔:\n🔗 <a href="${telegraphResult.url}">点我阅读内容</a>${poweredByText}`;

    await MessageSender.sendNew(
      msg,
      questionBlock + answerBlock,
      { parseMode: "html", linkPreview: false },
      replyToId,
    );

    await configManager.updateConfig((cfg) => {
      cfg.telegraph.list.push(telegraphResult);
      if (cfg.telegraph.list.length > cfg.telegraph.limit)
        cfg.telegraph.list.shift();
    });
  }
}

class SearchFeature extends BaseFeatureHandler {
  readonly command = "search";

  constructor(
    private readonly aiService: AIService,
    configManagerPromise: Promise<ConfigManager>,
    private readonly messageUtils: MessageUtils,
  ) {
    super(configManagerPromise);
  }

  async execute(msg: Api.Message, args: string[]): Promise<void> {
    const config = await this.getConfig();

    const promptInput = args.slice(1).join(" ").trim();

    const replyMsg = await safeGetReplyMessage(msg);
    requireUser(!!promptInput || !!replyMsg, "至少需要一条提示");

    requireConfiguredMode(config, "search");

    const token = this.aiService.createAbortToken();
    try {
      await sendProcessing(msg, "search");

      const replyToId = replyMsg?.id;

      const replyText = getMessageText(replyMsg).trim();
      const effectivePrompt =
        promptInput || replyText || "请分析图片并搜索相关信息";
      let context = promptInput ? replyText : "";
      const [replyImageParts, messageImageParts] = await Promise.all([
        getMessageImageParts(replyMsg),
        getMessageImageParts(msg),
      ]);
      token.throwIfAborted();
      const imageParts = [...replyImageParts, ...messageImageParts];

      const normalizedPrompt = effectivePrompt.trim();
      const normalizedContext = (context || "").trim();

      if (
        normalizedPrompt &&
        normalizedContext &&
        normalizedPrompt === normalizedContext
      ) {
        context = "";
      }

      const userText = context
        ? `上下文:\n${context}\n\n问题:\n${effectivePrompt}`
        : effectivePrompt;

      const { text, sources } = await this.aiService.callSearch(
        userText,
        imageParts,
        token,
      );

      const sourcesText =
        sources && sources.length > 0
          ? "\n\n<b>🔗 Sources</b>\n" +
            sources
              .slice(0, 8)
              .map((s, i) => {
                const safeUrl = htmlEscape(s.url);
                const safeTitle = htmlEscape(s.title || s.url);
                return `${i + 1}. <a href="${safeUrl}">${safeTitle}</a>`;
              })
              .join("\n")
          : "";

      const collapseSafe = config.collapse;
      const htmlAnswer = TelegramFormatter.markdownToHtml(
        text || "AI 回复为空",
        { collapseSafe },
      );

      const safeQuestion = htmlEscape(effectivePrompt);
      const formatted = `Q:\n${safeQuestion}\n\nA:\n${htmlAnswer}${sourcesText}`;

      if (config.telegraph.enabled && formatted.length > 4050) {
        const telegraphMarkdown =
          `**Q:**\n${effectivePrompt}\n\n**A:**\n${text || "AI 回复为空"}\n\n` +
          (sources && sources.length
            ? `**Sources:**\n` +
              sources
                .slice(0, 20)
                .map((s, i) => `${i + 1}. ${s.title || s.url}\n${s.url}`)
                .join("\n")
            : "");

        const telegraphResult = await this.messageUtils.createTelegraphPage(
          telegraphMarkdown,
          effectivePrompt,
          token,
        );

        const poweredByText = `\n<i>🍀Powered by ${config.currentSearchTag}</i>`;
        const qBlock = config.collapse
          ? `Q:\n<blockquote expandable>${safeQuestion}</blockquote>\n`
          : `Q:\n${safeQuestion}\n`;
        const aBlock = config.collapse
          ? `A:\n<blockquote expandable>📰内容较长，Telegraph 观感更好：\n🔗 <a href="${telegraphResult.url}">点我阅读内容</a></blockquote>${poweredByText}`
          : `A:\n📰内容较长，Telegraph 观感更好：\n🔗 <a href="${telegraphResult.url}">点我阅读内容</a>${poweredByText}`;

        await MessageSender.sendNew(
          msg,
          qBlock + aBlock,
          { parseMode: "html", linkPreview: false },
          replyToId,
        );

        const configManager = await this.getConfigManager();
        await configManager.updateConfig((cfg) => {
          cfg.telegraph.list.push(telegraphResult);
          if (cfg.telegraph.list.length > cfg.telegraph.limit)
            cfg.telegraph.list.shift();
        });
      } else {
        await this.messageUtils.sendLongMessage(
          msg,
          formatted,
          replyToId,
          token,
          {
            poweredByTag: config.currentSearchTag,
          },
        );
      }

      await deleteMessageOrGroup(msg);
    } catch (error: any) {
      const raw = String(error?.message || error?.response?.data?.error?.message || error || "");
      if (/policy|safety|moderation|content_filter|不合规|违规|敏感|拒绝|安全策略|blocked/i.test(raw)) {
        await MessageSender.sendOrEdit(msg, `⚠️ 当前搜索内容可能不合规或被上游拦截，换个说法再试。

<blockquote expandable>${htmlEscape(raw)}</blockquote>`, { parseMode: "html" });
      } else {
        await sendErrorMessage(msg, error);
      }
    } finally {
      this.aiService.releaseToken(token);
    }
  }
}

const explicitlyRequestsImageCollage = (prompt: string): boolean =>
  /(?:[二两三四五六七八九十\d]+宫格|宫格图|拼成.{0,8}(?:宫格|一张图|一张图片)|组成.{0,8}(?:宫格|一张图|一张图片)|图片.{0,6}(?:拼接|拼在一起|合在一起|合成一张)|(?:拼接|拼图|合并).{0,8}图片)/.test(prompt);

const normalizeSingleImagePrompt = (prompt: string, _index: number, _total: number): string => {
  let p = prompt.trim();
  if (explicitlyRequestsImageCollage(p)) return p;
  p = p
    .replace(/(?:帮我|给我|请)?\s*(?:生成|出|来|做|画|制作|产出|要)\s*\d+\s*(?:张|幅|个|套|组)/g, "生成一张")
    .replace(/(?:帮我|给我|请)?\s*(?:生成|出|来|做|画|制作|产出|要)\s*([一二两俩三四五六七八九十]|十[一二三四五六七八九]|[一二两俩三四五六七八九]十[一二三四五六七八九]?)\s*(?:张|幅|个|套|组)/g, "生成一张")
    .replace(/一组|一套|九宫格|系列/g, "单张")
    .replace(/多张|几张/g, "一张");
  return p || prompt.trim();
};

const HIDDEN_IMAGE_VARIATION_DIRECTIONS = [
  "正面近景、自然互动动作、明亮暖色层次",
  "侧面中景、富有张力的动作、清爽冷色层次",
  "动态斜构图、夸张表情、强烈明暗对比",
  "俯视或高机位、轻松姿态、通透明快配色",
  "全身构图、鲜明肢体语言、柔和细腻质感",
  "低机位特写、戏剧性动作、浓郁电影色彩",
];

const buildHiddenImageExecutionPrompt = (prompt: string, index: number, total: number): string => {
  const p = normalizeSingleImagePrompt(prompt, index, total);
  if (explicitlyRequestsImageCollage(p)) return p;
  const direction = HIDDEN_IMAGE_VARIATION_DIRECTIONS[index % HIDDEN_IMAGE_VARIATION_DIRECTIONS.length];
  return `${p}\n\n内部执行要求：只输出一张独立图片，不做拼图、分屏或九宫格；采用${direction}。`;
};

const IMAGE_GENERATION_CONCURRENCY = 2;
const VIDEO_GENERATION_CONCURRENCY = 2;
const MAX_IMAGE_GENERATION_ATTEMPTS = 3;
const MAX_IMAGE_GENERATION_COUNT = 10;
const MAX_VIDEO_GENERATION_COUNT = 4;

class PartialImageBatchTimeoutError extends Error {
  constructor(
    readonly completedSlots: Array<{ index: number; image: AIImage }>,
  ) {
    super("请求超时");
    this.name = "PartialImageBatchTimeoutError";
  }
}

const generateImageBatchAllOrTimeout = async (
  imageCount: number,
  token: AbortToken,
  generateSlot: (index: number) => Promise<AIImage[]>,
): Promise<AIImage[]> => {
  const slots: Array<AIImage | undefined> = new Array(imageCount).fill(undefined);
  const attempts = new Array<number>(imageCount).fill(0);
  try {
    while (slots.some((image) => !image)) {
      token.throwIfAborted();
      const pendingIndices = slots
        .map((image, index) => image ? -1 : index)
        .filter((index) => index >= 0);
      await runOrderedJobs(pendingIndices.length, IMAGE_GENERATION_CONCURRENCY, token, async (pendingIndex) => {
        const slotIndex = pendingIndices[pendingIndex];
        attempts[slotIndex] += 1;
        try {
          const batch = await generateSlot(slotIndex);
          const generated = batch?.[0];
          if (!generated) throw new Error("AI 回复为空");
          slots[slotIndex] = generated;
        } catch (error) {
          if (token.aborted) throw error;
          if (
            !isRetryableError(error) ||
            attempts[slotIndex] >= MAX_IMAGE_GENERATION_ATTEMPTS
          ) {
            throw error;
          }
        }
      });
      if (slots.some((image) => !image)) {
        const retryRound = Math.max(...attempts);
        await sleep(Math.min(2000, retryRound * 750), token);
      }
    }
  } catch (error) {
    if (token.aborted) {
      const completedSlots = slots
        .map((image, index) => image ? { index, image } : undefined)
        .filter((slot): slot is { index: number; image: AIImage } => !!slot);
      if (completedSlots.length > 0) throw new PartialImageBatchTimeoutError(completedSlots);
    }
    throw error;
  }
  return slots as AIImage[];
};

const parseChineseInteger = (text: string): number | null => {
  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 俩: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  if (!text || !/^[零〇一二两俩三四五六七八九十百千万]+$/.test(text)) return null;
  let total = 0;
  let section = 0;
  let number = 0;
  for (const char of text) {
    if (digits[char] !== undefined) {
      number = digits[char];
      continue;
    }
    const unit = units[char];
    if (unit === 10000) {
      section += number;
      total += (section || 1) * unit;
      section = 0;
      number = 0;
    } else {
      section += (number || 1) * unit;
      number = 0;
    }
  }
  const value = total + section + number;
  return value > 0 ? value : null;
};

interface ParsedNaturalImageRequest {
  prompt: string;
  count: number | null;
  perImagePrompts: string[];
}

const stripNaturalImageCount = (text: string): string =>
  text
    .replace(/(?:帮我|给我|请)?\s*(?:生成|出|来|做|画|制作|产出|要)?\s*\d+\s*(?:张|幅|个)/g, " ")
    .replace(/(?:帮我|给我|请)?\s*(?:生成|出|来|做|画|制作|产出|要)?\s*[零〇一二两俩三四五六七八九十百千万]+\s*(?:张|幅|个)/g, " ")
    .replace(/(?:一|1)\s*(?:组|套)/g, " ")
    .replace(/^[\s:：,，。；;-]+|[\s:：,，。；;-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

// 解析 prompt 里的自然语言数量：生成5张、做三张、一组12张。
const parseNaturalImageCount = (text: string): number | null => {
  const withoutItemLabels = text.replace(/(?:第\s*(?:\d+|[零〇一二两俩三四五六七八九十百千万]+)\s*张|(?:^|\s)\d+\s*[.、)）])/g, " ");
  for (const match of withoutItemLabels.matchAll(/(\d+)\s*(?:张|幅|个)(?:图片|图像|图|头像|表情包|贴纸)?/g)) {
    const value = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  for (const match of withoutItemLabels.matchAll(/([零〇一二两俩三四五六七八九十百千万]+)\s*(?:张|幅|个)(?:图片|图像|图|头像|表情包|贴纸)?/g)) {
    const value = parseChineseInteger(match[1]);
    if (value) return value;
  }
  return null;
};

// 解析逐张内容：第一张… / 第二张… / 1. … / 2. …。
// 开头未分项的文字会作为公共主题、风格和背景要求合并到每一张。
const parseNaturalImageRequest = (text: string): ParsedNaturalImageRequest => {
  const raw = (text || "").replace(/\s+/g, " ").trim();
  const count = parseNaturalImageCount(raw);
  const marker = /(?:第\s*(?:\d+|[零〇一二两俩三四五六七八九十百千万]+)\s*张|(?:^|[\s:：])\d+\s*[.、)）])\s*[:：,，.-]?\s*/g;
  const matches = [...raw.matchAll(marker)];
  if (matches.length < 2) {
    return { prompt: stripNaturalImageCount(raw) || raw, count, perImagePrompts: [] };
  }

  const firstIndex = matches[0].index || 0;
  const common = stripNaturalImageCount(raw.slice(0, firstIndex));
  const items = matches.map((match, index) => {
    const start = (match.index || 0) + match[0].length;
    const end = index + 1 < matches.length ? (matches[index + 1].index || raw.length) : raw.length;
    const specific = raw.slice(start, end).replace(/^[\s:：,，。；;-]+|[\s:：,，。；;-]+$/g, "").trim();
    return [common, specific].filter(Boolean).join("；");
  }).filter(Boolean);

  return {
    prompt: common || items[0] || stripNaturalImageCount(raw) || raw,
    count: items.length || count,
    perImagePrompts: items,
  };
};

const parseMediaCountRequest = (args: string[], startIndex: number): { prompt: string; count: number } => {
  const rawTokens = args.slice(startIndex).filter(Boolean);
  let count = 1;
  const kept: string[] = [];

  for (let i = 0; i < rawTokens.length; i++) {
    const t = rawTokens[i];
    const low = t.toLowerCase();
    if (low === "--n" || low === "-n" || low === "--count") {
      requireUser(
        !!rawTokens[i + 1],
        buildCommandUsage(
          `aix video --n <1-${MAX_VIDEO_GENERATION_COUNT}> [提示词]`,
        ),
      );
      const n = parseStrictInteger(rawTokens[i + 1]);
      requireUser(n !== null && n > 0, "视频数量必须是大于 0 的整数");
      count = n;
      i++;
      continue;
    }
    if (kept.length === 0) {
      const m = low.match(/^(?:n=|count=|x)?(\d+)(?:张|幅|个|套|组|条|个视频)?$/);
      if (m) {
        const n = Number.parseInt(m[1], 10);
        if (Number.isFinite(n) && n > 0) {
          count = n;
          continue;
        }
      }
    }
    kept.push(t);
  }

  return { prompt: kept.join(" ").trim(), count: Math.max(1, count || 1) };
};

const consumeAvatarLockArg = (
  args: string[],
): { args: string[]; forceAvatar: boolean } => {
  if (args.length >= 2 && args[1]?.toLowerCase() === "a") {
    return { args: [args[0], ...args.slice(2)], forceAvatar: true };
  }
  return { args, forceAvatar: false };
};

class ImageFeature extends BaseFeatureHandler {
  readonly command = "image";

  constructor(
    private readonly aiService: AIService,
    configManagerPromise: Promise<ConfigManager>,
    private readonly httpClient: HttpClient,
    private readonly messageUtils: MessageUtils,
  ) {
    super(configManagerPromise);
  }

  private buildPromptTokens(args: string[], forceAvatar: boolean): string[] {
    const tokens = args.slice(1).filter(Boolean);
    if (!tokens.length) return [];
    const first = tokens[0]?.toLowerCase();
    if (forceAvatar) return tokens;
    if (["a", "avatar", "头像", "頭像", "sticker", "贴纸", "貼紙", "image", "img", "图片", "圖片"].includes(first || "")) {
      return tokens.slice(1);
    }
    return tokens;
  }

  private parseImageRequest(args: string[]): { prompt: string; originalPrompt: string; count: number; perImagePrompts: string[] } {
    const forceAvatar = args[1]?.toLowerCase() === "a";
    const rawTokens = this.buildPromptTokens(args, forceAvatar);
    const originalPrompt = rawTokens.join(" ").trim();
    const natural = parseNaturalImageRequest(originalPrompt);
    // 图片数量完全由 prompt 自然语言或逐张内容控制，不再解析独立数字参数。
    const resolvedCount = natural.perImagePrompts.length > 0
      ? natural.perImagePrompts.length
      : (natural.count || 1);
    return {
      prompt: natural.prompt,
      originalPrompt,
      count: Math.max(1, resolvedCount),
      perImagePrompts: natural.perImagePrompts,
    };
  }

  async execute(msg: Api.Message, args: string[]): Promise<void> {
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();
    const replyMsg = await safeGetReplyMessage(msg);
    const replyToId = replyMsg?.id;

    if (
      await handlePromptOptimizationSetting(
        msg,
        args,
        "image",
        configManager,
        config,
      )
    )
      return;

    if (
      await handleBooleanSetting(
        msg,
        args,
        "image",
        configManager,
        config,
        [
          {
            command: "save",
            key: "imageSaveToFavorites",
            statusTitle: "📥 <b>原图收藏状态:</b>",
            successText: "生图后原图发送到收藏",
          },
          {
            command: "preview",
            key: "imagePreview",
            statusTitle: "🖼️ <b>图片预览状态:</b>",
            successText: "图片预览",
          },
        ],
      )
    )
      return;

    const avatarLock = consumeAvatarLockArg(args);
    args = avatarLock.args;
    const forceAvatar = avatarLock.forceAvatar;
    const wantsAvatar =
      forceAvatar ||
      ["a", "avatar", "头像", "頭像"].includes(
        args[1]?.toLowerCase() || "",
      );
    const imageRequest = this.parseImageRequest(args);
    const optimizeParsed = extractPromptOptimizeFlag(imageRequest.originalPrompt);
    const fullPromptInput = optimizeParsed.prompt.replace(/\s+/g, " ").trim();
    const localParsedRequest = parseNaturalImageRequest(fullPromptInput);
    const promptInput = localParsedRequest.prompt;
    const cleanedPromptInput = promptInput.replace(/\s+/g, " ").trim();
    const optimizePrompt = optimizeParsed.optimizePrompt || config.promptOptimize !== false;
    let imageCount = localParsedRequest.perImagePrompts.length > 0
      ? localParsedRequest.perImagePrompts.length
      : (localParsedRequest.count || imageRequest.count);
    requireUser(
      imageCount <= MAX_IMAGE_GENERATION_COUNT,
      `单次最多生成 ${MAX_IMAGE_GENERATION_COUNT} 张图片`,
    );
    let explicitPerImagePrompts = [...localParsedRequest.perImagePrompts];

    const hasPrompt = !!fullPromptInput;
    requireUser(hasPrompt, "至少需要一条文字提示");

    requireConfiguredMode(config, "image");

    const token = this.aiService.createAbortToken();
    let imageGenerationDone = false;
    let generationStatusMsg: Api.Message | undefined;
    let imagePhaseTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let imageStatusTransitionId: ReturnType<typeof setTimeout> | undefined;

    try {
      const [replyImageParts, messageImageParts] = await Promise.all([
        getMessageImageParts(replyMsg),
        getMessageImageParts(msg),
      ]);
      token.throwIfAborted();
      let imageParts = [...replyImageParts, ...messageImageParts];

      // 明确说“头像”时，必须成功取得被回复用户头像。
      if (wantsAvatar) {
        const avatarPart = await getAvatarImagePartFromMessageSender(replyMsg);
        token.throwIfAborted();
        if (avatarPart) {
          imageParts = [avatarPart, ...messageImageParts];
        } else {
          throw new UserError(
            "无法获取被回复用户的头像，请确认对方有公开头像",
          );
        }
      }

      requireUser(imageParts.length <= 6, "⚠️ 最多支持6张参考图");

      const referenceCount = Math.min(imageParts.length, 6);
      if (referenceCount > 0) {
        const statusText = optimizePrompt
          ? `✅ 已识别 ${referenceCount} 张图片`
          : `✅ 已识别 ${referenceCount} 张图片，正在结合生成...`;
        if (messageImageParts.length > 0) {
          generationStatusMsg = await MessageSender.sendNew(msg, statusText);
          await deleteMessageOrGroup(msg);
        } else {
          generationStatusMsg = await MessageSender.sendOrEdit(
            msg,
            statusText,
            { parseMode: "html" },
          );
        }
      } else if (!optimizePrompt) {
        generationStatusMsg = await MessageSender.sendOrEdit(msg, PROCESSING_TEXT.image, {
          parseMode: "html",
        });
      }
      let prompt = cleanedPromptInput;
      // 默认启用聊天模型分析完整生图需求：理解数量、分类和每张对应内容，
      // 再逐张调用图片模型；分析失败或超时时自动回退到本地规则。
      const originalPrompt = fullPromptInput;
      let optimizedPromptText = prompt;
      // 关闭提示词优化时，明确指定的逐张内容会原样用于对应图片。
      let perImagePrompts: string[] = [...explicitPerImagePrompts];

      if (optimizePrompt) {
        requireUser(
          !!config.currentChatTag && !!config.currentChatModel && !!config.configs[config.currentChatTag],
          "⚠️ 图片提示词优化已开启，请先配置聊天模型",
        );
        generationStatusMsg = await replaceStatusMessage(
          generationStatusMsg,
          msg,
          buildPromptOptimizationStatusText(originalPrompt),
        );
        let analyzedPrompts: string[] = [];
        try {
          const analyzed = await runAIWithTimeout(
            this.aiService,
            buildImageRequirementAnalysisRequest(originalPrompt, config.promptLength),
            imageParts,
            token,
            Math.max(Math.min(config.timeout || 30, 45), 20) * 1000,
          );
          analyzedPrompts = parseImageRequirementAnalysis(analyzed.text);
        } catch (error) {
          console.warn("[aix] 聊天模型分析生图需求失败，回退本地规则:", error);
        }

        if (analyzedPrompts.length > 0) {
          imageCount = analyzedPrompts.length;
          requireUser(
            imageCount <= MAX_IMAGE_GENERATION_COUNT,
            `分析结果要求生成 ${imageCount} 张图片，单次上限为 ${MAX_IMAGE_GENERATION_COUNT} 张`,
          );
          explicitPerImagePrompts = analyzedPrompts;
          perImagePrompts = analyzedPrompts;
          prompt = analyzedPrompts[0] || prompt;
          optimizedPromptText = analyzedPrompts.join("\n\n");
          generationStatusMsg = await replaceStatusMessage(
            generationStatusMsg,
            msg,
            imageCount > 1
              ? buildMultiPromptStatusText("提示词已分别优化，正在生图...", analyzedPrompts)
              : buildOptimizedPromptStatusText(prompt),
          );
        } else if (imageCount > 1 && explicitPerImagePrompts.length === imageCount) {
          // 逐张内容优先于 AI 自动规划；开启优化时也只分别润色，不改变对应关系。
          const optimizedPrompts = await runOrderedJobs(
            explicitPerImagePrompts.length,
            IMAGE_GENERATION_CONCURRENCY,
            token,
            async (index) => {
              const explicitPrompt = explicitPerImagePrompts[index];
              try {
                const one = await runAIWithTimeout(
                  this.aiService,
                  buildImagePromptOptimizationRequest(
                    explicitPrompt,
                    config.promptLength,
                  ),
                  imageParts,
                  token,
                  Math.max((config.timeout || 30), 20) * 1000,
                );
                return sanitizeOptimizedImagePrompt(
                  one.text,
                  explicitPrompt,
                );
              } catch (error) {
                console.warn(
                  "[aix] 逐张提示词优化失败，使用原提示词:",
                  error,
                );
                return explicitPrompt;
              }
            },
          );
          perImagePrompts = optimizedPrompts;
          prompt = optimizedPrompts[0] || originalPrompt;
          optimizedPromptText = optimizedPrompts.join("\n\n");
          generationStatusMsg = await replaceStatusMessage(
            generationStatusMsg,
            msg,
            buildMultiPromptStatusText("逐张提示词已优化，正在生图...", optimizedPrompts),
          );
        } else if (imageCount > 1) {
          const optimized = await runAIWithTimeout(
            this.aiService,
            buildMultiImagePromptPlanRequest(originalPrompt, imageCount, config.promptLength),
            imageParts,
            token,
            Math.max((config.timeout || 30), 20) * 1000,
          );
          const plannedPrompts = parseMultiImagePromptPlan(optimized.text, imageCount);
          let optimizedPrompts = plannedPrompts;
          if (optimizedPrompts.length !== imageCount) {
            console.warn("[aix] 多图提示词规划解析失败，改用兜底优化:", optimized.text);
            if (needsExplicitStickerTextPrompt(originalPrompt)) {
              optimizedPrompts = buildStickerTextFallbackPrompts(originalPrompt, imageCount);
            } else {
              optimizedPrompts = await runOrderedJobs(
                imageCount,
                IMAGE_GENERATION_CONCURRENCY,
                token,
                async (i) => {
                  const fallbackPrompt = `${originalPrompt}，第 ${i + 1} 张采用不同表情、动作、构图、色彩和氛围。`;
                  try {
                    const one = await runAIWithTimeout(
                      this.aiService,
                      buildImagePromptOptimizationRequest(
                        fallbackPrompt,
                        config.promptLength,
                      ),
                      imageParts,
                      token,
                      Math.max((config.timeout || 30), 20) * 1000,
                    );
                    return sanitizeOptimizedImagePrompt(
                      one.text,
                      fallbackPrompt,
                    );
                  } catch (error) {
                    console.warn("[aix] 多图逐条提示词优化失败:", error);
                    return fallbackPrompt;
                  }
                },
              );
            }
          }
          perImagePrompts = optimizedPrompts;
          prompt = optimizedPrompts[0] || originalPrompt;
          optimizedPromptText = optimizedPrompts.join("\n\n");
          generationStatusMsg = await replaceStatusMessage(
            generationStatusMsg,
            msg,
            buildMultiPromptStatusText("提示词已分别优化，正在生图...", optimizedPrompts),
          );
        } else {
          const optimized = await runAIWithTimeout(
            this.aiService,
            buildImagePromptOptimizationRequest(originalPrompt, config.promptLength),
            imageParts,
            token,
            Math.max((config.timeout || 30), 20) * 1000,
          );
          if (!optimized.text?.trim() || optimized.text.trim() === "AI 回复为空") {
            // 展示层只回退到原始创作提示词；防拼图约束在实际生图请求时统一追加，避免泄漏到 UI。
            optimized.text = originalPrompt;
          }
          prompt = sanitizeOptimizedImagePrompt(optimized.text, originalPrompt);
          optimizedPromptText = prompt;
          perImagePrompts = [prompt];
          generationStatusMsg = await replaceStatusMessage(
            generationStatusMsg,
            msg,
            buildOptimizedPromptStatusText(prompt),
          );
        }
        if (!imageGenerationDone) {
          // 优化结果展示与生图并行：10 秒后再切换为执行中，不阻塞图片请求。
          const currentStatus = generationStatusMsg;
          imageStatusTransitionId = setTimeout(() => {
            if (imageGenerationDone) return;
            void replaceStatusMessage(
              currentStatus,
              msg,
              PROCESSING_TEXT.image,
            ).then(async (statusMsg) => {
              if (
                imageGenerationDone ||
                generationStatusMsg !== currentStatus
              ) {
                await deleteMessageOrGroup(statusMsg);
                return;
              }
              generationStatusMsg = statusMsg;
            }).catch(() => {});
          }, 10000);
        }
      }

      const normalizedPromptForImage = imageCount > 1
        ? normalizeSingleImagePrompt(prompt, 0, imageCount)
        : prompt;
      // 本地规则只在执行层静默移除数量控制词；关闭优化时，展示层始终保留用户完整原话。
      const displayPrompts = optimizePrompt
        ? (perImagePrompts.length > 0
            ? perImagePrompts
            : Array.from({ length: imageCount }, (_, i) => normalizeSingleImagePrompt(prompt, i, imageCount)))
        : Array.from({ length: imageCount }, () => originalPrompt);
      const imageCaption = imageCount > 1
        ? buildGeneratedPromptListText(displayPrompts)
        : (optimizePrompt ? (optimizedPromptText || normalizedPromptForImage) : originalPrompt);

      // 整个生图阶段总超时：不是每次重试各等一次，避免“图片生成中”无限挂着。
      imagePhaseTimeoutId = setTimeout(() => {
        if (!token.aborted) {
          token.abort("请求超时");
        }
      }, Math.max(config.timeout || 300, 20) * 1000);

      let images: AIImage[] = [];
      const executionPrompts = perImagePrompts.length > 0
        ? perImagePrompts
        : Array.from({ length: imageCount }, (_, i) => normalizeSingleImagePrompt(prompt, i, imageCount));
      try {
        let inputImage: AIImage | undefined;
        if (imageParts.length > 0) {
          inputImage = (await resolveMergedImageParts(
            imageParts,
            this.httpClient,
            token,
          )) || undefined;
          if (!inputImage?.data) throw new Error("无法解析图片数据");
          if (inputImage.mimeType !== "image/png") {
            try {
              const pngBuffer = await sharp(inputImage.data).png().toBuffer();
              inputImage = { data: pngBuffer, mimeType: "image/png" };
            } catch {}
          }
        }
        images = await generateImageBatchAllOrTimeout(
          imageCount,
          token,
          async (i) => {
            const executionPrompt = executionPrompts[i] || prompt;
            const singlePrompt = buildHiddenImageExecutionPrompt(executionPrompt, i, imageCount);
            return inputImage
              ? await this.aiService.editImage(singlePrompt, inputImage, token)
              : await this.aiService.generateImage(singlePrompt, token);
          },
        );
      } catch (error) {
        if (error instanceof PartialImageBatchTimeoutError && error.completedSlots.length > 0) {
          const completed = error.completedSlots.sort((a, b) => a.index - b.index);
          const partialImages = completed.map((slot) => slot.image);
          const partialPrompts = optimizePrompt
            ? completed.map((slot) => displayPrompts[slot.index])
            : originalPrompt;
          const partialNotice = `⏱️ 生成超时，已返回成功的 ${partialImages.length}/${imageCount} 张图片`;
          imageGenerationDone = true;
          await this.messageUtils.sendImages(msg, partialImages, partialPrompts, replyToId, undefined, partialNotice);
          await deleteMessageOrGroup(msg);
          return;
        }
        throw error;
      }
      if (images.length !== imageCount) throw new Error("AI 回复为空");
      imageGenerationDone = true;
      // 关闭优化时只显示一次完整原话，避免相同提示词出现 1、2、3、4 编号。
      await this.messageUtils.sendImages(
        msg,
        imageCount > 1 ? images : images.slice(0, 1),
        imageCount > 1
          ? (optimizePrompt ? displayPrompts : originalPrompt)
          : imageCaption,
        replyToId,
        token,
      );
      await deleteMessageOrGroup(msg);
    } finally {
      imageGenerationDone = true;
      if (imagePhaseTimeoutId) clearTimeout(imagePhaseTimeoutId);
      if (imageStatusTransitionId) clearTimeout(imageStatusTransitionId);
      scheduleDeleteMessage(generationStatusMsg, 1);
      this.aiService.releaseToken(token);
    }
  }
}

class VideoFeature extends BaseFeatureHandler {
  readonly command = "video";

  constructor(
    private readonly aiService: AIService,
    configManagerPromise: Promise<ConfigManager>,
    private readonly messageUtils: MessageUtils,
  ) {
    super(configManagerPromise);
  }

  async execute(msg: Api.Message, args: string[]): Promise<void> {
    const configManager = await this.getConfigManager();
    const config = configManager.getConfig();
    const replyMsg = await safeGetReplyMessage(msg);
    const replyToId = replyMsg?.id;

    const avatarLock = consumeAvatarLockArg(args);
    args = avatarLock.args;
    const forceAvatar = avatarLock.forceAvatar;

    const subCommand = args[1]?.toLowerCase();

    if (
      await handlePromptOptimizationSetting(
        msg,
        args,
        "video",
        configManager,
        config,
      )
    )
      return;

    let imageMode: VideoImageMode = "auto";
    let promptStartIndex = 1;
    if (
      await handleBooleanSetting(
        msg,
        args,
        "video",
        configManager,
        config,
        [
          {
            command: "save",
            key: "videoSaveToFavorites",
            statusTitle: "📥 <b>原视频收藏状态:</b>",
            successText: "生成后原视频发送到收藏",
          },
          {
            command: "preview",
            key: "videoPreview",
            statusTitle: "🎬 <b>视频预览状态:</b>",
            successText: "视频预览",
          },
          {
            command: "audio",
            key: "videoAudio",
            statusTitle: "🔊 <b>视频音频状态:</b>",
            successText: "视频音频",
          },
        ],
      )
    )
      return;
    if (subCommand === "duration") {
      if (!args[2]) {
        requireUser(
          args.length === 2,
          buildCommandUsage("aix video duration [5-20]"),
        );
        await this.editMessage(
          msg,
          `⏱️ <b>视频时长:</b>\n\n⏰ 当前时长: <code>${config.videoDuration} 秒</code>`,
        );
        return;
      }
      requireUser(
        args.length === 3,
        buildCommandUsage("aix video duration [5-20]"),
      );
      const duration = parseStrictInteger(args[2]);
      requireUser(
        duration !== null && duration >= 5 && duration <= 20,
        "时长必须是 5-20 的整数",
      );
      await configManager.updateConfig((cfg) => {
        cfg.videoDuration = duration!;
      });
      await this.editMessage(msg, `✅ 视频时长已设置为 ${duration!} 秒`);
      return;
    }
    if (subCommand === "first" || subCommand === "firstlast") {
      imageMode = subCommand;
      promptStartIndex = 2;
    }

    const videoRequest = parseMediaCountRequest(args, promptStartIndex);
    const videoCount = Math.max(1, videoRequest.count || 1);
    requireUser(
      videoCount <= MAX_VIDEO_GENERATION_COUNT,
      `单次最多生成 ${MAX_VIDEO_GENERATION_COUNT} 个视频`,
    );
    const promptInput = videoRequest.prompt;

    requireConfiguredMode(config, "video");

    const token = this.aiService.createAbortToken();
    let videoPhaseTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let generationStatusMsg: Api.Message | undefined;

    try {
      let [replyImageParts, messageImageParts] = await Promise.all([
        getMessageImageParts(replyMsg),
        getMessageImageParts(msg),
      ]);
      token.throwIfAborted();
      if (forceAvatar) {
        replyImageParts = [];
        const avatarPart = await getAvatarImagePartFromMessageSender(replyMsg);
        token.throwIfAborted();
        requireUser(!!avatarPart, "无法获取被回复用户头像");
        replyImageParts = avatarPart ? [avatarPart] : [];
      }

      let finalPrompt = promptInput;
      const allImageParts = [...replyImageParts, ...messageImageParts];
      const hasPrompt = !!finalPrompt.trim();

      if (imageMode === "first") {
        requireUser(
          allImageParts.length >= 1,
          "video first 需要至少 1 张首帧图片",
        );
      }
      if (imageMode === "firstlast") {
        requireUser(
          allImageParts.length >= 2,
          "video firstlast 需要至少 2 张首尾帧图片",
        );
      }
      requireUser(
        hasPrompt || allImageParts.length > 0,
        "至少需要提示词或参考图片",
      );

      generationStatusMsg = await MessageSender.sendOrEdit(
        msg,
        PROCESSING_TEXT.video,
        {
          parseMode: "html",
        },
      );

      videoPhaseTimeoutId = setTimeout(() => {
        if (!token.aborted) {
          token.abort("请求超时");
        }
      }, Math.max(config.timeout || 300, 20) * 1000);

      let optimizedVideoPrompts: string[] = [];
      if (config.videoPromptOptimize !== false && finalPrompt.trim()) {
        requireUser(
          !!config.currentChatTag && !!config.currentChatModel && !!config.configs[config.currentChatTag],
          "⚠️ 视频提示词优化已开启，请先配置聊天模型",
        );
        if (videoCount > 1) {
          optimizedVideoPrompts = await runOrderedJobs(
            videoCount,
            VIDEO_GENERATION_CONCURRENCY,
            token,
            async (i) => {
              const explicitPrompt = normalizeSingleImagePrompt(
                finalPrompt,
                i,
                videoCount,
              );
              const basePrompt = `${explicitPrompt}\n\n第${i + 1}个视频必须和其他视频在动作、镜头或文案重点上明显不同，不能只做同义改写。`;
              const optimized = await runAIWithTimeout(
                this.aiService,
                buildVideoPromptOptimizationRequest(
                  basePrompt,
                  config.videoPromptLength,
                ),
                allImageParts,
                token,
                Math.max((config.timeout || 30), 20) * 1000,
              );
              if (
                !optimized.text?.trim() ||
                optimized.text.trim() === "AI 回复为空"
              ) {
                optimized.text = basePrompt;
              }
              return sanitizeOptimizedImagePrompt(
                optimized.text,
                basePrompt,
              );
            },
          );
          finalPrompt = optimizedVideoPrompts[0] || finalPrompt;
          generationStatusMsg = await replaceStatusMessage(
            generationStatusMsg,
            msg,
            buildMultiPromptStatusText("视频提示词已分别优化，正在生成视频...", optimizedVideoPrompts),
          );
        } else {
          const optimized = await runAIWithTimeout(
            this.aiService,
            buildVideoPromptOptimizationRequest(finalPrompt, config.videoPromptLength),
            allImageParts,
            token,
            Math.max((config.timeout || 30), 20) * 1000,
          );
          if (!optimized.text?.trim() || optimized.text.trim() === "AI 回复为空") {
            optimized.text = finalPrompt;
          }
          finalPrompt = sanitizeOptimizedImagePrompt(optimized.text, finalPrompt);
          optimizedVideoPrompts = [finalPrompt];
        }
        generationStatusMsg = await replaceStatusMessage(
          generationStatusMsg,
          msg,
          PROCESSING_TEXT.video,
        );
      }

      let imageParts = allImageParts;
      if (imageMode === "first") {
        imageParts = allImageParts.slice(0, 1);
      } else if (imageMode === "firstlast") {
        imageParts = allImageParts.slice(0, 2);
      } else if (allImageParts.length > 0) {
        imageMode = "reference";
        imageParts = allImageParts.slice(0, 4);
      }

      const normalizedVideoPrompts = videoCount > 1
        ? (optimizedVideoPrompts.length > 0
            ? optimizedVideoPrompts
            : Array.from({ length: videoCount }, (_, i) =>
                normalizeSingleImagePrompt(finalPrompt, i, videoCount),
              ))
        : [finalPrompt];
      const videoBatches = await runOrderedJobs(
        normalizedVideoPrompts.length,
        VIDEO_GENERATION_CONCURRENCY,
        token,
        (i) =>
          this.aiService.generateVideo(
            normalizedVideoPrompts[i],
            imageParts,
            imageMode,
            token,
          ),
      );
      const videos = videoBatches.flat();
      if (videos.length === 0) throw new Error("AI 回复为空");
      const videoCaption = videoCount > 1
        ? buildGeneratedPromptListText(normalizedVideoPrompts)
        : finalPrompt;
      await this.messageUtils.sendVideos(
        msg,
        videos,
        videoCaption,
        replyToId,
        token,
      );
      await deleteMessageOrGroup(msg);
    } finally {
      scheduleDeleteMessage(generationStatusMsg, 1);
      if (videoPhaseTimeoutId) clearTimeout(videoPhaseTimeoutId);
      this.aiService.releaseToken(token);
    }
  }
}

class AIXPlugin extends Plugin {
  name = "aix";

  private cleanedUp = false;

  private aiService: AIService;
  private httpClient: HttpClient;
  private featureRegistry: FeatureRegistry;
  private questionFeature: QuestionFeature;
  private imageFeature: ImageFeature;
  private configManagerPromise: Promise<ConfigManager>;

  constructor() {
    super();
    this.configManagerPromise = ConfigManager.getInstance();
    this.httpClient = new HttpClient(this.configManagerPromise);
    this.aiService = new AIService(this.configManagerPromise, this.httpClient);
    const messageUtils = new MessageUtils(
      this.configManagerPromise,
      this.httpClient,
    );
    this.featureRegistry = new FeatureRegistry();
    this.questionFeature = new QuestionFeature(
      this.aiService,
      this.configManagerPromise,
      messageUtils,
    );
    this.imageFeature = new ImageFeature(
      this.aiService,
      this.configManagerPromise,
      this.httpClient,
      messageUtils,
    );
    this.registerFeatures(messageUtils);
  }

  private registerFeatures(messageUtils: MessageUtils): void {
    [
      new ConfigFeature(this.configManagerPromise),
      new ModelFeature(this.configManagerPromise),
      new PromptFeature(this.configManagerPromise),
      new CollapseFeature(this.configManagerPromise),
      new TelegraphFeature(this.configManagerPromise),
      new TimeoutFeature(this.configManagerPromise),
    ].forEach((feature) => this.featureRegistry.register(feature));

    this.featureRegistry.register(
      new SearchFeature(
        this.aiService,
        this.configManagerPromise,
        messageUtils,
      ),
    );
    this.featureRegistry.register(this.imageFeature);
    this.featureRegistry.register(
      new VideoFeature(
        this.aiService,
        this.configManagerPromise,
        messageUtils,
      ),
    );
  }

  description = async (): Promise<string> => {
    const mainPrefix = getMainPrefix();
    const config = (await this.configManagerPromise).getConfig();

    const baseDescription = `<b>🤖 AIX 智能助手</b>

<b>💬 问答与搜索:</b>
• <code>${mainPrefix}aix &lt;问题&gt;</code> - 向 AI 提问
• <code>${mainPrefix}aix input &lt;问题&gt;</code> - 显式问答入口
• <code>${mainPrefix}aix a|avatar|头像 [问题]</code> - 分析被回复目标头像
• <code>${mainPrefix}aix search &lt;问题&gt;</code> - 联网搜索并回答
• 裸 <code>${mainPrefix}aix</code> 或省略问题时，需要回复一条消息

<b>🖼️ 图片与视频:</b>
• <code>${mainPrefix}aix image &lt;提示词&gt; [--opt]</code> - 文生图/图片编辑
• <code>${mainPrefix}aix image a|avatar|头像 &lt;提示词&gt;</code> - 使用被回复目标头像
• <code>${mainPrefix}aix video [提示词]</code> - 文生/参考图视频
• <code>${mainPrefix}aix video a [提示词]</code> - 使用被回复目标头像
• <code>${mainPrefix}aix video first [提示词]</code> - 首帧模式，至少需要 1 张图
• <code>${mainPrefix}aix video firstlast [提示词]</code> - 首尾帧模式，至少需要 2 张图
• <code>${mainPrefix}aix video --n 1-${MAX_VIDEO_GENERATION_COUNT} [提示词]</code> - 多视频；兼容 <code>-n</code>/<code>--count</code>
• 单次最多生成 ${MAX_IMAGE_GENERATION_COUNT} 张图片；图片最多使用 6 张参考图；视频参考模式最多使用前 4 张

<b>⚙️ API 配置:</b>
• <code>${mainPrefix}aix config [list]</code> - 查看配置
• <code>${mainPrefix}aix config add &lt;tag...&gt; &lt;url&gt; &lt;key&gt; [type]</code> - 添加配置（仅限安全私密场景）
• <code>${mainPrefix}aix config del &lt;tag...&gt;</code> - 删除配置
• <code>${mainPrefix}aix config type &lt;tag...&gt; &lt;type&gt;</code> - 修改类型
• <code>${mainPrefix}aix config stream &lt;tag...&gt; &lt;on|off&gt;</code>
• <code>${mainPrefix}aix config responses &lt;tag...&gt; &lt;on|off&gt;</code>
• type: <code>${PROVIDER_TYPE_OPTIONS}</code>

<b>🤖 模型:</b>
• <code>${mainPrefix}aix model</code> - 查看当前模型
• <code>${mainPrefix}aix model &lt;chat|search|image|video&gt; &lt;tag...&gt; &lt;model&gt;</code>

<b>🧠 提示词设置:</b>
• <code>${mainPrefix}aix prompt</code> - 查看系统提示词
• <code>${mainPrefix}aix prompt set &lt;内容&gt;</code>
• <code>${mainPrefix}aix prompt del</code>
• <code>${mainPrefix}aix image optimize [on|off]</code>
• <code>${mainPrefix}aix image optimize length [short|medium|long]</code>
• <code>${mainPrefix}aix video optimize [on|off]</code>
• <code>${mainPrefix}aix video optimize length [short|medium|long]</code>

<b>🛠 输出与系统:</b>
• <code>${mainPrefix}aix image preview [on|off]</code>
• <code>${mainPrefix}aix image save [on|off]</code>
• <code>${mainPrefix}aix video preview [on|off]</code>
• <code>${mainPrefix}aix video save [on|off]</code>
• <code>${mainPrefix}aix video audio [on|off]</code>
• <code>${mainPrefix}aix video duration [5-20]</code>
• <code>${mainPrefix}aix collapse [on|off]</code>
• <code>${mainPrefix}aix timeout [整数秒数 1-1800]</code>
• <code>${mainPrefix}aix telegraph [on|off]</code>
• <code>${mainPrefix}aix telegraph limit &lt;正整数&gt;</code>
• <code>${mainPrefix}aix telegraph del &lt;序号|all&gt;</code>
• <code>${mainPrefix}aix help</code> / <code>${mainPrefix}aix ?</code>
• <code>${mainPrefix}aix stop</code> - 取消当前插件内所有 AIX 任务`;

    if (!config.collapse) return baseDescription;
    return `<blockquote expandable>${baseDescription}</blockquote>`;
  };

  listenMessageHandler = async (msg: Api.Message): Promise<void> => {
    try {
      if (!msg.out) return;
      const text = getMessageText(msg).trim();
      const prefixes = getPrefixes();
      if (prefixes.some((p) => text.startsWith(`${p}aix`))) return;
    } catch (error) {
      console.log("[aix] listen message error:", error);
    }
  };

  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    aix: async (msg: Api.Message, trigger?: Api.Message) => {
      try {
        const args = getMessageText(msg).trim().split(/\s+/).slice(1);

        if (args.length === 0) {
          await this.questionFeature.askFromReply(msg);
          return;
        }

        const sub = args[0].toLowerCase();
        if (sub === "help" || sub === "?") {
          const description = await this.description();
          await MessageSender.sendOrEdit(trigger || msg, description, {
            parseMode: "html",
          });
          return;
        }
        if (sub === "stop") {
          const cancelledQuestion = this.questionFeature.cancelCurrentOperation("__AIX_SILENT_CANCEL__");
          const cancelledOperations = this.aiService.cancelAllOperations("__AIX_SILENT_CANCEL__");
          await MessageSender.sendOrEdit(
            trigger || msg,
            cancelledQuestion || cancelledOperations > 0
              ? "🚫 操作已取消"
              : "⚠️ 当前没有正在执行的任务",
          );
          return;
        }
        if (sub === "input") {
          if (args.length === 1) {
            await this.questionFeature.askFromReply(msg);
          } else {
            await this.questionFeature.execute(msg, args.slice(1));
          }
          return;
        }
        const handler = this.featureRegistry.getHandler(sub);

        if (handler) await handler.execute(msg, args);
        else await this.questionFeature.execute(msg, args);
      } catch (error: any) {
        await sendErrorMessage(msg, error, trigger);
      }
    },
  };

  async cleanup(): Promise<void> {
    if (this.cleanedUp) {
      return;
    }
    this.cleanedUp = true;

    this.questionFeature.cancelCurrentOperation();
    await this.aiService.destroy();
    this.httpClient.destroy();
    const configManager = await this.configManagerPromise;
    await configManager.destroy();
  }
}

export default new AIXPlugin();
