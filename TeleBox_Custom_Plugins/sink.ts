import * as path from 'node:path'
import { htmlEscape } from '@utils/htmlEscape'
import { createDirectoryInAssets } from '@utils/pathHelpers'
import { Plugin } from '@utils/pluginBase'
import { getPrefixes } from '@utils/pluginManager'
import { safeGetReplyMessage } from '@utils/safeGetMessages'
import axios, { type AxiosError, type AxiosInstance } from 'axios'
import type { Low } from 'lowdb'
import { JSONFilePreset } from 'lowdb/node'
import { Api } from 'teleproto'

interface SinkConfig {
  baseUrl: string
  siteToken: string
  autoDeleteCreatedMessage: boolean
}

interface CreateLinkBody {
  url: string
  slug?: string
  comment?: string
  expiration?: number
  password?: string
  cloaking?: boolean
  redirectWithQuery?: boolean
  unsafe?: boolean
  tags?: string[]
}

interface ParsedCreateArgs {
  body: CreateLinkBody
  deleteAfterCreate: boolean
}

interface SinkLink {
  slug?: string
  url?: string
  comment?: string
  expiration?: number
  tags?: string[]
  createdAt?: number
  [key: string]: unknown
}

const prefixes = getPrefixes()
const mainPrefix = prefixes[0] || '.'
const commandName = `${mainPrefix}sink`
const REQUEST_TIMEOUT = 15_000
const MAX_RESULT_ITEMS = 10
const LIST_PAGE_SIZE = 100
const MAX_MESSAGE_LENGTH = 3800
const MAX_URL_LENGTH = 2048
const MAX_COMMENT_LENGTH = 2048
const MAX_PASSWORD_LENGTH = 128
const MAX_SEARCH_BYTES = 48
const DELETE_DELAY_MS = 10_000
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i

const helpText = `
<b>🔗 Sink 短链管理</b>

<b>配置</b>
• <code>${commandName} config url https://s.example.com</code>
• <code>${commandName} config token YOUR_SITE_TOKEN</code>
• <code>${commandName} config delete on|off</code> 全局开启或关闭创建结果自动删除
• <code>${commandName} config show</code>
• <code>${commandName} verify</code>

<b>创建</b>
• 回复含网址的消息后发送 <code>${commandName}</code>：提取内容中的第一个网址，短链码随机生成
• <code>${commandName} https://example.com/long-url</code>：缩短指定网址
• <code>${commandName} &lt;URL&gt; [选项]</code>

创建选项：
• <code>s my-link</code> 自定义短链码；省略 <code>s</code> 时随机生成
• <code>c "我的备注"</code> 设置备注；包含空格时使用引号
• <code>t tag1,tag2</code> 设置标签，最多 10 个
• <code>e 7d</code> 设置过期时间，支持 m/h/d 或 Unix 秒
• <code>p "访问密码"</code> 设置密码；包含空格时使用引号
• <code>k</code> 隐藏目标地址
• <code>q</code> 将访问参数透传给目标地址
• <code>u</code> 跳转前显示风险提示
• <code>d</code> 创建成功消息在 10 秒后删除

示例：
• 回复含网址的消息：<code>${commandName} s my-link e 7d</code>
• 指定网址：<code>${commandName} https://example.com s my-link t demo,test</code>

<b>管理</b>
• <code>${commandName} list</code> 查看当前所有短链
• <code>${commandName} get &lt;slug&gt;</code>
• <code>${commandName} search &lt;关键词&gt;</code>
• <code>${commandName} delete &lt;slug&gt; [slug...]</code> 删除一个或多个短链

配置中的 Token 就是 Sink 的 <code>NUXT_SITE_TOKEN</code>，至少 8 个字符。`

const normalizeBaseUrl = (value: string): string => {
  const input = value.trim().replace(/\/+$/, '')
  const parsed = new URL(input)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('实例地址只支持 http:// 或 https://')
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('实例地址不能包含路径、查询参数或锚点')
  }
  return parsed.origin
}

const normalizeTargetUrl = (value: string): string => {
  const parsed = new URL(value.trim())
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('目标地址只支持 http:// 或 https://')
  }
  const url = parsed.toString()
  if (url.length > MAX_URL_LENGTH) {
    throw new Error(`目标地址不能超过 ${MAX_URL_LENGTH} 个字符`)
  }
  return url
}

const maskToken = (token: string): string => {
  if (!token) return '未设置'
  if (token.length <= 8) return `${token.slice(0, 2)}••••••`
  return `${token.slice(0, 4)}••••${token.slice(-4)}`
}

const formatShortUrlLabel = (url: string): string => url.replace(/^https?:\/\//i, '')

const formatTime = (timestamp?: number): string => {
  if (!timestamp) return '永久'
  return new Date(timestamp * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false
  })
}

const parseExpiration = (value: string): number => {
  if (/^\d{10}$/.test(value)) {
    const timestamp = Number(value)
    if (!Number.isSafeInteger(timestamp) || timestamp <= Date.now() / 1000) {
      throw new Error('过期时间必须是未来的 Unix 秒')
    }
    return timestamp
  }

  const match = value.toLowerCase().match(/^(\d+)(m|h|d)$/)
  if (!match) {
    throw new Error('过期时间格式错误，请使用 30m、12h、7d 或未来的 Unix 秒')
  }

  const amount = Number(match[1])
  const unitSeconds = { m: 60, h: 3600, d: 86400 }[match[2]]
  if (!amount || !unitSeconds) throw new Error('过期时间必须大于 0')
  return Math.floor(Date.now() / 1000) + amount * unitSeconds
}

const takeValue = (args: string[], index: number, option: string): string => {
  const value = args[index + 1]?.trim()
  if (!value) {
    throw new Error(`${option} 缺少参数`)
  }
  return value
}

const tokenizeArguments = (text: string): string[] => {
  const tokens: string[] = []
  let token = ''
  let quote = ''

  for (const character of text) {
    if (quote) {
      if (character === quote) {
        quote = ''
      } else {
        token += character
      }
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (/\s/.test(character)) {
      if (token) {
        tokens.push(token)
        token = ''
      }
    } else {
      token += character
    }
  }

  if (quote) throw new Error('参数引号没有闭合')
  if (token) tokens.push(token)
  return tokens
}

const parseCreateArgs = (args: string[], fallbackUrl = ''): ParsedCreateArgs => {
  const hasExplicitUrl = /^https?:\/\//i.test(args[0] || '')
  const targetUrl = hasExplicitUrl ? args[0] : fallbackUrl
  if (!targetUrl) throw new Error('请提供要缩短的网址，或回复一条包含网址的消息')

  const body: CreateLinkBody = { url: normalizeTargetUrl(targetUrl) }
  let deleteAfterCreate = false
  for (let index = hasExplicitUrl ? 1 : 0; index < args.length; index += 1) {
    const option = args[index].toLowerCase()
    if (option === 's') {
      const slug = takeValue(args, index, option)
      if (!SLUG_PATTERN.test(slug)) {
        throw new Error('短链码只能包含字母、数字和单个连字符，且不能以连字符开头或结尾')
      }
      body.slug = slug
      index += 1
    } else if (option === 'c') {
      const comment = takeValue(args, index, option)
      if (comment.length > MAX_COMMENT_LENGTH) {
        throw new Error(`备注不能超过 ${MAX_COMMENT_LENGTH} 个字符`)
      }
      body.comment = comment
      index += 1
    } else if (option === 't') {
      const tags = takeValue(args, index, option)
        .split(',')
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
      if (tags.length > 10) throw new Error('标签不能超过 10 个')
      if (tags.some((tag) => tag.length > 32)) {
        throw new Error('每个标签不能超过 32 个字符')
      }
      body.tags = [...new Set(tags)]
      index += 1
    } else if (option === 'e') {
      body.expiration = parseExpiration(takeValue(args, index, option))
      index += 1
    } else if (option === 'p') {
      const password = takeValue(args, index, option)
      if (password.length > MAX_PASSWORD_LENGTH) {
        throw new Error(`密码不能超过 ${MAX_PASSWORD_LENGTH} 个字符`)
      }
      body.password = password
      index += 1
    } else if (option === 'k') {
      body.cloaking = true
    } else if (option === 'q') {
      body.redirectWithQuery = true
    } else if (option === 'u') {
      body.unsafe = true
    } else if (option === 'd') {
      deleteAfterCreate = true
    } else {
      throw new Error(`未知选项：${args[index]}；使用 ${commandName} help 查看单字符参数`)
    }
  }
  return { body, deleteAfterCreate }
}

const scheduleMessageDeletion = (msg: Api.Message): void => {
  setTimeout(() => {
    void msg.delete({ revoke: true }).catch(() => {})
  }, DELETE_DELAY_MS)
}

const getRepliedContentUrl = async (msg: Api.Message): Promise<string> => {
  const replied = await safeGetReplyMessage(msg)
  if (!replied) return ''

  const text = replied.message || ''
  for (const entity of replied.entities || []) {
    if (entity instanceof Api.MessageEntityTextUrl) {
      return entity.url
    }
    if (entity instanceof Api.MessageEntityUrl) {
      return text.slice(entity.offset, entity.offset + entity.length)
    }
  }

  const plainUrl = text.match(/https?:\/\/[^\s<>"']+/i)?.[0]
  if (plainUrl) return plainUrl.replace(/[),.;!?，。；！？）]+$/, '')

  if (replied.media instanceof Api.MessageMediaWebPage && replied.media.webpage instanceof Api.WebPage) {
    return replied.media.webpage.url
  }

  throw new Error('被回复消息的内容中没有识别到 http:// 或 https:// 网址')
}

const unwrapLink = (data: unknown): SinkLink => {
  if (!data || typeof data !== 'object') return {}
  const record = data as Record<string, unknown>
  const nested = record.link ?? record.data
  return nested && typeof nested === 'object' ? (nested as SinkLink) : (record as SinkLink)
}

const unwrapLinks = (data: unknown): SinkLink[] => {
  if (Array.isArray(data)) return data as SinkLink[]
  if (!data || typeof data !== 'object') return []
  const record = data as Record<string, unknown>
  for (const value of [record.links, record.items, record.data]) {
    if (Array.isArray(value)) return value as SinkLink[]
  }
  return []
}

const getListPageState = (data: unknown): { cursor?: string; complete: boolean } => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { complete: true }
  }
  const record = data as Record<string, unknown>
  return {
    cursor: typeof record.cursor === 'string' ? record.cursor : undefined,
    complete: record.list_complete === true
  }
}

const extractErrorMessage = (error: AxiosError): string => {
  const data = error.response?.data
  if (typeof data === 'string') return data.slice(0, 300)
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    for (const key of ['message', 'statusMessage', 'error']) {
      if (typeof record[key] === 'string') return record[key].slice(0, 300)
    }
  }
  return ''
}

const friendlyError = (error: unknown): string => {
  if (!(error instanceof Error)) return '未知错误'
  if (!axios.isAxiosError(error)) return error.message

  const status = error.response?.status
  if (status === 401 || status === 403) {
    return '认证失败，请检查站点 Token；如启用了 Cloudflare Access，也请确认 API 访问策略'
  }
  if (status === 409) return '短链码已存在，请更换 s 参数或省略 s 让 Sink 自动生成'
  if (status === 423) {
    return 'Sink 存储尚未就绪，请先打开 Dashboard → Links 完成初始化'
  }
  if (error.code === 'ECONNABORTED') return '请求超时，请检查 Sink 实例状态'
  if (error.code === 'ENOTFOUND') return '无法解析 Sink 实例域名'
  if (error.code === 'ECONNREFUSED') return 'Sink 实例拒绝连接'

  const detail = extractErrorMessage(error)
  return detail ? `Sink API 返回 ${status || '错误'}：${detail}` : `Sink API 请求失败${status ? `（HTTP ${status}）` : ''}`
}

const formatLink = (link: SinkLink, baseUrl: string): string => {
  const slug = typeof link.slug === 'string' ? link.slug : ''
  const target = typeof link.url === 'string' ? link.url : ''
  const shortUrl = slug ? `${baseUrl}/${encodeURIComponent(slug)}` : ''
  const lines = [
    slug ? `<b>短链：</b> <a href="${htmlEscape(shortUrl)}">${htmlEscape(formatShortUrlLabel(shortUrl))}</a>` : '',
    target ? `<b>目标：</b> <code>${htmlEscape(target)}</code>` : '',
    link.comment ? `<b>备注：</b> ${htmlEscape(String(link.comment))}` : '',
    Array.isArray(link.tags) && link.tags.length ? `<b>标签：</b> ${htmlEscape(link.tags.join(', '))}` : '',
    link.expiration ? `<b>过期：</b> ${htmlEscape(formatTime(link.expiration))}` : ''
  ]
  return lines.filter(Boolean).join('\n')
}

class SinkPlugin extends Plugin {
  description = helpText
  private dbPromise?: Promise<Low<SinkConfig>>

  private async getDb(): Promise<Low<SinkConfig>> {
    if (!this.dbPromise) {
      this.dbPromise = (async () => {
        const directory = createDirectoryInAssets('sink')
        return JSONFilePreset<SinkConfig>(path.join(directory, 'config.json'), {
          baseUrl: '',
          siteToken: '',
          autoDeleteCreatedMessage: false
        })
      })()
    }
    return this.dbPromise
  }

  private async getConfig(): Promise<SinkConfig> {
    const db = await this.getDb()
    await db.read()
    return { ...db.data }
  }

  private async updateConfig(patch: Partial<SinkConfig>): Promise<SinkConfig> {
    const db = await this.getDb()
    await db.read()
    db.data = { ...db.data, ...patch }
    await db.write()
    return { ...db.data }
  }

  private async getClient(): Promise<{
    client: AxiosInstance
    config: SinkConfig
  }> {
    const config = await this.getConfig()
    if (!config.baseUrl || !config.siteToken) {
      throw new Error(`请先设置实例地址和 Token，使用 ${commandName} help 查看方法`)
    }

    return {
      config,
      client: axios.create({
        baseURL: config.baseUrl,
        timeout: REQUEST_TIMEOUT,
        headers: {
          Authorization: `Bearer ${config.siteToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'TeleBox-Sink-Plugin/1.0'
        }
      })
    }
  }

  private async handleConfig(msg: Api.Message, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase()
    if (action === 'show') {
      const config = await this.getConfig()
      await msg.edit({
        text: ['<b>⚙️ Sink 配置</b>', `<b>实例：</b> ${config.baseUrl ? `<code>${htmlEscape(config.baseUrl)}</code>` : '未设置'}`, `<b>Token：</b> <code>${htmlEscape(maskToken(config.siteToken))}</code>`, `<b>创建结果 10 秒后删除：</b> ${config.autoDeleteCreatedMessage ? '已开启' : '已关闭'}`].join(
          '\n'
        ),
        parseMode: 'html'
      })
      return
    }

    if (action === 'delete') {
      const value = args[1]?.toLowerCase()
      if (value !== 'on' && value !== 'off') {
        throw new Error(`用法：${commandName} config delete on|off`)
      }
      const enabled = value === 'on'
      await this.updateConfig({ autoDeleteCreatedMessage: enabled })
      await msg.edit({
        text: `✅ 创建成功消息 10 秒后删除已${enabled ? '开启' : '关闭'}`
      })
      return
    }

    if (action === 'url') {
      if (!args[1]) throw new Error('请提供 Sink 实例地址')
      const baseUrl = normalizeBaseUrl(args[1])
      await this.updateConfig({ baseUrl })
      await msg.edit({
        text: `✅ Sink 实例已设置为 <code>${htmlEscape(baseUrl)}</code>`,
        parseMode: 'html'
      })
      return
    }

    if (action === 'token') {
      const token = args[1]?.trim()
      if (!token || token.length < 8) {
        throw new Error('站点 Token 至少需要 8 个字符')
      }
      await this.updateConfig({ siteToken: token })
      await msg.edit({ text: '✅ Sink Token 已保存' })
      return
    }

    throw new Error(`用法：${commandName} config url|token|delete|show`)
  }

  private async handleVerify(msg: Api.Message): Promise<void> {
    const { client, config } = await this.getClient()
    await msg.edit({ text: '🔄 正在验证 Sink 配置…' })
    await client.get('/api/verify')
    await msg.edit({
      text: `✅ Sink API 认证成功\n<code>${htmlEscape(config.baseUrl)}</code>`,
      parseMode: 'html'
    })
  }

  private async handleCreate(msg: Api.Message, args: string[]): Promise<void> {
    const fallbackUrl = /^https?:\/\//i.test(args[0] || '') ? '' : await getRepliedContentUrl(msg)
    const { body, deleteAfterCreate: deleteRequested } = parseCreateArgs(args, fallbackUrl)
    const { client, config } = await this.getClient()
    const deleteAfterCreate = config.autoDeleteCreatedMessage || deleteRequested
    await msg.edit({ text: '🔄 正在创建短链…' })
    const response = await client.post('/api/link/create', body)
    const link = unwrapLink(response.data)
    if (!link.slug && body.slug) link.slug = body.slug
    if (!link.url) link.url = body.url
    const formatted = formatLink(link, config.baseUrl)
    const deletionNotice = deleteAfterCreate ? '\n\n<i>⏳ 此消息将在 10 秒后删除</i>' : ''
    await msg.edit({
      text: `${formatted ? `✅ <b>短链已创建</b>\n\n${formatted}` : '✅ 短链已创建'}${deletionNotice}`,
      parseMode: 'html',
      linkPreview: false
    })
    if (deleteAfterCreate) scheduleMessageDeletion(msg)
  }

  private async handleGet(msg: Api.Message, slug: string): Promise<void> {
    if (!slug) throw new Error('请提供短链码')
    const { client, config } = await this.getClient()
    await msg.edit({ text: '🔄 正在查询短链…' })
    const response = await client.get('/api/link/query', {
      params: { slug }
    })
    const formatted = formatLink(unwrapLink(response.data), config.baseUrl)
    await msg.edit({
      text: formatted ? `🔎 <b>短链详情</b>\n\n${formatted}` : '未找到该短链',
      parseMode: 'html',
      linkPreview: false
    })
  }

  private async handleSearch(msg: Api.Message, query: string): Promise<void> {
    const keyword = query.trim()
    if (!keyword) throw new Error('请提供搜索关键词')
    if (new TextEncoder().encode(keyword.toLowerCase().replace(/[!%_]/g, '!$&')).length > MAX_SEARCH_BYTES) {
      throw new Error(`搜索关键词不能超过 ${MAX_SEARCH_BYTES} 个 UTF-8 字节`)
    }
    const { client, config } = await this.getClient()
    await msg.edit({ text: '🔄 正在搜索短链…' })
    const response = await client.get('/api/link/search', {
      params: { q: keyword, status: 'all', limit: MAX_RESULT_ITEMS }
    })
    const links = unwrapLinks(response.data)
    if (!links.length) {
      await msg.edit({ text: '没有找到匹配的短链' })
      return
    }
    const items = links.map((link, index) => {
      const slug = typeof link.slug === 'string' ? link.slug : '未知'
      const target = typeof link.url === 'string' ? link.url : ''
      const shortUrl = `${config.baseUrl}/${encodeURIComponent(slug)}`
      return [`<b>${index + 1}. ${htmlEscape(slug)}</b>`, `<a href="${htmlEscape(shortUrl)}">${htmlEscape(formatShortUrlLabel(shortUrl))}</a>`, target ? `<code>${htmlEscape(target)}</code>` : ''].filter(Boolean).join('\n')
    })
    await msg.edit({
      text: `🔎 <b>搜索结果（${links.length}）</b>\n\n${items.join('\n\n')}`,
      parseMode: 'html',
      linkPreview: false
    })
  }

  private async handleList(msg: Api.Message): Promise<void> {
    const { client, config } = await this.getClient()
    await msg.edit({ text: '🔄 正在读取全部短链…' })

    const links: SinkLink[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined

    while (true) {
      const response = await client.get('/api/link/list', {
        params: {
          limit: LIST_PAGE_SIZE,
          sort: 'newest',
          status: 'all',
          ...(cursor ? { cursor } : {})
        }
      })
      links.push(...unwrapLinks(response.data))

      const page = getListPageState(response.data)
      if (page.complete) break
      if (!page.cursor || seenCursors.has(page.cursor)) {
        throw new Error('Sink 返回了无效的列表分页信息，无法继续读取全部短链')
      }
      seenCursors.add(page.cursor)
      cursor = page.cursor
    }

    if (!links.length) {
      await msg.edit({ text: '当前没有短链' })
      return
    }

    const items = links.map((link, index) => {
      const slug = typeof link.slug === 'string' ? link.slug : ''
      const target = typeof link.url === 'string' ? link.url : ''
      const shortUrl = slug ? `${config.baseUrl}/${encodeURIComponent(slug)}` : config.baseUrl
      return [`<b>${index + 1}.</b> <a href="${htmlEscape(shortUrl)}">${htmlEscape(formatShortUrlLabel(shortUrl))}</a>`, slug ? `<b>Slug：</b> <code>${htmlEscape(slug)}</code>` : '', target ? `<code>${htmlEscape(target)}</code>` : ''].filter(Boolean).join('\n')
    })

    const chunks: string[] = []
    let chunk = ''
    for (const item of items) {
      const candidate = chunk ? `${chunk}\n\n${item}` : item
      if (candidate.length > MAX_MESSAGE_LENGTH && chunk) {
        chunks.push(chunk)
        chunk = item
      } else {
        chunk = candidate
      }
    }
    if (chunk) chunks.push(chunk)

    const renderChunk = (content: string, index: number): string => `<b>🔗 全部短链（${links.length}）</b>${chunks.length > 1 ? ` · ${index + 1}/${chunks.length}` : ''}\n\n${content}`
    await msg.edit({
      text: renderChunk(chunks[0], 0),
      parseMode: 'html',
      linkPreview: false
    })
    for (let index = 1; index < chunks.length; index += 1) {
      await msg.reply({
        message: renderChunk(chunks[index], index),
        parseMode: 'html',
        linkPreview: false
      })
    }
  }

  private async handleDelete(msg: Api.Message, inputSlugs: string[]): Promise<void> {
    const slugs = [...new Set(inputSlugs.map((slug) => slug.trim()).filter(Boolean))]
    if (!slugs.length) throw new Error('请提供至少一个要删除的短链码')
    const { client } = await this.getClient()
    await msg.edit({ text: `🔄 正在删除 ${slugs.length} 个短链…` })

    const deleted: string[] = []
    const failed: { slug: string; reason: string }[] = []
    for (const slug of slugs) {
      try {
        await client.post('/api/link/delete', { slug })
        deleted.push(slug)
      } catch (error) {
        failed.push({ slug, reason: friendlyError(error) })
      }
    }

    const lines = ['<b>🗑️ 短链删除结果</b>']
    if (deleted.length) {
      lines.push('', `<b>成功（${deleted.length}）：</b>`, ...deleted.map((slug) => `<code>${htmlEscape(slug)}</code>`))
    }
    if (failed.length) {
      lines.push('', `<b>失败（${failed.length}）：</b>`, ...failed.map(({ slug, reason }) => `<code>${htmlEscape(slug)}</code> — ${htmlEscape(reason)}`))
    }
    await msg.edit({
      text: lines.join('\n'),
      parseMode: 'html'
    })
  }

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    sink: async (msg: Api.Message) => {
      try {
        const text = msg.message?.trim() || ''
        const args = tokenizeArguments(text).slice(1)
        const subcommand = args[0]?.toLowerCase()

        if (!subcommand && msg.replyTo) {
          await this.handleCreate(msg, [])
        } else if (!subcommand || subcommand === 'help' || subcommand === '?') {
          await msg.edit({ text: helpText, parseMode: 'html', linkPreview: false })
        } else if (subcommand === 'config') {
          await this.handleConfig(msg, args.slice(1))
        } else if (subcommand === 'verify') {
          await this.handleVerify(msg)
        } else if (subcommand === 'create') {
          await this.handleCreate(msg, args.slice(1))
        } else if (subcommand === 'get' || subcommand === 'query') {
          await this.handleGet(msg, args[1] || '')
        } else if (subcommand === 'search') {
          await this.handleSearch(msg, args.slice(1).join(' '))
        } else if (subcommand === 'list' || subcommand === 'ls') {
          await this.handleList(msg)
        } else if (subcommand === 'delete' || subcommand === 'del') {
          await this.handleDelete(msg, args.slice(1))
        } else if (/^https?:\/\//i.test(args[0]) || msg.replyTo) {
          await this.handleCreate(msg, args)
        } else {
          throw new Error(`未知命令，使用 ${commandName} help 查看帮助`)
        }
      } catch (error) {
        await msg.edit({
          text: `❌ ${htmlEscape(friendlyError(error))}`,
          parseMode: 'html',
          linkPreview: false
        })
      }
    }
  }
}

export default new SinkPlugin()
