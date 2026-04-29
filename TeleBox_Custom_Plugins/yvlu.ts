// YVLU Plugin - 生成文字语录贴纸 (TGS + 自定义文字 + API配置 完整版)
//@ts-nocheck
import axios from 'axios'
import _ from 'lodash'
import { getPrefixes } from '@utils/pluginManager'
import { Plugin } from '@utils/pluginBase'
import { Api } from 'telegram'
import { createDirectoryInAssets, createDirectoryInTemp } from '@utils/pathHelpers'
import * as path from 'path'
import * as fs from 'fs'
import { getGlobalClient } from '@utils/globalClient'
import { reviveEntities } from '@utils/tlRevive'
import { CustomFile } from 'telegram/client/uploads.js'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const timeout = 60000 // 超时

// ===================== 辅助函数区域 =====================

const hashCode = (s: any) => {
  const l = s.length
  let h = 0
  let i = 0
  if (l > 0) {
    while (i < l) {
      h = ((h << 5) - h + s.charCodeAt(i++)) | 0
    }
  }
  return h
}

// 检测是否为 webm 格式
function isWebmFormat(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 4) return false
  return buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3
}

// 检测是否为 TGS 格式 (gzip 压缩的 Lottie JSON)
function isTgsFormat(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 2) return false
  return buffer[0] === 0x1f && buffer[1] === 0x8b
}

// 检查 TGS 转换依赖
async function checkTgsDependencies(): Promise<{ ok: boolean; message: string }> {
  try {
    await execFileAsync('python3', ['-c', 'from rlottie_python import LottieAnimation'])
  } catch (e) {
    return {
      ok: false,
      message: '缺少 rlottie-python 依赖，请运行: pip3 install rlottie-python Pillow --break-system-packages'
    }
  }
  try {
    await execFileAsync('ffmpeg', ['-version'])
  } catch (e) {
    return {
      ok: false,
      message: '缺少 ffmpeg，请安装: apt-get install -y ffmpeg'
    }
  }
  return { ok: true, message: '' }
}

// TGS 转 WebM (使用 rlottie-python + ffmpeg)
async function convertTgsToWebm(tgsBuffer: Buffer): Promise<Buffer> {
  const os = await import('os')
  const tmpDir = os.tmpdir()
  const uniqueId = Date.now().toString() + '_' + Math.random().toString(36).slice(2)
  const tgsPath = path.join(tmpDir, `sticker_${uniqueId}.tgs`)
  const gifPath = path.join(tmpDir, `sticker_${uniqueId}.gif`)
  const webmPath = path.join(tmpDir, `sticker_${uniqueId}.webm`)

  try {
    fs.writeFileSync(tgsPath, tgsBuffer)

    const pythonScript = `
import sys
from rlottie_python import LottieAnimation
anim = LottieAnimation.from_tgs(sys.argv[1])
anim.save_animation(sys.argv[2])
`

    await execFileAsync('python3', ['-c', pythonScript, tgsPath, gifPath])

    await execFileAsync('ffmpeg', ['-i', gifPath, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '400k', '-auto-alt-ref', '0', '-an', '-y', webmPath])

    const webmBuffer = fs.readFileSync(webmPath)
    return webmBuffer
  } finally {
    try {
      fs.unlinkSync(tgsPath)
    } catch (e) {}
    try {
      fs.unlinkSync(gifPath)
    } catch (e) {}
    try {
      fs.unlinkSync(webmPath)
    } catch (e) {}
  }
}

// 检测是否为动态 WebP
function isAnimatedWebP(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 12) return false
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return false
  }
  for (let i = 12; i < buffer.length - 4; i++) {
    if (buffer.toString('ascii', i, i + 4) === 'ANIM') {
      return true
    }
  }
  return false
}

// 读取WebP图片尺寸
function getWebPDimensions(imageBuffer: any): { width: number; height: number } {
  try {
    if (isWebmFormat(imageBuffer)) return { width: 512, height: 512 }
    if (imageBuffer.length < 30) throw new Error('Too short')
    if (imageBuffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('No RIFF')
    if (imageBuffer.toString('ascii', 8, 12) !== 'WEBP') throw new Error('No WEBP')

    const chunkHeader = imageBuffer.toString('ascii', 12, 16)
    if (chunkHeader === 'VP8 ') {
      const width = imageBuffer.readUInt16LE(26) & 0x3fff
      const height = imageBuffer.readUInt16LE(28) & 0x3fff
      return { width, height }
    } else if (chunkHeader === 'VP8L') {
      const data = imageBuffer.readUInt32LE(21)
      const width = (data & 0x3fff) + 1
      const height = ((data >> 14) & 0x3fff) + 1
      return { width, height }
    } else if (chunkHeader === 'VP8X') {
      const width = (imageBuffer.readUInt32LE(24) & 0xffffff) + 1
      const height = (imageBuffer.readUInt32LE(27) & 0xffffff) + 1
      return { width, height }
    }
    return { width: 512, height: 768 }
  } catch (error) {
    return { width: 512, height: 768 }
  }
}

const getPeerNumericId = (peer?: Api.TypePeer): number | undefined => {
  if (!peer) return undefined
  if (peer instanceof Api.PeerUser) return peer.userId
  if (peer instanceof Api.PeerChat) return -peer.chatId
  if (peer instanceof Api.PeerChannel) return -peer.channelId
  return undefined
}

const resolveForwardSenderFromHeader = async (forwardHeader: Api.MessageFwdHeader, client: any) => {
  if (!forwardHeader) return undefined
  const peerCandidates = [forwardHeader.fromId, forwardHeader.savedFromPeer].filter(Boolean)
  for (const peer of peerCandidates) {
    try {
      const entity = await client?.getEntity(peer as any)
      if (entity) return entity
    } catch (error) {}
  }
  const displayName = forwardHeader.fromName || forwardHeader.postAuthor || ''
  if (displayName) {
    return {
      id: getPeerNumericId(forwardHeader.fromId) || hashCode(displayName),
      firstName: displayName,
      lastName: '',
      username: forwardHeader.postAuthor || undefined,
      title: displayName,
      name: displayName
    }
  }
  return undefined
}

const prefixes = getPrefixes()
const mainPrefix = prefixes[0]
const pluginName = 'yvlu'
const commandName = `${mainPrefix}${pluginName}`

const help_text = `
<b>🎨 YVLU 语录生成器 (TGS完整版)</b>

<b>1. 生成语录</b>
• <code>${commandName} [数量]</code> - 回复消息，生成最近N条
• <code>${commandName} r [数量]</code> - 包含被引用(Reply)的消息
• <code>${commandName} <自定义文字></code> - <b>修改内容</b>为自定义文字生成

<b>2. 贴纸包管理</b>
• <code>${commandName} s</code> - 回复图片/贴纸，保存到你的贴纸包
• <code>${commandName} config sticker <名称></code> - 设置贴纸包ShortName

<b>3. API 设置</b>
• <code>${commandName} api [URL]</code> - 设置自定义API
• <code>${commandName} api reset</code> - 重置API
`

function convertEntities(entities: Api.TypeMessageEntity[]): any[] {
  if (!entities) return []
  return entities.map((entity) => {
    const baseEntity = { offset: entity.offset, length: entity.length }
    if (entity instanceof Api.MessageEntityBold) return { ...baseEntity, type: 'bold' }
    if (entity instanceof Api.MessageEntityItalic) return { ...baseEntity, type: 'italic' }
    if (entity instanceof Api.MessageEntityUnderline) return { ...baseEntity, type: 'underline' }
    if (entity instanceof Api.MessageEntityStrike) return { ...baseEntity, type: 'strikethrough' }
    if (entity instanceof Api.MessageEntityCode) return { ...baseEntity, type: 'code' }
    if (entity instanceof Api.MessageEntityPre) return { ...baseEntity, type: 'pre' }
    if (entity instanceof Api.MessageEntityCustomEmoji) {
      const documentId = (entity as any).documentId
      const custom_emoji_id = documentId?.value?.toString() || documentId?.toString() || ''
      return { ...baseEntity, type: 'custom_emoji', custom_emoji_id }
    }
    if (entity instanceof Api.MessageEntityUrl) return { ...baseEntity, type: 'url' }
    if (entity instanceof Api.MessageEntityTextUrl) return { ...baseEntity, type: 'text_link', url: (entity as any).url || '' }
    if (entity instanceof Api.MessageEntityMention) return { ...baseEntity, type: 'mention' }
    return baseEntity
  })
}

// ===================== 类定义区域 =====================

interface YvluConfig {
  stickerSetShortName: string
  apiUrl: string
  _comment?: string
}

const DEFAULT_API_URL = JSON.parse(Buffer.from('eyJ1cmwiOiJodHRwczovL3F1b3RlLWFwaS1lbmhhbmNlZC56aGV0ZW5nc2hhLmV1Lm9yZy9nZW5lcmF0ZS53ZWJwIn0=', 'base64').toString('utf-8')).url

class YvluPlugin extends Plugin {
  description: string = `\n生成文字语录贴纸\n\n${help_text}`
  private config: YvluConfig | null = null
  private configPath: string = ''

  async onLoad() {
    const configDir = createDirectoryInAssets('yvlu')
    this.configPath = path.join(configDir, 'config.json')
    if (!fs.existsSync(this.configPath)) {
      const defaultConfig: YvluConfig = {
        stickerSetShortName: '',
        apiUrl: '',
        _comment: 'shortName 只能包含字母、数字和下划线; apiUrl为空时使用默认'
      }
      fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8')
    }
    await this.loadConfig()
  }

  async loadConfig() {
    try {
      if (!this.configPath) {
        const configDir = createDirectoryInAssets('yvlu')
        this.configPath = path.join(configDir, 'config.json')
      }
      if (fs.existsSync(this.configPath)) {
        const configData = fs.readFileSync(this.configPath, 'utf-8')
        this.config = JSON.parse(configData)
      } else {
        this.config = { stickerSetShortName: '', apiUrl: '' }
      }
    } catch (error) {
      console.error('加载配置失败:', error)
      this.config = { stickerSetShortName: '', apiUrl: '' }
    }
  }

  async saveConfig() {
    if (this.config && this.configPath) {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8')
    }
  }

  // 生成语录
  async generateQuote(quoteData: any): Promise<{ buffer: Buffer; ext: string }> {
    try {
      let url = this.config?.apiUrl
      if (!url || !url.trim()) url = DEFAULT_API_URL

      const response = await axios({
        method: 'post',
        timeout,
        url: url,
        data: quoteData,
        responseType: 'arraybuffer',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'TeleBox/0.2.1'
        }
      })

      console.log('quote-api响应状态:', response.status)
      return { buffer: response.data, ext: 'webp' }
    } catch (error) {
      console.error(`调用quote-api失败: ${error}`)
      throw error
    }
  }

  cmdHandlers: Record<string, (msg: Api.Message, trigger?: Api.Message) => Promise<void>> = {
    yvlu: async (msg: Api.Message, trigger?: Api.Message) => {
      const start = Date.now()
      const args = msg.message.split(/\s+/)
      const subCmd = args[1]?.toLowerCase()

      // 1. 配置管理
      if (subCmd === 'config') {
        await this.handleConfigCommand(msg, args.slice(2))
        return
      }

      // 2. API 管理
      if (subCmd === 'api') {
        await this.handleApiCommand(msg, args.slice(2))
        return
      }

      // 3. 保存贴纸
      if (subCmd === 's') {
        await this.handleSaveStickerToSet(msg)
        return
      }

      let count = 1
      let r = false
      let valid = false
      let customText: string | undefined

      // 4. 解析参数 (Quote)
      if (!args[1] || /^\d+$/.test(args[1])) {
        // yvlu 或 yvlu 3
        count = parseInt(args[1]) || 1
        valid = true
      } else if (args[1] === 'r') {
        // yvlu r 3
        r = true
        count = parseInt(args[2]) || 1
        valid = true
      } else {
        // yvlu 这里是自定义文字
        // 移除命令头部，保留后面所有文字
        customText = msg.message.replace(/^\S+\s+/, '')
        valid = true
      }

      if (valid) {
        let replied = await msg.getReplyMessage()
        if (!replied) {
          await msg.edit({ text: '请回复一条消息' })
          return
        }
        if (count > 5) {
          await msg.edit({ text: '太多了 哒咩' })
          return
        }

        await msg.edit({ text: '正在生成语录贴纸...' })

        try {
          const client = await getGlobalClient()
          const messages = await msg.client?.getMessages(replied?.peerId, {
            offsetId: replied!.id - 1,
            limit: count,
            reverse: true
          })

          if (!messages || messages.length === 0) {
            await msg.edit({ text: '未找到消息' })
            return
          }

          const items = [] as any[]
          let previousUserIdentifier: string | null = null

          for await (const [i, message] of messages.entries()) {
            let sender: any = await message.getSender()
            // 尝试补救发送者信息
            if (!sender) {
              try {
                const peerId = (message as any).peerId || (message as any).fromId
                if (peerId) sender = await client.getEntity(peerId)
              } catch (e) {}
            }
            if (message.fwdFrom) {
              let forwardedSender = undefined
              try {
                forwardedSender = await message.forward?.getSender()
              } catch (e) {}
              if (!forwardedSender) forwardedSender = await resolveForwardSenderFromHeader(message.fwdFrom, client)
              if (forwardedSender) sender = forwardedSender
            }
            if (!sender) {
              await msg.edit({ text: '无法获取消息发送者信息' })
              return
            }

            // 用户数据
            const userId = (sender as any).id?.toString()
            const name = (sender as any).name || ''
            const firstName = (sender as any).firstName || (sender as any).title || ''
            const lastName = (sender as any).lastName || ''
            const username = (sender as any).username || ''
            const emojiStatus = (sender as any).emojiStatus?.documentId?.toString() || null

            const currentUserIdentifier = userId || hashCode(name || `${firstName}|${lastName}` || `user_${i}`).toString()
            const shouldShowAvatar = currentUserIdentifier !== previousUserIdentifier
            previousUserIdentifier = currentUserIdentifier

            let photo: { url: string } | undefined = undefined
            if (shouldShowAvatar) {
              try {
                const buffer = await client.downloadProfilePhoto(sender as any, { isBig: false })
                if (Buffer.isBuffer(buffer) && buffer.length > 0) {
                  photo = { url: `data:image/jpeg;base64,${buffer.toString('base64')}` }
                }
              } catch (e) {}
            }

            // [自定义文字逻辑]
            if (i === 0) {
              let replyTo = (trigger || msg)?.replyTo
              if (customText) {
                // 如果有自定义文字，替换当前消息内容
                message.message = customText
                message.entities = []
              } else if (replyTo?.quoteText) {
                message.message = replyTo.quoteText
                message.entities = replyTo.quoteEntities
              }
            }

            const entities = convertEntities(message.entities || [])

            // [回复引用逻辑]
            let replyBlock: any | undefined
            if (r) {
              try {
                const replyHeader: any = (message as any).replyTo
                if (replyHeader?.quote && replyHeader.quoteText) {
                  const revived = reviveEntities(replyHeader.quoteEntities)
                  replyBlock = {
                    name: 'Reply',
                    text: replyHeader.quoteText,
                    entities: convertEntities(revived || [])
                  }
                } else if ((message as any).isReply || replyHeader?.replyToMsgId) {
                  const repliedMsg = await message.getReplyMessage()
                  if (repliedMsg) {
                    const rSender = await repliedMsg.getSender()
                    const rName = rSender ? (rSender as any).firstName || (rSender as any).title || 'Unknown' : 'Unknown'
                    replyBlock = {
                      name: rName,
                      text: repliedMsg.message || '',
                      entities: convertEntities(repliedMsg.entities || [])
                    }
                  }
                }
              } catch (e) {}
            }

            // [媒体处理逻辑 - 集成 TGS 支持]
            let media: { url: string } | undefined = undefined
            try {
              if (message.media) {
                const isSticker = message.media instanceof Api.MessageMediaDocument && (message.media as Api.MessageMediaDocument).document && ((message.media as Api.MessageMediaDocument).document as any).attributes?.some((a: any) => a instanceof Api.DocumentAttributeSticker)
                const mediaTypeForQuote = isSticker ? 'sticker' : 'photo'
                const mimeType = (message.media as any).document?.mimeType

                // 识别
                const isTgsSticker = isSticker && mimeType === 'application/x-tgsticker'
                const isAnimatedSticker = isSticker && (mimeType === 'video/webm' || mimeType === 'image/webp' || isTgsSticker)

                const buffer = await (message as any).downloadMedia({
                  ...(isAnimatedSticker ? {} : { thumb: 1 })
                })

                if (Buffer.isBuffer(buffer)) {
                  let finalBuffer = buffer
                  let finalMime = mimeType

                  // TGS 转换
                  if (isTgsSticker || isTgsFormat(buffer)) {
                    const depCheck = await checkTgsDependencies()
                    if (!depCheck.ok) {
                      console.error(`[yvlu] ${depCheck.message}`)
                    } else {
                      try {
                        finalBuffer = await convertTgsToWebm(buffer)
                        finalMime = 'video/webm'
                        console.log(`[yvlu] TGS -> WebM 成功`)
                      } catch (err) {
                        console.error(`[yvlu] TGS 转换失败:`, err)
                      }
                    }
                  }

                  const mime = finalMime || (mediaTypeForQuote === 'sticker' ? 'image/webp' : 'image/jpeg')
                  media = { url: `data:${mime};base64,${finalBuffer.toString('base64')}` }
                }
              }
            } catch (e) {
              console.error('下载媒体失败', e)
            }

            items.push({
              from: {
                id: userId ? parseInt(userId) : hashCode(sender.name),
                name: shouldShowAvatar ? name : '',
                first_name: shouldShowAvatar ? firstName : undefined,
                last_name: shouldShowAvatar ? lastName : undefined,
                username: photo && shouldShowAvatar ? username : undefined,
                photo,
                emoji_status: shouldShowAvatar ? emojiStatus : undefined
              },
              text: message.message || '',
              entities: entities,
              avatar: shouldShowAvatar,
              media,
              ...(replyBlock ? { replyMessage: replyBlock } : {})
            })
          }

          // 发送请求
          const quoteData = {
            type: 'quote',
            format: 'webp',
            backgroundColor: '#1b1429',
            width: 512,
            height: 768,
            scale: 2,
            emojiBrand: 'apple',
            messages: items
          }
          const quoteResult = await this.generateQuote(quoteData)
          const imageBuffer = quoteResult.buffer
          const imageExt = quoteResult.ext

          if (!imageBuffer || imageBuffer.length === 0) {
            await msg.edit({ text: '生成的图片数据为空' })
            return
          }

          // 发送结果
          try {
            const dimensions = getWebPDimensions(imageBuffer)
            const isWebm = isWebmFormat(imageBuffer)

            if (isWebm) {
              const os = await import('os')
              const tmpDir = os.tmpdir()
              const uniqueId = Date.now().toString()
              const webmPath = path.join(tmpDir, `sticker_${uniqueId}.webm`)
              try {
                fs.writeFileSync(webmPath, imageBuffer)
                await client.sendFile(msg.peerId, {
                  file: webmPath,
                  attributes: [new Api.DocumentAttributeSticker({ alt: '📝', stickerset: new Api.InputStickerSetEmpty() })],
                  replyTo: replied?.id
                })
              } finally {
                try {
                  fs.unlinkSync(webmPath)
                } catch (e) {}
              }
            } else {
              const file = new CustomFile(`sticker.${imageExt}`, imageBuffer.length, '', imageBuffer)
              await client.sendFile(msg.peerId, {
                file,
                forceDocument: false,
                attributes: [new Api.DocumentAttributeSticker({ alt: '📝', stickerset: new Api.InputStickerSetEmpty() }), new Api.DocumentAttributeImageSize({ w: dimensions.width, h: dimensions.height }), new Api.DocumentAttributeFilename({ fileName: `sticker.${imageExt}` })],
                replyTo: replied?.id
              })
            }
          } catch (fileError) {
            console.error(`发送文件失败: ${fileError}`)
            await msg.edit({ text: `发送文件失败: ${fileError}` })
            return
          }

          await msg.delete()
          console.log(`语录生成耗时: ${Date.now() - start}ms`)
        } catch (error) {
          console.error(`语录生成失败: ${error}`)
          await msg.edit({ text: `语录生成失败: ${error}` })
        }
      } else {
        await msg.edit({ text: help_text, parseMode: 'html' })
      }
    }
  }

  async handleConfigCommand(msg: Api.Message, args: string[]) {
    await this.loadConfig()
    const sub = args[0]?.toLowerCase()

    if (sub === 'sticker' || sub === 'set') {
      const newName = args.slice(1).join('_')
      if (!newName || !/^[a-zA-Z0-9_]+$/.test(newName)) {
        await msg.edit({ text: '❌ 名称非法 (仅限字母数字下划线)' })
        return
      }
      this.config!.stickerSetShortName = newName
      await this.saveConfig()
      await msg.edit({ text: `✅ 贴纸包已设为: <code>${newName}</code>`, parseMode: 'html' })
    } else {
      await msg.edit({
        text: `<b>当前配置:</b>\n贴纸包: ${this.config?.stickerSetShortName || '未设置'}\nAPI: ${this.config?.apiUrl || '默认'}\n\n使用 <code>${commandName} config sticker [name]</code> 修改`,
        parseMode: 'html'
      })
    }
  }

  async handleApiCommand(msg: Api.Message, args: string[]) {
    await this.loadConfig()
    const sub = args[0]
    if (!sub) {
      await msg.edit({ text: `当前API: <code>${this.config?.apiUrl || '默认'}</code>`, parseMode: 'html' })
    } else if (sub === 'reset') {
      this.config!.apiUrl = ''
      await this.saveConfig()
      await msg.edit({ text: '✅ API已重置为默认' })
    } else {
      let url = sub
      if (!url.startsWith('http')) url = 'https://' + url
      if (!url.includes('/generate')) url = url.replace(/\/$/, '') + '/generate.webp'
      this.config!.apiUrl = url
      await this.saveConfig()
      await msg.edit({ text: `✅ API已设为: <code>${url}</code>`, parseMode: 'html' })
    }
  }

  async handleSaveStickerToSet(msg: Api.Message) {
    try {
      await this.loadConfig()
      if (!this.config?.stickerSetShortName) {
        await msg.edit({ text: `❌ 未配置贴纸包!\n请先设置: ${commandName} config sticker <名称>` })
        return
      }

      const replied = await msg.getReplyMessage()
      if (!replied || !replied.media) {
        await msg.edit({ text: '❌ 请回复一张贴纸或图片' })
        return
      }

      const client = await getGlobalClient()
      let isSticker = false
      let isPhoto = false
      let documentToAdd: Api.InputDocument | null = null

      if (replied.media instanceof Api.MessageMediaDocument) {
        const doc = replied.media.document as any
        if (doc && doc.attributes) {
          isSticker = doc.attributes.some((a: any) => a instanceof Api.DocumentAttributeSticker)
        }
        if (isSticker && doc.id && doc.accessHash) {
          documentToAdd = new Api.InputDocument({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference || Buffer.from([])
          })
        }
      } else if (replied.media instanceof Api.MessageMediaPhoto) {
        isPhoto = true
      }

      if (!isSticker && !isPhoto) {
        await msg.edit({ text: '❌ 不支持的媒体类型' })
        return
      }

      // 检查贴纸包
      let stickerSetExists = false
      try {
        const stickerSet = await client.invoke(
          new Api.messages.GetStickerSet({
            stickerset: new Api.InputStickerSetShortName({ shortName: this.config.stickerSetShortName }),
            hash: 0
          })
        )
        stickerSetExists = stickerSet instanceof Api.messages.StickerSet
      } catch (error: any) {
        if (error.errorMessage !== 'STICKERSET_INVALID') throw error
      }

      if (!stickerSetExists) {
        await this.createStickerSet(client, msg, replied, isSticker, isPhoto)
        return
      }

      // 添加贴纸
      if (isSticker && documentToAdd) {
        await client.invoke(
          new Api.stickers.AddStickerToSet({
            stickerset: new Api.InputStickerSetShortName({ shortName: this.config.stickerSetShortName }),
            sticker: new Api.InputStickerSetItem({ document: documentToAdd, emoji: '📝' })
          })
        )
      } else if (isPhoto) {
        const buffer = await replied.downloadMedia()
        if (!Buffer.isBuffer(buffer)) {
          await msg.edit({ text: '❌ 下载图片失败' })
          return
        }
        const file = await client.uploadFile({
          file: new CustomFile('sticker.png', buffer.length, '', buffer),
          workers: 1
        })
        await client.invoke(
          new Api.stickers.AddStickerToSet({
            stickerset: new Api.InputStickerSetShortName({ shortName: this.config.stickerSetShortName }),
            sticker: new Api.InputStickerSetItem({ document: file as any, emoji: '📝' })
          })
        )
      }

      await msg.edit({ text: `✅ 已成功保存到贴纸包!\nt.me/addstickers/${this.config.stickerSetShortName}` })
    } catch (error: any) {
      console.error('保存失败:', error)
      await msg.edit({ text: `❌ 保存失败: ${error.message || error}` })
    }
  }

  async createStickerSet(client: any, msg: Api.Message, replied: Api.Message, isSticker: boolean, isPhoto: boolean) {
    try {
      let firstSticker: any = null
      if (isSticker && replied.media instanceof Api.MessageMediaDocument) {
        const doc = replied.media.document as any
        firstSticker = new Api.InputDocument({
          id: doc.id,
          accessHash: doc.accessHash,
          fileReference: doc.fileReference || Buffer.from([])
        })
      } else if (isPhoto) {
        const buffer = await replied.downloadMedia()
        firstSticker = await client.uploadFile({
          file: new CustomFile('sticker.png', buffer.length!, '', buffer!),
          workers: 1
        })
      }

      if (!firstSticker) throw new Error('无法准备贴纸数据')

      const me = await client.getMe()
      await client.invoke(
        new Api.stickers.CreateStickerSet({
          userId: me,
          title: this.config!.stickerSetShortName,
          shortName: this.config!.stickerSetShortName,
          stickers: [new Api.InputStickerSetItem({ document: firstSticker, emoji: '📝' })]
        })
      )

      await msg.edit({ text: `✅ 已创建并保存!\nt.me/addstickers/${this.config!.stickerSetShortName}` })
    } catch (error: any) {
      console.error('创建失败:', error)
      await msg.edit({ text: `❌ 创建失败: ${error.message || error}` })
    }
  }
}

export default new YvluPlugin()
